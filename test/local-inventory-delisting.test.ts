import { describe, it, expect, vi } from "vitest";
import {
  LocalInventoryService,
  emptyLocalInventoryState,
  parseLocalInventoryState,
} from "../src/local-inventory.js";
import {
  previewInventoryDelisting,
  confirmInventoryDelisting,
} from "../src/local-inventory-delisting.js";
import type {
  InventoryListResult,
  InventoryMutationResult,
} from "../src/marketplaces/inventory.js";

async function fixture() {
  let state = emptyLocalInventoryState();
  const local = new LocalInventoryService({
    load: () => Promise.resolve(state),
    save: (next) => {
      state = parseLocalInventoryState(next);
      return Promise.resolve();
    },
  });
  const item = await local.add({
    displayName: "Synthetic Card",
    quantity: 2,
    catalogIdentities: [
      { namespace: "tcgplayer.sku", value: "456", precision: "exact-variant" },
    ],
    attributes: {},
  });
  let quantity = 1;
  const listAll = vi.fn((): Promise<InventoryListResult> =>
    Promise.resolve({
      completedAt: new Date().toISOString(),
      issues: [],
      connections: [
        {
          descriptor: {
            connectionId: "tcg-main",
            providerId: "tcgplayer",
            providerLabel: "TCGplayer",
            connectionLabel: "Test store",
          },
          items: [
            {
              inventoryKey: "sku/456/channel/0",
              displayName: "Synthetic Card",
              quantity,
              catalogIdentities: item.catalogIdentities,
              attributes: {},
              quantityMutation: "increase-or-clear",
              priceMutable: true,
            },
          ],
        },
      ],
    }),
  );
  const update = vi.fn(
    (
      connectionId: string,
      input: { inventoryKey: string },
    ): Promise<InventoryMutationResult> => {
      quantity = 0;
      return Promise.resolve({
        connectionId,
        inventoryKey: input.inventoryKey,
        outcome: "applied",
      });
    },
  );
  return {
    local,
    listAll,
    update,
    id: item.localInventoryId,
    getState: () => state,
    deps: { local, inventory: { listAll, update } },
    setQuantity: (value: number) => {
      quantity = value;
    },
  };
}

describe("per-card delisting", () => {
  it("persists the outcome and pauses auto-relisting before changing a listing", async () => {
    const f = await fixture();
    let observedPaused = false;
    await f.local.withReplenishmentState(async (state, save) => {
      await save({
        ...state,
        replenishments: [
          {
            localInventoryId: f.id,
            connectionId: "tcg-main",
            displayName: "Synthetic Card",
            accountScope: "synthetic",
            enabled: true,
            targetQuantity: 1,
            price: 1,
            status: "watching",
            tickets: [],
            jobs: [],
            message: "",
          },
        ],
      });
    });
    const original = f.update.getMockImplementation();
    if (original === undefined) throw new Error("Missing mutation");
    f.update.mockImplementation((connectionId, input) => {
      observedPaused = f.getState().replenishments?.[0]?.enabled === false;
      expect(f.getState().delistingAttempts?.[0]?.status).toBe("running");
      return original(connectionId, input);
    });
    const preview = await previewInventoryDelisting(f.deps, f.id);
    await confirmInventoryDelisting(f.deps, f.id, preview.id);
    expect(observedPaused).toBe(true);
    await f.local.withReplenishmentState((state) => {
      expect(state.replenishments?.[0]).toMatchObject({
        enabled: false,
        status: "paused",
        tickets: [],
      });
      expect(state.delistingAttempts?.[0]).toMatchObject({
        id: preview.id,
        status: "completed",
      });
      return Promise.resolve();
    });
  });
  it("reviews without mutating, verifies removal, clears only the selected item, and consumes confirmation", async () => {
    const f = await fixture();
    await f.local.add({
      displayName: "Other card",
      quantity: 5,
      catalogIdentities: [
        {
          namespace: "tcgplayer.sku",
          value: "789",
          precision: "exact-variant",
        },
      ],
      attributes: {},
    });
    const preview = await previewInventoryDelisting(f.deps, f.id);
    expect(preview).toMatchObject({ onHand: 2, listings: [{ quantity: 1 }] });
    expect(f.update).not.toHaveBeenCalled();
    expect(
      await confirmInventoryDelisting(f.deps, f.id, preview.id),
    ).toMatchObject({ onHand: 0 });
    expect(
      (await f.local.snapshot()).items.find(
        (item) => item.displayName === "Other card",
      )?.onHand,
    ).toBe(5);
    await expect(
      confirmInventoryDelisting(f.deps, f.id, preview.id),
    ).rejects.toThrow(/already used/);
    expect(f.update).toHaveBeenCalledOnce();
  });
  it("rejects changes since review without clearing or delisting", async () => {
    const f = await fixture();
    const preview = await previewInventoryDelisting(f.deps, f.id);
    f.setQuantity(3);
    await expect(
      confirmInventoryDelisting(f.deps, f.id, preview.id),
    ).rejects.toThrow(/changed after review/);
    expect(f.update).not.toHaveBeenCalled();
    expect((await f.local.snapshot()).items[0]?.onHand).toBe(2);
  });
  it.each(["throw", "review-required", "still-listed"])(
    "keeps local stock after %s and does not retry",
    async (mode) => {
      const f = await fixture();
      const preview = await previewInventoryDelisting(f.deps, f.id);
      f.update.mockImplementation(async (connectionId, input) => {
        await Promise.resolve();
        if (mode === "throw") throw new Error("uncertain");
        return {
          connectionId,
          inventoryKey: input.inventoryKey,
          outcome: mode === "review-required" ? "review-required" : "applied",
        };
      });
      await expect(
        confirmInventoryDelisting(f.deps, f.id, preview.id),
      ).rejects.toThrow(/Local stock was kept/);
      expect((await f.local.snapshot()).items[0]?.onHand).toBe(2);
      expect(f.update).toHaveBeenCalledOnce();
    },
  );
  it("blocks unreadable marketplaces and clears an unlisted item", async () => {
    const f = await fixture();
    f.listAll.mockResolvedValueOnce({
      connections: [],
      completedAt: new Date().toISOString(),
      issues: [
        {
          connectionId: "tcg-main",
          operation: "inventory",
          code: "OFFLINE",
          retryable: true,
        },
      ],
    });
    await expect(previewInventoryDelisting(f.deps, f.id)).rejects.toThrow(
      /could not be read/,
    );
    f.setQuantity(0);
    const preview = await previewInventoryDelisting(f.deps, f.id);
    await confirmInventoryDelisting(f.deps, f.id, preview.id);
    expect(f.update).not.toHaveBeenCalled();
    expect((await f.local.snapshot()).items[0]?.onHand).toBe(0);
  });
});
