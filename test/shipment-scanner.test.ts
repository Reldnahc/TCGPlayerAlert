import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  emptyShipmentScanState,
  JsonShipmentScanStore,
  JsonShipmentTagRegistry,
  recoverInterruptedMutations,
  shipmentTagId,
  ShipmentScannerService,
  type MutationResult,
  type OrderSummary,
  type ProviderOrderRef,
  type QualifiedReadyOrderSnapshot,
  type QualifiedReadyOrderSource,
  type ShipmentScanState,
  type ShipmentScanStore,
} from "../src/index.js";
import { orderRefKey } from "../src/marketplaces/identity.js";
import { syntheticNormalizedOrder } from "./synthetic-marketplace.js";

const NOW = "2026-08-09T12:00:00.000Z";

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

function readyOrder(
  remoteId: string,
  connectionId = "synthetic-main",
  totalMinorUnits = 1_149,
): OrderSummary {
  const order = syntheticNormalizedOrder({ connectionId, remoteId });
  return {
    ...order,
    buyerName: `Buyer ${remoteId}`,
    totals: {
      subtotal: { currency: "USD", minorUnits: totalMinorUnits - 149 },
      shipping: { currency: "USD", minorUnits: 149 },
      total: { currency: "USD", minorUnits: totalMinorUnits },
    },
    actions: {
      ...order.actions,
      "mark-shipped": { state: "available" },
    },
  };
}

function readySource(
  initial: readonly OrderSummary[],
  successfulConnectionIds: readonly string[] = ["synthetic-main"],
): QualifiedReadyOrderSource & {
  refreshes: number;
  current: QualifiedReadyOrderSnapshot;
} {
  const source = {
    refreshes: 0,
    current: {
      orders: [...initial],
      successfulConnectionIds,
      issues: [],
      fetchedAt: NOW,
    } satisfies QualifiedReadyOrderSnapshot,
    snapshot() {
      return this.current;
    },
    refresh() {
      this.refreshes += 1;
      return Promise.resolve(this.current);
    },
    remove(ref: ProviderOrderRef) {
      const key = orderRefKey(ref);
      this.current = {
        ...this.current,
        orders: this.current.orders.filter(
          (order) => orderRefKey(order.ref) !== key,
        ),
      };
    },
  };
  return source;
}

async function service(options: {
  readonly orders: readonly OrderSummary[];
  readonly successfulConnectionIds?: readonly string[];
  readonly store?: MemoryShipmentScanStore;
  readonly automatic?: boolean;
  readonly enabled?: boolean;
  readonly markShipped?: (input: {
    readonly ref: ProviderOrderRef;
  }) => Promise<MutationResult>;
}) {
  const directory = await mkdtemp(join(tmpdir(), "scanner-tags-"));
  const store = options.store ?? new MemoryShipmentScanStore();
  const source = readySource(options.orders, options.successfulConnectionIds);
  const markShipped =
    options.markShipped ??
    ((input: { readonly ref: ProviderOrderRef }) =>
      Promise.resolve({ ref: input.ref, outcome: "applied" as const }));
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
      readyOrders: source,
      orders: { markShipped },
      store,
      tags: new JsonShipmentTagRegistry(join(directory, "tags.json"), {
        now: () => new Date(NOW),
      }),
      now: () => new Date(NOW),
    }),
    store,
    source,
    markShipped,
  };
}

