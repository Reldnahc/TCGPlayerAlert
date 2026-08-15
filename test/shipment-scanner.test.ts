import { SellerOrderStatus } from "tcgplayer-private-api";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  emptyShipmentScanState,
  JsonShipmentScanStore,
  recoverInterruptedMutations,
  shipmentTagId,
  ShipmentScannerService,
  SHIPMENT_TAG_COUNT,
  type ShipmentScanState,
  type ShipmentScanStore,
  type ShipmentTagAssignment,
  type ShipmentTagRegistry,
} from "../src/index.js";
import type {
  ManagedOrderList,
  ManagedOrderSummary,
  ReadyOrderSource,
} from "../src/ready-orders.js";

class MemoryShipmentScanStore implements ShipmentScanStore {
  state = emptyShipmentScanState();
  saves = 0;

  load(): Promise<ShipmentScanState> {
    return Promise.resolve(structuredClone(this.state));
  }

  save(state: ShipmentScanState): Promise<void> {
    this.saves += 1;
    this.state = structuredClone(state);
    return Promise.resolve();
  }
}

class MemoryShipmentTagRegistry implements ShipmentTagRegistry {
  private assignments = new Map<string, ShipmentTagAssignment>();

  assign(orderNumber: string): Promise<number> {
    return this.reserveAll([orderNumber]).then((values) => {
      const assignment = values[0];
      if (assignment === undefined) throw new Error("Assignment is missing.");
      return assignment.tagId;
    });
  }

  reserveAll(
    orderNumbers: readonly string[],
  ): Promise<readonly ShipmentTagAssignment[]> {
    const used = new Set(
      [...this.assignments.values()].map((assignment) => assignment.tagId),
    );
    for (const orderNumber of [...new Set(orderNumbers)].sort()) {
      if (this.assignments.has(orderNumber)) continue;
      const preferred = shipmentTagId(orderNumber);
      for (let offset = 0; offset < SHIPMENT_TAG_COUNT; offset += 1) {
        const tagId = (preferred + offset) % SHIPMENT_TAG_COUNT;
        if (used.has(tagId)) continue;
        this.assignments.set(orderNumber, {
          orderNumber,
          tagId,
          assignedAt: "2026-08-09T12:00:00.000Z",
        });
        used.add(tagId);
        break;
      }
    }
    return this.assigned(orderNumbers);
  }

  reconcile(
    orderNumbers: readonly string[],
  ): Promise<readonly ShipmentTagAssignment[]> {
    const active = new Set(orderNumbers);
    this.assignments = new Map(
      [...this.assignments].filter(([orderNumber]) => active.has(orderNumber)),
    );
    return this.reserveAll(orderNumbers);
  }

  assigned(
    orderNumbers: readonly string[],
  ): Promise<readonly ShipmentTagAssignment[]> {
    return Promise.resolve(
      orderNumbers.flatMap((orderNumber) => {
        const assignment = this.assignments.get(orderNumber);
        return assignment === undefined ? [] : [assignment];
      }),
    );
  }
}

function managedOrder(orderNumber: string): ManagedOrderSummary {
  return {
    orderNumber,
    buyerName: `Buyer ${orderNumber}`,
    orderDate: "2026-08-09T12:00:00.000Z",
    status: "Ready to Ship",
    statusCode: SellerOrderStatus.ReadyToShip,
    canMarkShipped: true,
    shippingType: "Standard",
    productAmount: 10,
    shippingAmount: 1.49,
    totalAmount: 11.49,
  };
}

function readySource(
  initial: readonly ManagedOrderSummary[],
): ReadyOrderSource & {
  refreshes: number;
} {
  let current: ManagedOrderList = {
    orders: [...initial],
    fetchedAt: "2026-08-09T12:00:00.000Z",
  };
  return {
    refreshes: 0,
    snapshot: () => current,
    refresh() {
      this.refreshes += 1;
      return Promise.resolve(current);
    },
    remove(orderNumber) {
      current = {
        ...current,
        orders: current.orders.filter(
          (order) => order.orderNumber !== orderNumber,
        ),
      };
    },
  };
}

