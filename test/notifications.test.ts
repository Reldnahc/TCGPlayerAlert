import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../src/logger.js";
import {
  MarketplaceConnectionRegistry,
  ProviderAdapterRegistry,
  environmentSecretAccess,
  type OrderDetail,
  type OrderSummary,
  type ProviderOrderRef,
  type QualifiedReadyOrderSnapshot,
} from "../src/index.js";
import {
  JsonNotificationStateStore,
  NotificationMonitor,
  NotificationService,
  type DiscordNotificationSettings,
  type NotificationEvent,
  type NotificationPublisher,
  type NotificationSink,
} from "../src/notifications/index.js";
import {
  syntheticFactory,
  syntheticNormalizedOrder,
} from "./synthetic-marketplace.js";

const connectionId = "synthetic-main";
const ref: ProviderOrderRef = {
  connectionId,
  remoteId: "synthetic-order-1",
};
const settings: DiscordNotificationSettings = {
  enabled: true,
  webhookUrlEnv: "SYNTHETIC_DISCORD_WEBHOOK",
  events: {
    authenticationRequired: true,
    inboundMessage: true,
    orderCanceled: true,
    shipmentMarkAttempt: true,
  },
};
const logger: Logger = { info: vi.fn(), error: vi.fn() };

async function state(): Promise<JsonNotificationStateStore> {
  const directory = await mkdtemp(join(tmpdir(), "tcgplayer-alert-notify-"));
  return new JsonNotificationStateStore(join(directory, "notifications.json"));
}

function connectionEvent(): Pick<
  NotificationEvent,
  "connectionId" | "connectionLabel"
> {
  return { connectionId, connectionLabel: "Synthetic store" };
}

describe("NotificationService", () => {
  it("delivers each idempotency key once", async () => {
    const send = vi.fn<NotificationSink["send"]>(() => Promise.resolve());
    const service = new NotificationService({
      settings: () => settings,
      sink: { isConfigured: () => true, send },
      state: await state(),
      logger,
    });
    const event: NotificationEvent = {
      type: "authentication-required",
      idempotencyKey: "authentication-required:2026-08-10T12:00:00.000Z",
      occurredAt: "2026-08-10T12:00:00.000Z",
      ...connectionEvent(),
    };

    await service.publish(event);
    await service.publish(event);

    expect(send).toHaveBeenCalledOnce();
  });

  it("does not claim an event while the webhook is unconfigured", async () => {
    let configured = false;
    const send = vi.fn<NotificationSink["send"]>(() => Promise.resolve());
    const service = new NotificationService({
      settings: () => settings,
      sink: { isConfigured: () => configured, send },
      state: await state(),
      logger,
    });
    const event: NotificationEvent = {
      type: "authentication-required",
      idempotencyKey: "authentication-required:later",
      occurredAt: "2026-08-10T12:00:00.000Z",
      ...connectionEvent(),
    };

    await service.publish(event);
    configured = true;
    await service.publish(event);

    expect(send).toHaveBeenCalledOnce();
  });

  it("removes only the qualified successful shipment when delivery is disabled", async () => {
    const notificationState = await state();
    const sameRemoteOtherConnection = {
      connectionId: "other-main",
      remoteId: ref.remoteId,
    } as const;
    await notificationState.writeReadyOrderRefs([
      ref,
      sameRemoteOtherConnection,
    ]);
    const service = new NotificationService({
      settings: () => ({ ...settings, enabled: false }),
      sink: { isConfigured: () => false, send: () => Promise.resolve() },
      state: notificationState,
      logger,
    });

    await service.publish({
      type: "shipment-mark-attempt",
      idempotencyKey: "shipment-mark-attempt:successful",
      occurredAt: "2026-08-10T12:00:00.000Z",
      ref,
      displayOrderNumber: "SYN-1",
      ...connectionEvent(),
      outcome: "applied",
    });

    await expect(notificationState.readReadyOrderRefs()).resolves.toEqual([
      sameRemoteOtherConnection,
    ]);
  });
});