describe("qualified shipment scanner", () => {
  it("reserves unique tags for duplicate remote IDs across connections", async () => {
    const first = readyOrder("DUPLICATE", "first-main");
    const second = readyOrder("DUPLICATE", "second-main");
    const { scanner } = await service({
      orders: [first, second],
      successfulConnectionIds: ["first-main", "second-main"],
    });

    const status = await scanner.status();

    expect(status.readyOrderCount).toBe(2);
    expect(new Set(status.readyTagIds).size).toBe(2);
  });

  it("returns an exact qualified match without mutating in review mode", async () => {
    const order = readyOrder("REVIEW-MATCH");
    const markShipped = vi.fn();
    const { scanner, source } = await service({ orders: [order], markShipped });

    await expect(scanner.scan(shipmentTagId(order.ref))).resolves.toEqual({
      state: "matched",
      tagId: shipmentTagId(order.ref),
      order,
    });
    expect(source.refreshes).toBe(1);
    expect(markShipped).not.toHaveBeenCalled();
  });

  it("revalidates the expected qualified reference before mutation", async () => {
    const order = readyOrder("EXPLICIT-MATCH", "second-main");
    const markShipped = vi.fn((input: { readonly ref: ProviderOrderRef }) =>
      Promise.resolve({ ref: input.ref, outcome: "applied" as const }),
    );
    const { scanner } = await service({
      orders: [order],
      successfulConnectionIds: ["second-main"],
      markShipped,
    });
    const tagId = shipmentTagId(order.ref);

    await expect(scanner.markShipped(tagId, order.ref)).resolves.toMatchObject({
      state: "shipped",
      outcome: "applied",
    });
    expect(markShipped).toHaveBeenCalledWith({ ref: order.ref }, undefined);
  });

  it("marks an automatic exact match once and suppresses a duplicate", async () => {
    const order = readyOrder("AUTO-MATCH");
    const markShipped = vi.fn((input: { readonly ref: ProviderOrderRef }) =>
      Promise.resolve({ ref: input.ref, outcome: "applied" as const }),
    );
    const { scanner, store } = await service({
      orders: [order],
      automatic: true,
      markShipped,
    });
    const tagId = shipmentTagId(order.ref);

    await expect(scanner.scan(tagId)).resolves.toMatchObject({
      state: "shipped",
      outcome: "applied",
    });
    await expect(scanner.scan(tagId)).resolves.toEqual({
      state: "already-processed",
      tagId,
      ref: order.ref,
    });
    expect(markShipped).toHaveBeenCalledOnce();
    expect(store.state.records[orderRefKey(order.ref)]).toMatchObject({
      ref: order.ref,
      status: "succeeded",
    });
  });

  it("stops a $50 automatic match for tracking review", async () => {
    const order = readyOrder("TRACKING-REQUIRED", "synthetic-main", 5_000);
    const markShipped = vi.fn();
    const { scanner, store } = await service({
      orders: [order],
      automatic: true,
      markShipped,
    });

    await expect(scanner.scan(shipmentTagId(order.ref))).resolves.toMatchObject(
      {
        state: "matched",
        order,
      },
    );
    expect(markShipped).not.toHaveBeenCalled();
    expect(store.saves).toBe(0);
  });

  it("quarantines an uncertain mutation and never retries it", async () => {
    const order = readyOrder("UNCERTAIN");
    const markShipped = vi.fn(() => Promise.reject(new Error("socket closed")));
    const { scanner, store } = await service({
      orders: [order],
      automatic: true,
      markShipped,
    });
    const tagId = shipmentTagId(order.ref);

    await expect(scanner.scan(tagId)).rejects.toMatchObject({
      code: "REVIEW_REQUIRED",
    });
    await expect(scanner.scan(tagId)).resolves.toEqual({
      state: "review-required",
      tagId,
      ref: order.ref,
    });
    expect(markShipped).toHaveBeenCalledOnce();
    expect(store.state.records[orderRefKey(order.ref)]?.status).toBe(
      "review-required",
    );
  });

  it("requires scanner opt-in before refreshing any connection", async () => {
    const order = readyOrder("DISABLED");
    const { scanner, source } = await service({
      orders: [order],
      enabled: false,
    });
    await expect(scanner.scan(shipmentTagId(order.ref))).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
    });
    expect(source.refreshes).toBe(0);
  });

  it("recovers interrupted qualified side effects for review", () => {
    const order = readyOrder("INTERRUPTED");
    const key = orderRefKey(order.ref);
    const recovered = recoverInterruptedMutations(
      {
        version: 2,
        records: {
          [key]: {
            ref: order.ref,
            tagId: 11,
            status: "running",
            updatedAt: "2026-08-09T11:59:00.000Z",
          },
        },
      },
      () => new Date(NOW),
    );
    expect(recovered.records[key]).toMatchObject({
      ref: order.ref,
      status: "review-required",
      updatedAt: NOW,
    });
  });

  it("migrates v1 state purely and atomically writes v2 on save", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shipment-scan-v1-"));
    const path = join(directory, "scans.json");
    const legacy = {
      version: 1,
      records: {
        LEGACY: {
          orderNumber: "LEGACY",
          tagId: 12,
          status: "review-required",
          updatedAt: NOW,
        },
      },
    };
    await writeFile(path, JSON.stringify(legacy), "utf8");
    const store = new JsonShipmentScanStore(path, {
      legacyConnectionId: "tcgplayer-main",
    });

    const migrated = await store.load();

    expect(migrated).toMatchObject({
      version: 2,
      records: {
        "tcgplayer-main/LEGACY": {
          ref: { connectionId: "tcgplayer-main", remoteId: "LEGACY" },
          status: "review-required",
        },
      },
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(legacy);
    await store.save(migrated);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(migrated);
  });

  it("rejects malformed qualified state instead of starting empty", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shipment-scan-bad-"));
    const path = join(directory, "scans.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 2,
        records: {
          "first-main/ORDER": {
            ref: { connectionId: "second-main", remoteId: "ORDER" },
            tagId: 1,
            status: "succeeded",
            updatedAt: NOW,
          },
        },
      }),
      "utf8",
    );
    await expect(new JsonShipmentScanStore(path).load()).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
    });
  });
});