function service(options: {
  readonly ready: ReadyOrderSource;
  readonly store?: MemoryShipmentScanStore;
  readonly automatic?: boolean;
  readonly enabled?: boolean;
  readonly markShipped?: (orderNumber: string) => Promise<{
    readonly orderNumber: string;
    readonly outcome: "applied" | "already-applied";
  }>;
}) {
  const store = options.store ?? new MemoryShipmentScanStore();
  const markShipped =
    options.markShipped ??
    ((orderNumber: string) =>
      Promise.resolve({ orderNumber, outcome: "applied" as const }));
  return {
    scanner: new ShipmentScannerService({
      settings: () =>
        Promise.resolve({
          enabled: options.enabled ?? true,
          automaticallyMarkShipped: options.automatic ?? false,
          soundEnabled: true,
          camera: { enabled: false, deviceId: "" },
          stateFile: ".data/test-shipment-scans.json",
        }),
      readyOrders: options.ready,
      orders: { markShipped },
      store,
      tags: new MemoryShipmentTagRegistry(),
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    }),
    store,
  };
}

function collidingOrderNumbers(): readonly [string, string] {
  const seen = new Map<number, string>();
  for (let index = 0; index <= SHIPMENT_TAG_COUNT; index += 1) {
    const orderNumber = `COLLISION-${String(index)}`;
    const tagId = shipmentTagId(orderNumber);
    const previous = seen.get(tagId);
    if (previous !== undefined) return [previous, orderNumber];
    seen.set(tagId, orderNumber);
  }
  throw new Error("Expected a deterministic tag collision.");
}

