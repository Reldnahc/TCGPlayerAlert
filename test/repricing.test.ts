import { describe, expect, it, vi } from "vitest";
import type {
  MarketplaceListing,
  MarketplaceProduct,
} from "tcgplayer-private-api";
import {
  calculateRepricingRow,
  RepricingService,
  type RepricingRules,
} from "../src/repricing.js";

const sellerKey = "seller_test";

function listing(
  overrides: Partial<MarketplaceListing> = {},
): MarketplaceListing {
  return {
    listingId: 1,
    productId: 100,
    productConditionId: 1003,
    conditionId: 3,
    condition: "Moderately Played",
    channelId: 0,
    printing: "Normal",
    language: "English",
    languageId: 1,
    sellerKey,
    sellerName: "My Store",
    quantity: 2,
    price: 3,
    shippingPrice: 0,
    customData: {},
    ...overrides,
  };
}

function product(ownListing: MarketplaceListing): MarketplaceProduct {
  return {
    productId: ownListing.productId,
    productName: "Synthetic Card",
    productLineName: "Synthetic Game",
    setName: "Synthetic Set",
    rarityName: "Rare",
    marketPrice: 2.5,
    totalListings: 10,
    listings: [ownListing],
  };
}

const rules: RepricingRules = {
  minimumPrice: 0.5,
  conditionPolicy: "same-or-better",
  priceBasis: "delivered",
  adjustmentCents: 0,
  allowPriceIncreases: false,
};

describe("smart repricing", () => {
  it("lets a better-condition listing cap a worse-condition price", () => {
    const ownListing = listing();
    const competitor = listing({
      listingId: 2,
      productConditionId: 1002,
      conditionId: 2,
      condition: "Lightly Played",
      sellerKey: "competitor",
      sellerName: "Other Store",
      price: 2,
    });

    const row = calculateRepricingRow(
      { product: product(ownListing), listing: ownListing },
      [competitor],
      sellerKey,
      rules,
      "row-1",
    );

    expect(row).toMatchObject({
      status: "ready",
      currentPrice: 3,
      proposedPrice: 2,
      competitorCondition: "Lightly Played",
      minimumApplied: false,
    });
  });

  it("uses delivered price and never crosses the configured minimum", () => {
    const ownListing = listing({ shippingPrice: 0.99 });
    const competitor = listing({
      sellerKey: "competitor",
      price: 0.25,
      shippingPrice: 0.25,
    });
    const row = calculateRepricingRow(
      { product: product(ownListing), listing: ownListing },
      [competitor],
      sellerKey,
      { ...rules, minimumPrice: 1 },
      "row-2",
    );

    expect(row).toMatchObject({
      proposedPrice: 1,
      minimumApplied: true,
      status: "ready",
    });
  });

  it("does not raise an already-lower price unless explicitly enabled", () => {
    const ownListing = listing({ price: 1 });
    const competitor = listing({ sellerKey: "competitor", price: 2 });
    const row = calculateRepricingRow(
      { product: product(ownListing), listing: ownListing },
      [competitor],
      sellerKey,
      rules,
      "row-3",
    );

    expect(row).toMatchObject({
      proposedPrice: 1,
      status: "unchanged",
      queueable: false,
    });
  });

  it("builds a server-held preview and returns only selected safe updates", async () => {
    const ownListing = listing();
    const competitor = listing({
      listingId: 2,
      sellerKey: "competitor",
      price: 2,
    });
    const listSellerInventory = vi
      .fn()
      .mockResolvedValueOnce([product(ownListing)])
      .mockResolvedValueOnce([]);
    const searchMarketplaceProducts = vi.fn().mockResolvedValue({
      totalProducts: 1,
      products: [product(competitor)],
    });
    let nextId = 0;
    const service = new RepricingService({
      client: { listSellerInventory, searchMarketplaceProducts },
      sellerKey,
      now: () => new Date("2026-08-03T12:00:00.000Z"),
      id: () => `id-${String(++nextId)}`,
    });

    const preview = await service.preview(rules);
    const row = preview.rows[0];
    if (row === undefined) throw new Error("Missing preview row");
    const updates = service.takeUpdates(preview.id, { rowIds: [row.id] });

    expect(searchMarketplaceProducts).toHaveBeenCalledWith({
      productIds: [100],
      conditions: ["Near Mint", "Lightly Played", "Moderately Played"],
      printings: ["Normal"],
      languages: ["English"],
      channelId: 0,
      limit: 24,
    });
    expect(updates).toEqual([
      expect.objectContaining({
        productConditionId: 1003,
        quantity: 2,
        price: 2,
        reserveQuantity: 0,
      }),
    ]);
    expect(() => service.takeUpdates(preview.id, { rowIds: [row.id] })).toThrow(
      "Configuration is invalid",
    );
  });
});
