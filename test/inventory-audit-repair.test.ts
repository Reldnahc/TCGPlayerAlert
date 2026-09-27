import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  LocalInventoryService,
  emptyLocalInventoryState,
} from "../src/local-inventory.js";
import { InventoryAdditionQueueStore } from "../src/inventory-additions.js";
import {
  previewAuditRepair,
  queueAuditRepair,
} from "../src/inventory-audit-repair.js";
import type { InventoryListResult } from "../src/marketplaces/inventory.js";

async function fixture() {
  let state = emptyLocalInventoryState();
  const local = new LocalInventoryService({
    load: () => Promise.resolve(state),
    save: (next) => {
      state = next;
      return Promise.resolve();
    },
  });
  const item = await local.add({
    displayName: "Test card",
    quantity: 5,
    attributes: {},
    catalogIdentities: [
      { namespace: "tcgplayer.sku", value: "456", precision: "exact-variant" },
      { namespace: "tcgplayer.product", value: "123", precision: "product" },
    ],
  });
  let quantity = 1;
  let elsewhere = 0;
  const queue = new InventoryAdditionQueueStore({
    stateFile: join(
      await mkdtemp(join(tmpdir(), "audit-repair-")),
      "queue.json",
    ),
    historyLimit: 25,
  });
  const listAll = vi.fn((): Promise<InventoryListResult> =>
    Promise.resolve({
      completedAt: new Date().toISOString(),
      issues: [],
      connections: ["tcg-main", "other-main"].map((connectionId) => ({
        descriptor: {
          connectionId,
          providerId: "tcgplayer",
          providerLabel: "Test",
          connectionLabel: connectionId,
        },
        items: [
          {
            inventoryKey: "sku/456",
            displayName: item.displayName,
            quantity: connectionId === "tcg-main" ? quantity : elsewhere,
            catalogIdentities: item.catalogIdentities,
            attributes: {},
            quantityMutation: "increase-or-clear",
            priceMutable: true,
          },
        ],
      })),
    }),
  );
  const prepareStockRepair = vi.fn(
    (
      productId: number,
      productConditionId: number,
      target: number,
      price?: number,
    ) => {
      if (target <= quantity) throw new Error("No missing quantity");
      const chosen = price ?? (quantity > 0 ? 2 : undefined);
      return Promise.resolve({
        currentQuantity: quantity,
        ...(chosen === undefined
          ? {}
          : {
              price: chosen,
              addition: {
                productId,
                productConditionId,
                productName: "Test card",
                categoryName: "Test",
                conditionId: 1,
                channelId: 0,
                currentQuantity: quantity,
                addQuantity: target - quantity,
                price: chosen,
                storePriceCustomId: null,
                reserveQuantity: 0,
              },
            }),
      });
    },
  );
  const fixedPrices = vi.fn((): Promise<Readonly<Record<string, number>>> =>
    Promise.resolve({}),
  );
  const deps = {
    local,
    queue,
    inventory: { listAll },
    additions: { prepareStockRepair },
    fixedPrices,
  };
  const request = { localId: item.localInventoryId, connectionId: "tcg-main" };
  return {
    deps,
    request,
    item,
    setQuantity: (n: number) => {
      quantity = n;
    },
    setElsewhere: (n: number) => {
      elsewhere = n;
    },
  };
}

describe("audit listing corrections", () => {
  it("queues only the fresh shortfall, keeps local stock, and prevents duplicate repairs", async () => {
    const f = await fixture();
    const preview = await previewAuditRepair(f.deps, f.request);
    expect(preview).toMatchObject({
      onHand: 5,
      listed: 1,
      target: 5,
      addQuantity: 4,
      price: 2,
    });
    expect((await f.deps.queue.snapshot()).jobs).toHaveLength(0);
    const jobs = await queueAuditRepair(
      f.deps,
      f.request.localId,
      f.request.connectionId,
      preview.id,
    );
    expect(jobs[0]).toMatchObject({
      operation: "add",
      addition: { currentQuantity: 1, addQuantity: 4, price: 2 },
    });
    expect((await f.deps.local.snapshot()).items[0]?.onHand).toBe(5);
    await expect(
      queueAuditRepair(
        f.deps,
        f.request.localId,
        f.request.connectionId,
        preview.id,
      ),
    ).rejects.toThrow(/already used/);
    await expect(previewAuditRepair(f.deps, f.request)).rejects.toThrow(
      /pending or running/,
    );
  });
  it("rejects stock changes between review and queueing", async () => {
    const f = await fixture();
    const preview = await previewAuditRepair(f.deps, f.request);
    f.setQuantity(2);
    await expect(
      queueAuditRepair(
        f.deps,
        f.request.localId,
        f.request.connectionId,
        preview.id,
      ),
    ).rejects.toThrow(/changed/);
    expect((await f.deps.queue.snapshot()).jobs).toHaveLength(0);
  });
  it("reserves cross-listed stock and respects public limits and fixed prices", async () => {
    const f = await fixture();
    f.setElsewhere(2);
    f.deps.fixedPrices.mockResolvedValue({ "456:0": 1.25 });
    await f.deps.local.withReplenishmentState((state, save) =>
      save({
        ...state,
        replenishments: [
          {
            localInventoryId: f.item.localInventoryId,
            displayName: "Test card",
            connectionId: "tcg-main",
            accountScope: "synthetic",
            enabled: true,
            targetQuantity: 2,
            price: 2,
            status: "watching",
            tickets: [],
            jobs: [],
            message: "",
          },
        ],
      }),
    );
    const preview = await previewAuditRepair(f.deps, {
      ...f.request,
      price: 9,
    });
    expect(preview).toMatchObject({
      target: 2,
      addQuantity: 1,
      price: 1.25,
      fixedPrice: true,
      reservedElsewhere: 2,
      limited: true,
    });
  });
  it("requires a reviewed price for an unlisted card", async () => {
    const f = await fixture();
    f.setQuantity(0);
    const empty = await previewAuditRepair(f.deps, f.request);
    expect(empty.price).toBeUndefined();
    await expect(
      queueAuditRepair(
        f.deps,
        f.request.localId,
        f.request.connectionId,
        empty.id,
      ),
    ).rejects.toThrow(/Enter and review a price/);
    const priced = await previewAuditRepair(f.deps, {
      ...f.request,
      price: 1.5,
    });
    const jobs = await queueAuditRepair(
      f.deps,
      f.request.localId,
      f.request.connectionId,
      priced.id,
    );
    expect(jobs[0]).toMatchObject({
      addition: { currentQuantity: 0, addQuantity: 5, price: 1.5 },
    });
  });
  it("blocks unknown inventory instead of treating it as unlisted", async () => {
    const f = await fixture();
    f.deps.inventory.listAll.mockResolvedValue({
      completedAt: new Date().toISOString(),
      connections: [],
      issues: [
        {
          connectionId: "tcg-main",
          operation: "inventory",
          code: "OFFLINE",
          retryable: true,
        },
      ],
    });
    await expect(previewAuditRepair(f.deps, f.request)).rejects.toThrow(
      /could not be read/,
    );
  });
});
