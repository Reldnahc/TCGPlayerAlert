import { describe, expect, it, vi } from "vitest";
import { OrderSyncCoordinator } from "../src/order-sync.js";
import type {
  ManagedOrderList,
  ReadyOrderSource,
} from "../src/ready-orders.js";

const firstSnapshot: ManagedOrderList = {
  fetchedAt: "2026-08-07T12:00:00.000Z",
  orders: [
    {
      orderNumber: "synthetic-order-1",
      buyerName: "Synthetic Buyer",
      orderDate: "2026-08-07T11:00:00.000Z",
      status: "Ready to Ship",
      statusCode: "ReadyToShip",
      canMarkShipped: true,
      shippingType: "Standard",
      productAmount: 10,
      shippingAmount: 1.49,
      totalAmount: 11.49,
    },
  ],
};

function source(initial?: ManagedOrderList) {
  let current = initial;
  const refresh = vi.fn(() => {
    current = firstSnapshot;
    return Promise.resolve(firstSnapshot);
  });
  const readyOrders: ReadyOrderSource = {
    snapshot: () => current,
    refresh,
    remove: (orderNumber) => {
      if (current === undefined) return;
      current = {
        ...current,
        orders: current.orders.filter(
          (order) => order.orderNumber !== orderNumber,
        ),
      };
    },
  };
  return { readyOrders, refresh };
}

function result() {
  return {
    correlationId: "synthetic-sync",
    baselineEstablished: false,
    discoveredCount: 1,
    processedCount: 1,
    failedCount: 0,
    reviewRequiredCount: 0,
  };
}

describe("shared order synchronization", () => {
  it("serves the scheduler snapshot to the dashboard without another refresh", async () => {
    const current = source();
    const run = vi.fn(async () => {
      await current.readyOrders.refresh();
      return result();
    });
    const coordinator = new OrderSyncCoordinator({
      readyOrders: current.readyOrders,
      createWorkflow: () => ({ run }),
    });

    await coordinator.synchronize("scheduled");
    const dashboard = await coordinator.listReadyOrders();

    expect(dashboard).toBe(firstSnapshot);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith("scheduled", {});
    expect(current.refresh).toHaveBeenCalledOnce();
  });

  it("uses the same workflow for a forced dashboard synchronization", async () => {
    const current = source(firstSnapshot);
    const run = vi.fn(async () => {
      await current.readyOrders.refresh();
      return result();
    });
    const coordinator = new OrderSyncCoordinator({
      readyOrders: current.readyOrders,
      createWorkflow: () => ({ run }),
    });

    await expect(coordinator.listReadyOrders({ force: true })).resolves.toBe(
      firstSnapshot,
    );

    expect(run).toHaveBeenCalledWith("manual", {});
    expect(current.refresh).toHaveBeenCalledOnce();
  });

  it("coalesces a dashboard synchronization with an active scheduled run", async () => {
    const current = source();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(async () => {
      await gate;
      await current.readyOrders.refresh();
      return result();
    });
    const coordinator = new OrderSyncCoordinator({
      readyOrders: current.readyOrders,
      createWorkflow: () => ({ run }),
    });

    const scheduled = coordinator.synchronize("scheduled");
    const dashboard = coordinator.listReadyOrders({ force: true });
    release?.();

    await scheduled;
    await expect(dashboard).resolves.toBe(firstSnapshot);
    expect(run).toHaveBeenCalledOnce();
    expect(current.refresh).toHaveBeenCalledOnce();
  });
});
