import { describe, expect, it, vi } from "vitest";
import type {
  MarketplaceListing,
  MarketplaceProduct,
} from "tcgplayer-private-api";
import {
  calculateRepricingRow,
  parseRepricingRules,
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
  ranges: [
    {
      priceSource: "lowest",
      percentage: 100,
      gapThresholdPercent: 0,
      gapAction: "follow-lowest",
    },
  ],
};

describe("smart repricing", () => {
  it("rejects invalid or non-open-ended pricing ranges", () => {
    const range = rules.ranges[0];
    if (range === undefined) throw new Error("Missing default repricing range");
    expect(() =>
      parseRepricingRules({
        ...rules,
        ranges: [{ ...range, maximumPrice: 5 }],
      }),
    ).toThrow("Configuration is invalid");
  });

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

  it("prices a range as a percentage of market price", () => {
    const ownListing = listing({ price: 5 });
    const competitor = listing({ sellerKey: "competitor", price: 4 });
    const row = calculateRepricingRow(
      {
        product: { ...product(ownListing), marketPrice: 3 },
        listing: ownListing,
      },
      [competitor],
      sellerKey,
      {
        ...rules,
        ranges: [
          {
            priceSource: "market",
            percentage: 90,
            gapThresholdPercent: 0,
            gapAction: "follow-lowest",
          },
        ],
      },
      "row-market",
    );

    expect(row).toMatchObject({
      status: "ready",
      proposedPrice: 2.7,
      marketPrice: 3,
      pricingSource: "market",
      pricingPercentage: 90,
    });
  });

  it("can price from market when no competing listing exists", () => {
    const ownListing = listing({ price: 5 });
    const row = calculateRepricingRow(
      {
        product: { ...product(ownListing), marketPrice: 4 },
        listing: ownListing,
      },
      [],
      sellerKey,
      {
        ...rules,
        ranges: [
          {
            priceSource: "market",
            percentage: 95,
            gapThresholdPercent: 25,
            gapAction: "skip",
          },
        ],
      },
      "row-market-only",
    );

    expect(row).toMatchObject({
      status: "ready",
      proposedPrice: 3.8,
      marketPrice: 4,
      pricingSource: "market",
    });
  });

  it("selects the value range from the exact lowest comparable before product market", () => {
    const ownListing = listing({ price: 8 });
    const competitor = listing({ sellerKey: "competitor", price: 6 });
    const row = calculateRepricingRow(
      {
        product: { ...product(ownListing), marketPrice: 3 },
        listing: ownListing,
      },
      [competitor],
      sellerKey,
      {
        ...rules,
        ranges: [
          {
            maximumPrice: 5,
            priceSource: "market",
            percentage: 80,
            gapThresholdPercent: 25,
            gapAction: "follow-lowest",
          },
          {
            priceSource: "lowest",
            percentage: 100,
            gapThresholdPercent: 25,
            gapAction: "follow-lowest",
          },
        ],
      },
      "row-range",
    );

    expect(row).toMatchObject({
      proposedPrice: 6,
      pricingSource: "lowest",
      pricingPercentage: 100,
    });
    expect(row.rangeMaximumPrice).toBeUndefined();
  });

  it("skips a value tier that does not have enough qualifying comparables", () => {
    const ownListing = listing({ price: 40 });
    const onlyCompetitor = listing({ sellerKey: "competitor", price: 30 });
    const row = calculateRepricingRow(
      { product: product(ownListing), listing: ownListing },
      [onlyCompetitor],
      sellerKey,
      {
        ...rules,
        ranges: [
          {
            minimumListings: 3,
            priceSource: "lowest",
            percentage: 100,
            gapThresholdPercent: 20,
            gapAction: "skip",
          },
        ],
      },
      "row-thin-market",
    );

    expect(row).toMatchObject({
      status: "skipped",
      proposedPrice: 40,
      qualifyingListings: 1,
      minimumQualifyingListings: 3,
      queueable: false,
    });
    expect(row.reason).toContain("requires at least 3");
  });

  it("waits out a separated lowest listing by pricing from the next listing", () => {
    const ownListing = listing({ price: 6 });
    const lowest = listing({ listingId: 2, sellerKey: "low", price: 2 });
    const next = listing({ listingId: 3, sellerKey: "next", price: 4 });
    const row = calculateRepricingRow(
      { product: product(ownListing), listing: ownListing },
      [next, lowest],
      sellerKey,
      {
        ...rules,
        ranges: [
          {
            priceSource: "lowest",
            percentage: 100,
            gapThresholdPercent: 50,
            gapAction: "use-next",
          },
        ],
      },
      "row-gap-next",
    );

    expect(row).toMatchObject({
      status: "ready",
      proposedPrice: 4,
      lowestPrice: 2,
      nextLowestPrice: 4,
      gapPercent: 100,
      gapActionApplied: "use-next",
      pricingSource: "next-lowest",
    });
  });

  it("applies gap thresholds proportionally at ordinary card prices", () => {
    const proportionalRules: RepricingRules = {
      ...rules,
      ranges: [
        {
          minimumListings: 2,
          priceSource: "lowest",
          percentage: 100,
          gapThresholdPercent: 10,
          gapAction: "use-next",
        },
      ],
    };
    const scenarios = [
      { low: 2, next: 2.2, expected: 2.2 },
      { low: 5, next: 5.5, expected: 5.5 },
      { low: 5, next: 5.49, expected: 5 },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      const ownListing = listing({ price: 8 });
      const row = calculateRepricingRow(
        { product: product(ownListing), listing: ownListing },
        [
          listing({
            listingId: 10 + index * 2,
            sellerKey: `low-${String(index)}`,
            price: scenario.low,
          }),
          listing({
            listingId: 11 + index * 2,
            sellerKey: `next-${String(index)}`,
            price: scenario.next,
          }),
        ],
        sellerKey,
        proportionalRules,
        `row-proportional-${String(index)}`,
      );

      expect(row.proposedPrice).toBe(scenario.expected);
    }
  });

  it("skips a separated lowest listing when the range says to wait", () => {
    const ownListing = listing({ price: 6 });
    const lowest = listing({ listingId: 2, sellerKey: "low", price: 2 });
    const next = listing({ listingId: 3, sellerKey: "next", price: 4 });
    const row = calculateRepricingRow(
      { product: product(ownListing), listing: ownListing },
      [lowest, next],
      sellerKey,
      {
        ...rules,
        ranges: [
          {
            priceSource: "lowest",
            percentage: 100,
            gapThresholdPercent: 50,
            gapAction: "skip",
          },
        ],
      },
      "row-gap-skip",
    );

    expect(row).toMatchObject({
      status: "skipped",
      proposedPrice: 6,
      gapPercent: 100,
      gapActionApplied: "skip",
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
