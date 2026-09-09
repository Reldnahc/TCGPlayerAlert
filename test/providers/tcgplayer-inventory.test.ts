import { describe, expect, it, vi } from "vitest";
import type {
  MarketplaceListing,
  MarketplaceProduct,
} from "tcgplayer-private-api";
import {
  TcgplayerInventoryFacet,
  type TcgplayerInventoryClient,
} from "../../src/providers/tcgplayer/inventory.js";

describe("TCGplayer inventory facet", () => {
  it("isolates opaque page snapshots across overlapping reads", async () => {
    const client = fakeClient();
    vi.mocked(client.listSellerInventory)
      .mockResolvedValueOnce([product(1, [listing(101, 2)])])
      .mockResolvedValueOnce([product(2, [listing(102, 3)])])
      .mockResolvedValueOnce([product(3, [listing(103, 4)])])
      .mockResolvedValueOnce([]);
    const facet = new TcgplayerInventoryFacet(
      client,
      () => "seller-key",
      "tcgplayer-main",
      10,
    );

    const firstA = await facet.readInventoryPage({ pageSize: 1 });
    const firstB = await facet.readInventoryPage({ pageSize: 1 });
    if (firstA.nextCursor === undefined) {
      throw new Error("Expected a second page in the first snapshot.");
    }
    const secondA = await facet.readInventoryPage({
      pageSize: 1,
      cursor: firstA.nextCursor,
    });

    expect(firstA.items[0]?.inventoryKey).toBe("sku/101/channel/0");
    expect(firstB.items[0]?.inventoryKey).toBe("sku/103/channel/0");
    expect(secondA.items[0]?.inventoryKey).toBe("sku/102/channel/0");
    expect(firstA.nextCursor).toMatch(/^snapshot\/.+\/offset\/1$/u);
    expect(client.listSellerInventory).toHaveBeenCalledTimes(4);
  });

  it("normalizes custom listings as read-only", async () => {
    const client = fakeClient();
    vi.mocked(client.listSellerInventory)
      .mockResolvedValueOnce([
        product(1, [listing(101, 2, { customListingId: 9 })]),
      ])
      .mockResolvedValueOnce([]);
    const page = await new TcgplayerInventoryFacet(
      client,
      () => "seller-key",
      "tcgplayer-main",
      10,
    ).readInventoryPage({ pageSize: 10 });

    expect(page.items[0]).toMatchObject({
      quantityMutation: "unavailable",
      priceMutable: false,
    });
  });

  it("omits unavailable product metadata instead of rejecting the inventory", async () => {
    const client = fakeClient();
    vi.mocked(client.listSellerInventory)
      .mockResolvedValueOnce([
        {
          ...product(1, [listing(101, 2)]),
          rarityName: "",
        },
      ])
      .mockResolvedValueOnce([]);

    const page = await new TcgplayerInventoryFacet(
      client,
      () => "seller-key",
      "tcgplayer-main",
      10,
    ).readInventoryPage({ pageSize: 10 });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.attributes).toMatchObject({
      productLine: "Magic: The Gathering",
      set: "Synthetic Set",
      condition: "Near Mint",
      printing: "Normal",
      language: "English",
      channel: "Marketplace",
    });
    expect(page.items[0]?.attributes).not.toHaveProperty("rarity");
  });

  it("re-reads state and submits only the safe quantity increase", async () => {
    const client = fakeClient();
    vi.mocked(client.listSellerInventory)
      .mockResolvedValueOnce([product(1, [listing(101, 2)])])
      .mockResolvedValueOnce([]);
    const outcome = await new TcgplayerInventoryFacet(
      client,
      () => "seller-key",
      "tcgplayer-main",
      10,
    ).updateInventory({
      inventoryKey: "sku/101/channel/0",
      quantity: 5,
      price: { currency: "USD", minorUnits: 225 },
      idempotencyKey: "mutation-1",
    });

    expect(outcome).toBe("applied");
    expect(client.addSellerInventory).toHaveBeenCalledWith(
      {
        additions: [
          expect.objectContaining({
            productConditionId: 101,
            currentQuantity: 2,
            addQuantity: 3,
            price: 2.25,
          }),
        ],
      },
      undefined,
    );
    expect(client.updateSellerPrices).not.toHaveBeenCalled();
  });

  it("rejects partial decreases without calling a mutation endpoint", async () => {
    const client = fakeClient();
    vi.mocked(client.listSellerInventory)
      .mockResolvedValueOnce([product(1, [listing(101, 5)])])
      .mockResolvedValueOnce([]);
    await expect(
      new TcgplayerInventoryFacet(
        client,
        () => "seller-key",
        "tcgplayer-main",
        10,
      ).updateInventory({
        inventoryKey: "sku/101/channel/0",
        quantity: 3,
        idempotencyKey: "mutation-2",
      }),
    ).rejects.toThrow("not partially decreased");
    expect(client.removeSellerInventory).not.toHaveBeenCalled();
  });
});

function fakeClient(): TcgplayerInventoryClient {
  return {
    listSellerInventory: vi.fn(() => Promise.resolve([])),
    updateSellerPrices: vi.fn(() =>
      Promise.resolve({ submittedProductConditionIds: [101] }),
    ),
    addSellerInventory: vi.fn(() =>
      Promise.resolve({ submittedProductConditionIds: [101] }),
    ),
    removeSellerInventory: vi.fn(() =>
      Promise.resolve({ submittedProductConditionIds: [101] }),
    ),
  };
}

function product(
  productId: number,
  listings: readonly MarketplaceListing[],
): MarketplaceProduct {
  return {
    productId,
    productName: `Product ${String(productId)}`,
    productLineName: "Magic: The Gathering",
    setName: "Synthetic Set",
    rarityName: "Rare",
    marketPrice: 2,
    totalListings: listings.length,
    listings,
  };
}

function listing(
  productConditionId: number,
  quantity: number,
  customData: MarketplaceListing["customData"] = {},
): MarketplaceListing {
  return {
    listingId: productConditionId + 1_000,
    productId: productConditionId,
    productConditionId,
    conditionId: 1,
    condition: "Near Mint",
    channelId: 0,
    printing: "Normal",
    language: "English",
    languageId: 1,
    sellerKey: "seller-key",
    sellerName: "Synthetic Seller",
    quantity,
    price: 2,
    shippingPrice: 1.49,
    customData,
  };
}
