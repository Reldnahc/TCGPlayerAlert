import { describe, expect, it, vi } from "vitest";
import type { SellerInventoryItem } from "manapool-seller-api";
import {
  ManaPoolInventoryFacet,
  type ManaPoolInventoryClient,
} from "../../src/providers/manapool/inventory.js";

const mutableItem: SellerInventoryItem = {
  id: "inventory/22",
  productType: "mtg_single",
  productId: "product-22",
  product: {
    type: "mtg_single",
    id: "product-22",
    tcgplayerSku: 123,
    single: {
      scryfallId: "scryfall-22",
      mtgjsonId: "mtgjson-22",
      tcgplayerId: 456,
      name: "Synthetic Single",
      set: "TST",
      number: "22",
      languageId: "en",
      conditionId: "near_mint",
      finishId: "nonfoil",
    },
    sealed: null,
  },
  priceCents: 250,
  quantity: 3,
  effectiveAsOf: "2026-08-25T12:00:00.000Z",
  customExternalId: null,
};

describe("ManaPool inventory facet", () => {
  it("preserves the native cursor and normalizes an exact mutable identity", async () => {
    const client = fakeClient();
    vi.mocked(client.listSellerInventory).mockResolvedValueOnce({
      inventory: [mutableItem],
      pagination: {
        limit: 1,
        nextCursor: "opaque/+cursor",
        total: 2,
        returned: 1,
        offset: 0,
      },
    });
    const facet = new ManaPoolInventoryFacet(client, "manapool-main");

    const page = await facet.readInventoryPage({ pageSize: 1 });

    expect(page.nextCursor).toBe("opaque/+cursor");
    expect(page.items[0]).toMatchObject({
      inventoryKey: "sku/123/item/inventory%2F22",
      displayName: "Synthetic Single",
      quantity: 3,
      price: { currency: "USD", minorUnits: 250 },
      attributes: {
        setCode: "TST",
        collectorNumber: "22",
        language: "en",
        condition: "near_mint",
        finish: "nonfoil",
      },
      quantityMutation: "absolute",
      priceMutable: true,
    });
    expect(page.items[0]?.catalogIdentities).toEqual(
      expect.arrayContaining([
        {
          namespace: "tcgplayer.product",
          value: "456",
          precision: "product",
        },
      ]),
    );
    expect(client.listSellerInventory).toHaveBeenCalledWith(
      { limit: 1, minimumQuantity: 0 },
      undefined,
    );
  });

  it("makes inventory without a TCGplayer SKU explicitly read-only", async () => {
    const client = fakeClient();
    vi.mocked(client.listSellerInventory).mockResolvedValueOnce({
      inventory: [
        {
          ...mutableItem,
          id: "read-only",
          product: { ...mutableItem.product, tcgplayerSku: null },
        },
      ],
      pagination: {
        limit: 100,
        nextCursor: null,
        total: 1,
        returned: 1,
        offset: 0,
      },
    });

    const page = await new ManaPoolInventoryFacet(
      client,
      "manapool-main",
    ).readInventoryPage({ pageSize: 100 });

    expect(page.items[0]).toMatchObject({
      inventoryKey: "item/read-only",
      quantityMutation: "unavailable",
      priceMutable: false,
    });
  });

  it("re-reads the exact item and verifies an absolute update", async () => {
    const client = fakeClient();
    vi.mocked(client.updateSellerInventoryByTcgplayerSku).mockResolvedValueOnce(
      {
        ...mutableItem,
        quantity: 5,
        priceCents: 275,
      },
    );
    const outcome = await new ManaPoolInventoryFacet(
      client,
      "manapool-main",
    ).updateInventory({
      inventoryKey: "sku/123/item/inventory%2F22",
      quantity: 5,
      price: { currency: "USD", minorUnits: 275 },
      idempotencyKey: "mutation-1",
    });

    expect(outcome).toBe("applied");
    expect(client.getSellerInventoryByTcgplayerSku).toHaveBeenCalledWith(
      123,
      undefined,
    );
    expect(client.updateSellerInventoryByTcgplayerSku).toHaveBeenCalledWith(
      { tcgplayerSku: 123, quantity: 5, priceCents: 275 },
      undefined,
    );
  });

  it("requires review when ManaPool returns a different inventory identity", async () => {
    const client = fakeClient();
    vi.mocked(client.updateSellerInventoryByTcgplayerSku).mockResolvedValueOnce(
      {
        ...mutableItem,
        id: "replacement-id",
        quantity: 5,
      },
    );
    await expect(
      new ManaPoolInventoryFacet(client, "manapool-main").updateInventory({
        inventoryKey: "sku/123/item/inventory%2F22",
        quantity: 5,
        idempotencyKey: "mutation-2",
      }),
    ).resolves.toBe("review-required");
  });

  it("publishes a missing exact-SKU listing with quantity and price", async () => {
    const client = fakeClient();
    vi.mocked(client.getSellerInventoryByTcgplayerSku).mockRejectedValueOnce({
      status: 404,
    });
    vi.mocked(client.setSellerInventoryByTcgplayerSkus).mockResolvedValueOnce({
      inventory: [{ ...mutableItem, quantity: 2, priceCents: 199 }],
      skipped: [],
    });
    const facet = new ManaPoolInventoryFacet(client, "manapool-main");

    await expect(
      facet.readExactInventory({
        namespace: "tcgplayer.sku",
        value: "123",
        precision: "exact-variant",
      }),
    ).resolves.toBeUndefined();
    await expect(
      facet.publishExactInventory({
        exactIdentity: {
          namespace: "tcgplayer.sku",
          value: "123",
          precision: "exact-variant",
        },
        quantity: 2,
        price: { currency: "USD", minorUnits: 199 },
        idempotencyKey: "publication-1",
      }),
    ).resolves.toMatchObject({
      outcome: "applied",
      item: { quantity: 2, price: { currency: "USD", minorUnits: 199 } },
    });
    expect(client.setSellerInventoryByTcgplayerSkus).toHaveBeenCalledWith(
      [{ tcgplayerSku: 123, quantity: 2, priceCents: 199 }],
      undefined,
    );
  });

  it("requires review when ManaPool skips a publication", async () => {
    const client = fakeClient();
    vi.mocked(client.setSellerInventoryByTcgplayerSkus).mockResolvedValueOnce({
      inventory: [],
      skipped: [{ tcgplayerSku: 123, reason: "incomplete_new_inventory" }],
    });

    await expect(
      new ManaPoolInventoryFacet(client, "manapool-main").publishExactInventory(
        {
          exactIdentity: {
            namespace: "tcgplayer.sku",
            value: "123",
            precision: "exact-variant",
          },
          quantity: 2,
          price: { currency: "USD", minorUnits: 199 },
          idempotencyKey: "publication-2",
        },
      ),
    ).resolves.toEqual({
      outcome: "review-required",
      reasonCode: "incomplete_new_inventory",
    });
  });
});

function fakeClient(): ManaPoolInventoryClient {
  return {
    listSellerInventory: vi.fn(() =>
      Promise.resolve({
        inventory: [],
        pagination: {
          limit: 100,
          nextCursor: null,
          total: 0,
          returned: 0,
          offset: 0,
        },
      }),
    ),
    getSellerInventoryByTcgplayerSku: vi.fn(() => Promise.resolve(mutableItem)),
    updateSellerInventoryByTcgplayerSku: vi.fn(() =>
      Promise.resolve(mutableItem),
    ),
    setSellerInventoryByTcgplayerSkus: vi.fn(() =>
      Promise.resolve({ inventory: [mutableItem], skipped: [] }),
    ),
  };
}
