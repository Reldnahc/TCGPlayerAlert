import { SellerOrderStatus } from "tcgplayer-private-api";
import type { Logger } from "../logger.js";
import type { ManagedOrderDetail } from "../order-management.js";
import type { ReadyOrderSource } from "../ready-orders.js";
import { safeErrorCode } from "../errors.js";
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

interface NotificationOrderSource {
  getOrder(
    orderNumber: string,
    options?: { readonly force?: boolean; readonly signal?: AbortSignal },
  ): Promise<Pick<ManagedOrderDetail, "status" | "statusCode">>;
}

export interface NotificationMonitorOptions {
  readonly settings: () =>
    DiscordNotificationSettings | Promise<DiscordNotificationSettings>;
  readonly publisher: NotificationPublisher;
  readonly state: JsonNotificationStateStore;
  readonly messages: NotificationMessageSource;
  readonly orders: NotificationOrderSource;
  readonly readyOrders: ReadyOrderSource;
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
      await this.observeCanceledOrders(signal).catch((error: unknown) =>
        this.logFailure("order-canceled", error),
      );
    }
    if (settings.events.inboundMessage) {
      await this.observeMessages(signal).catch((error: unknown) =>
        this.logFailure("inbound-message", error),
      );
    }
  }

  private async observeCanceledOrders(signal?: AbortSignal): Promise<void> {
    const snapshot = this.options.readyOrders.snapshot();
    if (snapshot === undefined) return;
    const current = new Set(snapshot.orders.map((order) => order.orderNumber));
    const previous = await this.options.state.readReadyOrderNumbers();
    if (previous === undefined) {
      await this.options.state.writeReadyOrderNumbers([...current]);
      return;
    }
    const unresolved = new Set(current);
    for (const orderNumber of previous) {
      if (current.has(orderNumber)) continue;
      try {
        const order = await this.options.orders.getOrder(orderNumber, {
          force: true,
          ...(signal === undefined ? {} : { signal }),
        });
        if (isCanceled(order.statusCode)) {
          const occurredAt = this.now().toISOString();
          await this.options.publisher.publish(
            {
              type: "order-canceled",
              idempotencyKey: `order-canceled:${orderNumber}:${order.statusCode}`,
              occurredAt,
              orderNumber,
              providerStatus: order.status,
            },
            signal,
          );
        }
      } catch (error) {
        unresolved.add(orderNumber);
        this.logFailure("order-canceled", error);
      }
    }
    await this.options.state.writeReadyOrderNumbers([...unresolved]);
  }

  private async observeMessages(signal?: AbortSignal): Promise<void> {
    const first = await this.options.messages.list({
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
      const next = await this.options.messages.list({
        page,
        ...(signal === undefined ? {} : { signal }),
      });
      pages.push(next);
      observedUnreadMessages += next.threads.reduce(
        (total, thread) => total + thread.unreadMessageCount,
        0,
      );
    }
    const previous = await this.options.state.readMessages();
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
          idempotencyKey: `inbound-message:${key}:${fingerprint}`,
          occurredAt: observedAt,
          threadId: thread.threadId,
          unreadMessageCount: thread.unreadMessageCount,
        },
        signal,
      );
    }
    await this.options.state.mergeMessages(current);
  }

  private logFailure(type: string, error: unknown): void {
    this.options.logger.error("notification.monitor-failed", {
      type,
      errorCode: safeErrorCode(error),
    });
  }
}

function isCanceled(status: string): boolean {
  return (
    status === SellerOrderStatus.Canceled ||
    status === SellerOrderStatus.PickupOrderCanceled ||
    status === SellerOrderStatus.ShippedOrderCanceled
  );
}
