import { safeErrorCode } from "../errors.js";
import type { Logger } from "../logger.js";
import { parseOrderDetail } from "../marketplaces/contracts.js";
import {
  orderRefKey,
  type ProviderOrderRef,
} from "../marketplaces/identity.js";
import type { MarketplaceConnectionRegistry } from "../marketplaces/registry.js";
import type { QualifiedReadyOrderSource } from "../shipment-scanner.js";
import type {
  DiscordNotificationSettings,
  NotificationPublisher,
} from "./contracts.js";
import type { JsonNotificationStateStore } from "./state.js";

interface NotificationMessageSource {
  list(input?: {
    readonly page?: number;
    readonly force?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly totalPages: number;
    readonly unreadCount: number;
    readonly threads: readonly {
      readonly threadId: number;
      readonly totalMessageCount: number;
      readonly unreadMessageCount: number;
    }[];
  }>;
}

export interface NotificationMonitorOptions {
  readonly settings: () =>
    DiscordNotificationSettings | Promise<DiscordNotificationSettings>;
  readonly publisher: NotificationPublisher;
  readonly state: JsonNotificationStateStore;
  readonly registry: MarketplaceConnectionRegistry;
  readonly readyOrders: QualifiedReadyOrderSource;
  readonly messages?: NotificationMessageSource;
  readonly messageConnectionId?: string;
  readonly logger: Logger;
  readonly now?: () => Date;
}

export class NotificationMonitor {
  private readonly now: () => Date;
  private active: Promise<void> | undefined;

  constructor(private readonly options: NotificationMonitorOptions) {
    this.now = options.now ?? (() => new Date());
  }

  run(signal?: AbortSignal): Promise<void> {
    if (this.active !== undefined) return this.active;
    const operation = this.execute(signal);
    this.active = operation;
    const clear = () => {
      if (this.active === operation) this.active = undefined;
    };
    void operation.then(clear, clear);
    return operation;
  }

  private async execute(signal?: AbortSignal): Promise<void> {
    const settings = await this.options.settings();
    if (!settings.enabled) return;
    if (settings.events.orderCanceled) {
      await this.observeCanceledOrders(signal).catch((error: unknown) => {
        signal?.throwIfAborted();
        this.logFailure("order-canceled", error);
      });
    }
    if (
      settings.events.inboundMessage &&
      this.options.messages !== undefined &&
      this.options.messageConnectionId !== undefined
    ) {
      await this.observeMessages(
        this.options.messages,
        this.options.messageConnectionId,
        signal,
      ).catch((error: unknown) => {
        signal?.throwIfAborted();
        this.logFailure("inbound-message", error);
      });
    }
  }

  private async observeCanceledOrders(signal?: AbortSignal): Promise<void> {
    const snapshot = this.options.readyOrders.snapshot();
    if (snapshot === undefined) return;
    const current = new Map(
      snapshot.orders.map((order) => [orderRefKey(order.ref), order.ref]),
    );
    const previous = await this.options.state.readReadyOrderRefs();
    if (previous === undefined) {
      await this.options.state.writeReadyOrderRefs([...current.values()]);
      return;
    }
    const completed = new Set(snapshot.successfulConnectionIds);
    const unresolved = new Map(current);
    for (const ref of previous) {
      const key = orderRefKey(ref);
      if (current.has(key)) continue;
      if (!completed.has(ref.connectionId)) {
        unresolved.set(key, ref);
        continue;
      }
      try {
        const connection = this.options.registry.get(ref.connectionId);
        if (connection?.facets.orderDetails === undefined) {
          unresolved.set(key, ref);
          continue;
        }
        const order = parseOrderDetail(
          await connection.facets.orderDetails.getOrder(ref, signal),
        );
        if (order.lifecycle === "canceled") {
          const occurredAt = this.now().toISOString();
          await this.options.publisher.publish(
            {
              type: "order-canceled",
              idempotencyKey: `order-canceled:${key}:${order.providerStatusCode ?? order.providerStatus}`,
              occurredAt,
              ref,
              displayOrderNumber: order.displayOrderNumber,
              connectionId: ref.connectionId,
              connectionLabel: connection.descriptor.connectionLabel,
              providerStatus: order.providerStatus,
            },
            signal,
          );
        }
      } catch (error) {
        signal?.throwIfAborted();
        unresolved.set(key, ref);
        this.logFailure("order-canceled", error);
      }
    }
    await this.options.state.writeReadyOrderRefs([...unresolved.values()]);
  }

  private async observeMessages(
    messages: NotificationMessageSource,
    connectionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const connection = this.options.registry.get(connectionId);
    if (connection === undefined) return;
    const first = await messages.list({
      page: 1,
      force: true,
      ...(signal === undefined ? {} : { signal }),
    });
    const pages = [first];
    let observedUnreadMessages = first.threads.reduce(
      (total, thread) => total + thread.unreadMessageCount,
      0,
    );
    for (
      let page = 2;
      observedUnreadMessages < first.unreadCount && page <= first.totalPages;
      page += 1
    ) {
      const next = await messages.list({
        page,
        ...(signal === undefined ? {} : { signal }),
      });
      pages.push(next);
      observedUnreadMessages += next.threads.reduce(
        (total, thread) => total + thread.unreadMessageCount,
        0,
      );
    }
    const previous = await this.options.state.readMessages(connectionId);
    const observedAt = this.now().toISOString();
    const current: Record<
      string,
      { readonly fingerprint: string; readonly observedAt: string }
    > = {};
    for (const thread of pages.flatMap((page) => page.threads)) {
      if (thread.unreadMessageCount < 1) continue;
      const key = String(thread.threadId);
      const fingerprint = `${String(thread.totalMessageCount)}:${String(thread.unreadMessageCount)}`;
      current[key] = { fingerprint, observedAt };
      if (
        previous === undefined ||
        previous[key]?.fingerprint === fingerprint
      ) {
        continue;
      }
      await this.options.publisher.publish(
        {
          type: "inbound-message",
          idempotencyKey: `inbound-message:${connectionId}:${key}:${fingerprint}`,
          occurredAt: observedAt,
          connectionId,
          connectionLabel: connection.descriptor.connectionLabel,
          threadId: thread.threadId,
          unreadMessageCount: thread.unreadMessageCount,
        },
        signal,
      );
    }
    await this.options.state.mergeMessages(connectionId, current);
  }

  private logFailure(type: string, error: unknown): void {
    this.options.logger.error("notification.monitor-failed", {
      type,
      errorCode: safeErrorCode(error),
    });
  }
}

export function notificationOrderRef(event: {
  readonly ref: ProviderOrderRef;
}): string {
  return orderRefKey(event.ref);
}