describe("shipment scanner", () => {
  it("maps an order number to one stable tag without embedding the order", () => {
    const first = shipmentTagId("SYNTHETIC-ORDER-1");
    expect(shipmentTagId("SYNTHETIC-ORDER-1")).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(SHIPMENT_TAG_COUNT);
    expect(shipmentTagId("SYNTHETIC-ORDER-2")).not.toBe(first);
  });

  it("reserves distinct tags for the in-memory ready pool without refreshing the seller", async () => {
    const [first, second] = collidingOrderNumbers();
    const ready = readySource([
      managedOrder(first),
      managedOrder(second),
      managedOrder("UNIQUE-ORDER"),
    ]);
    const { scanner } = service({ ready });

    await expect(scanner.status()).resolves.toMatchObject({
      enabled: true,
      readyOrderCount: 3,
      conflictingTagCount: 0,
      reviewRequiredCount: 0,
    });
    expect(ready.refreshes).toBe(0);
  });

  it("refreshes authoritatively and returns an exact match without mutating in review mode", async () => {
    const order = managedOrder("REVIEW-MATCH");
    const ready = readySource([order]);
    const markShipped = vi.fn();
    const { scanner } = service({ ready, markShipped });

    await expect(
      scanner.scan(shipmentTagId(order.orderNumber)),
    ).resolves.toEqual({
      state: "matched",
      tagId: shipmentTagId(order.orderNumber),
      order,
    });
    expect(ready.refreshes).toBe(1);
    expect(markShipped).not.toHaveBeenCalled();
  });

  it("revalidates the expected review match before an explicit mutation", async () => {
    const order = managedOrder("EXPLICIT-MATCH");
    const ready = readySource([order]);
    const markShipped = vi.fn((orderNumber: string) =>
      Promise.resolve({ orderNumber, outcome: "applied" as const }),
    );
    const { scanner } = service({ ready, markShipped });
    const tagId = shipmentTagId(order.orderNumber);

    await expect(
      scanner.markShipped(tagId, order.orderNumber),
    ).resolves.toMatchObject({ state: "shipped", tagId, outcome: "applied" });
    expect(ready.refreshes).toBe(1);
    expect(markShipped).toHaveBeenCalledWith(order.orderNumber, undefined);
  });

  it("marks an automatic exact match once and durably suppresses a duplicate", async () => {
    const order = managedOrder("AUTO-MATCH");
    const ready = readySource([order]);
    const markShipped = vi.fn((orderNumber: string) =>
      Promise.resolve({ orderNumber, outcome: "applied" as const }),
    );
    const { scanner, store } = service({
      ready,
      automatic: true,
      markShipped,
    });
    const tagId = shipmentTagId(order.orderNumber);

    await expect(scanner.scan(tagId)).resolves.toMatchObject({
      state: "shipped",
      tagId,
      outcome: "applied",
    });
    await expect(scanner.scan(tagId)).resolves.toEqual({
      state: "already-processed",
      tagId,
      orderNumber: order.orderNumber,
    });
    expect(markShipped).toHaveBeenCalledTimes(1);
    expect(store.state.records[order.orderNumber]).toMatchObject({
      status: "succeeded",
      outcome: "applied",
    });
  });

  it("resolves hash collisions before either ready order can share a tag", async () => {
    const [first, second] = collidingOrderNumbers();
    const ready = readySource([managedOrder(first), managedOrder(second)]);
    const markShipped = vi.fn((orderNumber: string) =>
      Promise.resolve({ orderNumber, outcome: "applied" as const }),
    );
    const { scanner } = service({
      ready,
      automatic: true,
      markShipped,
    });

    const status = await scanner.status();
    expect(status.readyTagIds).toHaveLength(2);
    expect(new Set(status.readyTagIds).size).toBe(2);

    await expect(
      scanner.scan(status.readyTagIds[0] ?? -1),
    ).resolves.toMatchObject({ state: "shipped" });
    await expect(
      scanner.scan(status.readyTagIds[1] ?? -1),
    ).resolves.toMatchObject({ state: "shipped" });
    expect(markShipped).toHaveBeenCalledTimes(2);
  });

  it("quarantines an uncertain mutation and never retries it", async () => {
    const order = managedOrder("UNCERTAIN-MATCH");
    const ready = readySource([order]);
    const markShipped = vi.fn(() => Promise.reject(new Error("socket closed")));
    const { scanner, store } = service({
      ready,
      automatic: true,
      markShipped,
    });
    const tagId = shipmentTagId(order.orderNumber);

    await expect(scanner.scan(tagId)).rejects.toMatchObject({
      code: "REVIEW_REQUIRED",
    });
    await expect(scanner.scan(tagId)).resolves.toEqual({
      state: "review-required",
      tagId,
      orderNumber: order.orderNumber,
    });
    expect(markShipped).toHaveBeenCalledTimes(1);
    expect(store.state.records[order.orderNumber]?.status).toBe(
      "review-required",
    );
  });

  it("requires the scanner opt-in before contacting the ready-order source", async () => {
    const order = managedOrder("DISABLED-MATCH");
    const ready = readySource([order]);
    const { scanner } = service({ ready, enabled: false });

    await expect(
      scanner.scan(shipmentTagId(order.orderNumber)),
    ).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
    expect(ready.refreshes).toBe(0);
  });

  it("recovers an interrupted side effect as review-required", () => {
    const recovered = recoverInterruptedMutations(
      {
        version: 1,
        records: {
          "INTERRUPTED-ORDER": {
            orderNumber: "INTERRUPTED-ORDER",
            tagId: 11,
            status: "running",
            updatedAt: "2026-08-09T11:59:00.000Z",
          },
        },
      },
      () => new Date("2026-08-09T12:00:00.000Z"),
    );

    expect(recovered.records["INTERRUPTED-ORDER"]).toEqual({
      orderNumber: "INTERRUPTED-ORDER",
      tagId: 11,
      status: "review-required",
      updatedAt: "2026-08-09T12:00:00.000Z",
    });
  });

  it("persists the mutation ledger atomically without buyer data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shipment-scanner-test-"));
    const store = new JsonShipmentScanStore(join(directory, "scans.json"));
    const state: ShipmentScanState = {
      version: 1,
      records: {
        "PERSISTED-ORDER": {
          orderNumber: "PERSISTED-ORDER",
          tagId: 51,
          status: "succeeded",
          updatedAt: "2026-08-09T12:00:00.000Z",
          outcome: "applied",
        },
      },
    };

    await expect(store.load()).resolves.toEqual(emptyShipmentScanState());
    await store.save(state);
    await expect(store.load()).resolves.toEqual(state);
    expect(JSON.stringify(await store.load())).not.toContain("Buyer");
  });
});