describe("NotificationMonitor", () => {
  it("baselines qualified data, then reports new messages and confirmed cancellations once", async () => {
    const readyOrder: OrderSummary = {
      ...syntheticNormalizedOrder({
        connectionId,
        remoteId: ref.remoteId,
        displayOrderNumber: "SYN-1",
      }),
      buyerName: "not transmitted",
    };
    let currentOrders: readonly OrderSummary[] = [readyOrder];
    let totalMessageCount = 1;
    let unreadMessageCount = 1;
    const provider = syntheticFactory("synthetic", "Synthetic", {
      detail: canceledDetail(readyOrder),
    });
    const registry = connectionRegistry(provider.factory);
    const publish = vi.fn<NotificationPublisher["publish"]>(() =>
      Promise.resolve(),
    );
    const snapshot = (): QualifiedReadyOrderSnapshot => ({
      orders: currentOrders,
      successfulConnectionIds: [connectionId],
      issues: [],
      fetchedAt: "2026-08-10T12:00:00.000Z",
    });
    const monitor = new NotificationMonitor({
      settings: () => settings,
      publisher: { publish },
      state: await state(),
      registry,
      messages: {
        list: () =>
          Promise.resolve({
            totalPages: 1,
            unreadCount: unreadMessageCount,
            threads: [
              {
                threadId: 7,
                totalMessageCount,
                unreadMessageCount,
              },
            ],
          }),
      },
      messageConnectionId: connectionId,
      readyOrders: {
        snapshot,
        refresh: () => Promise.resolve(snapshot()),
        remove: () => undefined,
      },
      logger,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    });

    await monitor.run();
    expect(publish).not.toHaveBeenCalled();

    currentOrders = [];
    totalMessageCount = 2;
    unreadMessageCount = 2;
    await monitor.run();
    await monitor.run();

    expect(provider.observation.detailRemoteIds).toEqual([ref.remoteId]);
    expect(publish.mock.calls.map(([event]) => event.type).sort()).toEqual([
      "inbound-message",
      "order-canceled",
    ]);
    for (const [event] of publish.mock.calls) {
      expect(event.connectionId).toBe(connectionId);
      expect(event).not.toHaveProperty("buyerName");
      expect(event.idempotencyKey).toContain(connectionId);
    }
  });

  it("does not infer cancellation for a connection omitted by a partial refresh", async () => {
    const provider = syntheticFactory("synthetic", "Synthetic", {
      detail: canceledDetail(
        syntheticNormalizedOrder({
          connectionId,
          remoteId: ref.remoteId,
        }),
      ),
    });
    const registry = connectionRegistry(provider.factory);
    const notificationState = await state();
    await notificationState.writeReadyOrderRefs([ref]);
    const publish = vi.fn<NotificationPublisher["publish"]>(() =>
      Promise.resolve(),
    );
    const monitor = new NotificationMonitor({
      settings: () => settings,
      publisher: { publish },
      state: notificationState,
      registry,
      readyOrders: {
        snapshot: () => ({
          orders: [],
          successfulConnectionIds: [],
          issues: [],
          fetchedAt: "2026-08-10T12:00:00.000Z",
        }),
        refresh: () => Promise.reject(new Error("not used")),
        remove: () => undefined,
      },
      logger,
    });

    await monitor.run();

    expect(provider.observation.detailRemoteIds).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
    await expect(notificationState.readReadyOrderRefs()).resolves.toEqual([
      ref,
    ]);
  });
});

function canceledDetail(order: OrderSummary): OrderDetail {
  return {
    ...order,
    providerStatus: "Canceled",
    providerStatusCode: "CANCELED",
    lifecycle: "canceled",
    shippingAddress: {
      recipientName: "Not transmitted",
      addressOne: "1 Private Street",
      city: "Private",
      territory: "IL",
      country: "US",
      postalCode: "00000",
    },
    lines: [],
    trackingNumbers: [],
  };
}

function connectionRegistry(
  factory: ReturnType<typeof syntheticFactory>["factory"],
): MarketplaceConnectionRegistry {
  return new MarketplaceConnectionRegistry({
    adapters: new ProviderAdapterRegistry([factory]),
    connections: {
      [connectionId]: {
        providerId: "synthetic",
        enabled: true,
        label: "Synthetic store",
        settings: {},
      },
    },
    secrets: environmentSecretAccess({}),
  });
}
