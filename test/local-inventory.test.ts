import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JsonLocalInventoryStore,
  LocalInventoryService,
  emptyLocalInventoryState,
  parseLocalInventoryState,
} from "../src/local-inventory.js";

const firstId = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";

describe("local inventory ledger", () => {
  it("starts empty and persists unlisted stock", async () => {
    const path = await statePath();
    const store = new JsonLocalInventoryStore(path);
    const service = new LocalInventoryService(store, {
      now: () => new Date("2026-08-25T20:00:00.000Z"),
      id: () => firstId,
    });

    expect(await store.load()).toEqual(emptyLocalInventoryState());
    await service.add(addition(3));

    await expect(service.snapshot()).resolves.toMatchObject({
      items: [
        {
          localInventoryId: firstId,
          displayName: "Synthetic Card",
          onHand: 3,
          attributes: { condition: "Near Mint" },
        },
      ],
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 2,
    });
  });

  it("merges concurrent additions only by exact variant identity", async () => {
    const service = new LocalInventoryService(
      new JsonLocalInventoryStore(await statePath()),
      {
        now: () => new Date("2026-08-25T20:00:00.000Z"),
        id: () => firstId,
      },
    );

    await Promise.all([service.add(addition(2)), service.add(addition(4))]);

    expect((await service.snapshot()).items).toMatchObject([{ onHand: 6 }]);
  });

  it("retains a zero-quantity item instead of deleting its identity", async () => {
    const service = new LocalInventoryService(
      new JsonLocalInventoryStore(await statePath()),
      {
        now: () => new Date("2026-08-25T20:00:00.000Z"),
        id: () => firstId,
      },
    );
    await service.add(addition(1));

    const item = await service.setQuantity(firstId, 0);

    expect(item.onHand).toBe(0);
    expect((await service.snapshot()).items).toHaveLength(1);
  });

  it("rejects persisted exact identities assigned to multiple local items", () => {
    const base = {
      displayName: "Synthetic Card",
      onHand: 1,
      catalogIdentities: addition(1).catalogIdentities,
      attributes: {},
      createdAt: "2026-08-25T20:00:00.000Z",
      updatedAt: "2026-08-25T20:00:00.000Z",
    };

    expect(() =>
      parseLocalInventoryState({
        version: 1,
        items: [
          { ...base, localInventoryId: firstId },
          { ...base, localInventoryId: secondId },
        ],
      }),
    ).toThrow("local inventory state is invalid");
  });

  it("migrates version-one items and enables future sale tracking", () => {
    const item = {
      localInventoryId: firstId,
      displayName: "Synthetic Card",
      onHand: 2,
      catalogIdentities: addition(1).catalogIdentities,
      attributes: {},
      createdAt: "2026-08-24T20:00:00.000Z",
      updatedAt: "2026-08-25T20:00:00.000Z",
    };

    expect(parseLocalInventoryState({ version: 1, items: [item] })).toEqual({
      version: 2,
      items: [item],
      salesTrackingStartedAt: "2026-08-24T20:00:00.000Z",
      saleDeductions: {},
    });
  });

  it("initializes missing exact variants atomically without overwriting existing stock", async () => {
    const ids = [firstId, secondId];
    const service = new LocalInventoryService(
      new JsonLocalInventoryStore(await statePath()),
      {
        now: () => new Date("2026-08-25T20:00:00.000Z"),
        id: () => ids.shift() ?? "00000000-0000-4000-8000-000000000003",
      },
    );
    await service.add(addition(3));

    const created = await service.initializeMissing([
      addition(99),
      {
        ...addition(4),
        displayName: "Second Card",
        catalogIdentities: [
          {
            namespace: "tcgplayer.sku",
            value: "789",
            precision: "exact-variant",
          },
        ],
      },
    ]);

    expect(created).toMatchObject([{ displayName: "Second Card", onHand: 4 }]);
    expect((await service.snapshot()).items).toMatchObject([
      { displayName: "Second Card", onHand: 4 },
      { displayName: "Synthetic Card", onHand: 3 },
    ]);
  });

  it("deducts a qualified sale once and records shortages and unmatched lines", async () => {
    const path = await statePath();
    const service = new LocalInventoryService(
      new JsonLocalInventoryStore(path),
      {
        now: () => new Date("2026-08-25T20:00:00.000Z"),
        id: () => firstId,
      },
    );
    await service.add(addition(3));
    const sale = {
      ref: { connectionId: "tcgplayer-main", remoteId: "ORDER/1" },
      lines: [
        { quantity: 5, catalogIdentities: addition(1).catalogIdentities },
        {
          quantity: 2,
          catalogIdentities: [
            {
              namespace: "tcgplayer.sku",
              value: "unmatched",
              precision: "exact-variant" as const,
            },
          ],
        },
      ],
    };

    await expect(service.deductSale(sale)).resolves.toMatchObject({
      outcome: "applied",
      requestedQuantity: 7,
      deductedQuantity: 3,
      unmatchedQuantity: 2,
      shortageQuantity: 2,
    });
    await expect(service.deductSale(sale)).resolves.toMatchObject({
      outcome: "already-applied",
      deductedQuantity: 3,
    });
    expect((await service.snapshot()).items[0]?.onHand).toBe(0);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      saleDeductions: {
        "tcgplayer-main/ORDER%2F1": {
          requestedQuantity: 7,
          deductedQuantity: 3,
        },
      },
    });
  });

  it("deducts a sale through a shared product and normalized complete variant", async () => {
    const service = new LocalInventoryService(
      new JsonLocalInventoryStore(await statePath()),
      {
        now: () => new Date("2026-08-25T20:00:00.000Z"),
        id: () => firstId,
      },
    );
    await service.add({
      displayName: "Synthetic Card",
      quantity: 3,
      catalogIdentities: [
        {
          namespace: "tcgplayer.product",
          value: "456",
          precision: "product",
        },
      ],
      attributes: {
        language: "English",
        condition: "Near Mint",
        printing: "Normal",
      },
    });

    await expect(
      service.deductSale({
        ref: { connectionId: "manapool-main", remoteId: "ORDER-2" },
        lines: [
          {
            quantity: 2,
            catalogIdentities: [
              {
                namespace: "manapool.product",
                value: "mana-product",
                precision: "exact-variant",
              },
              {
                namespace: "tcgplayer.product",
                value: "456",
                precision: "product",
              },
            ],
            attributes: {
              language: "en",
              condition: "near_mint",
              finish: "nonfoil",
            },
          },
        ],
      }),
    ).resolves.toMatchObject({
      outcome: "applied",
      requestedQuantity: 2,
      deductedQuantity: 2,
      unmatchedQuantity: 0,
    });
    expect((await service.snapshot()).items[0]?.onHand).toBe(1);
  });

  it("loads a legacy derived collision but refuses an ambiguous sale deduction", async () => {
    const variant = {
      displayName: "Synthetic Card",
      onHand: 1,
      attributes: {
        language: "English",
        condition: "Near Mint",
        printing: "Normal",
      },
      createdAt: "2026-08-25T20:00:00.000Z",
      updatedAt: "2026-08-25T20:00:00.000Z",
    };

    const state = parseLocalInventoryState({
      version: 2,
      items: [
        {
          ...variant,
          localInventoryId: firstId,
          catalogIdentities: [
            {
              namespace: "tcgplayer.sku",
              value: "111",
              precision: "exact-variant",
            },
            {
              namespace: "tcgplayer.product",
              value: "456",
              precision: "product",
            },
          ],
        },
        {
          ...variant,
          localInventoryId: secondId,
          catalogIdentities: [
            {
              namespace: "manapool.product",
              value: "mana-product",
              precision: "exact-variant",
            },
            {
              namespace: "tcgplayer.product",
              value: "456",
              precision: "product",
            },
          ],
        },
      ],
      salesTrackingStartedAt: "2026-08-25T20:00:00.000Z",
      saleDeductions: {},
    });
    const service = new LocalInventoryService({
      load: () => Promise.resolve(structuredClone(state)),
      save: () => Promise.resolve(),
    });

    await expect(
      service.deductSale({
        ref: { connectionId: "manapool-main", remoteId: "ORDER-3" },
        lines: [
          {
            quantity: 1,
            catalogIdentities: [
              {
                namespace: "third-market.product",
                value: "third-sale-product",
                precision: "exact-variant",
              },
              {
                namespace: "tcgplayer.product",
                value: "456",
                precision: "product",
              },
            ],
            attributes: variant.attributes,
          },
        ],
      }),
    ).rejects.toThrow("conflicting local inventory items");

    await expect(
      service.deductSale({
        ref: { connectionId: "tcgplayer-main", remoteId: "ORDER-4" },
        lines: [
          {
            quantity: 1,
            catalogIdentities: [
              {
                namespace: "tcgplayer.sku",
                value: "111",
                precision: "exact-variant",
              },
              {
                namespace: "tcgplayer.product",
                value: "456",
                precision: "product",
              },
            ],
            attributes: variant.attributes,
          },
        ],
      }),
    ).resolves.toMatchObject({
      outcome: "applied",
      deductedQuantity: 1,
      unmatchedQuantity: 0,
    });
  });
});

function addition(quantity: number) {
  return {
    displayName: "Synthetic Card",
    quantity,
    catalogIdentities: [
      {
        namespace: "tcgplayer.sku",
        value: "456",
        precision: "exact-variant" as const,
      },
      {
        namespace: "tcgplayer.product",
        value: "123",
        precision: "product" as const,
      },
    ],
    attributes: { condition: "Near Mint" },
  };
}

async function statePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "local-inventory-")), "state.json");
}
