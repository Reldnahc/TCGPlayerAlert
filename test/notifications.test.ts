import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SellerOrderStatus } from "tcgplayer-private-api";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../src/logger.js";
import {
  JsonNotificationStateStore,
  NotificationMonitor,
  NotificationService,
  type DiscordNotificationSettings,
  type NotificationEvent,
  type NotificationPublisher,
  type NotificationSink,
} from "../src/notifications/index.js";

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
    };

    await service.publish(event);
    configured = true;
    await service.publish(event);

    expect(send).toHaveBeenCalledOnce();
  });

  it("removes a successful app shipment from cancellation comparison even when delivery is disabled", async () => {
    const notificationState = await state();
    await notificationState.writeReadyOrderNumbers(["synthetic-order-1"]);
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
      orderNumber: "synthetic-order-1",
      outcome: "applied",
    });

    await expect(notificationState.readReadyOrderNumbers()).resolves.toEqual(
      [],
    );
  });
});

describe("NotificationMonitor", () => {
  it("baselines existing data, then reports only new unread messages and confirmed cancellations", async () => {
    let readyOrders = [
      {
        orderNumber: "synthetic-order-1",
        buyerName: "not transmitted",
        orderDate: "2026-08-10T10:00:00.000Z",
        status: "Ready to Ship",
        statusCode: "ReadyToShip" as const,
        canMarkShipped: true,
        shippingType: "Standard",
        productAmount: 1,
        shippingAmount: 1.49,
        totalAmount: 2.49,
      },
    ];
    let totalMessageCount = 1;
    let unreadMessageCount = 1;
    const publish = vi.fn<NotificationPublisher["publish"]>(() =>
      Promise.resolve(),
    );
    const getOrder = vi.fn(() =>
      Promise.resolve({
        status: "Canceled",
        statusCode: SellerOrderStatus.Canceled,
      }),
    );
    const monitor = new NotificationMonitor({
      settings: () => settings,
      publisher: { publish },
      state: await state(),
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
      orders: { getOrder },
      readyOrders: {
        snapshot: () => ({
          orders: readyOrders,
          fetchedAt: "2026-08-10T12:00:00.000Z",
        }),
        refresh: () => Promise.reject(new Error("not used")),
        remove: () => undefined,
      },
      logger,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    });

    await monitor.run();
    expect(publish).not.toHaveBeenCalled();

    readyOrders = [];
    totalMessageCount = 2;
    unreadMessageCount = 2;
    await monitor.run();
    await monitor.run();

    expect(getOrder).toHaveBeenCalledOnce();
    expect(publish.mock.calls.map(([event]) => event.type).sort()).toEqual([
      "inbound-message",
      "order-canceled",
    ]);
    for (const [event] of publish.mock.calls) {
      expect(event).not.toHaveProperty("buyerName");
    }
  });
});
