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

  it("uses Direct-channel listings as marketplace comparables", () => {
    const ownListing = listing({ price: 3, channelId: 0 });
    const directCompetitor = listing({
      listingId: 2,
      sellerKey: "direct-competitor",
      sellerName: "Direct Store",
      channelId: 1,
      price: 2,
    });

    const row = calculateRepricingRow(
      { product: product(ownListing), listing: ownListing },
      [directCompetitor],
      sellerKey,
      rules,
      "row-direct-comparable",
    );

    expect(row).toMatchObject({
      status: "ready",
      proposedPrice: 2,
      competitorPrice: 2,
      qualifyingListings: 1,
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

  it("prices from the cheapest band supported by distinct sellers", () => {
    const ownListing = listing({ price: 1, shippingPrice: 1.49 });
    const row = calculateRepricingRow(
      {
        product: { ...product(ownListing), marketPrice: 2.57 },
        listing: ownListing,
      },
      [
        listing({
          listingId: 2,
          sellerKey: "isolated",
          price: 0.56,
          shippingPrice: 1.49,
        }),
        listing({
          listingId: 3,
          sellerKey: "isolated",
          price: 0.57,
          shippingPrice: 1.49,
        }),
        listing({
          listingId: 4,
          sellerKey: "band-a",
          price: 0.75,
          shippingPrice: 1.49,
        }),
        listing({
          listingId: 5,
          sellerKey: "band-b",
          price: 0.76,
          shippingPrice: 1.49,
        }),
      ],
      sellerKey,
      {
        ...rules,
        ranges: [
          {
            minimumListings: 2,
            priceSource: "lowest",
            percentage: 100,
            gapThresholdPercent: 3,
            gapAction: "use-next",
            supportMode: "cluster",
            minimumSellerSupport: 2,
            supportWindowPercent: 5,
          },
        ],
      },
      "row-supported-band",
    );

    expect(row).toMatchObject({
      status: "ready",
      proposedPrice: 0.75,
      lowestPrice: 0.56,
      lowestSellerSupport: 1,
      distinctSellers: 3,
      supportedClusterPrice: 0.75,
      supportedClusterSellerCount: 2,
      pricingSource: "supported-cluster",
      gapActionApplied: "use-next",
    });
    expect(row.gapPercent).toBeCloseTo(9.27, 1);
    expect(row.reason).toContain("supported by 2 sellers");
  });

  it("follows the low when multiple sellers support its price band", () => {
    const ownListing = listing({ price: 1, shippingPrice: 1.49 });
    const row = calculateRepricingRow(
      { product: product(ownListing), listing: ownListing },
      [
        listing({
          listingId: 2,
          sellerKey: "low-a",
          price: 0.56,
          shippingPrice: 1.49,
        }),
        listing({
          listingId: 3,
          sellerKey: "low-b",
          price: 0.58,
          shippingPrice: 1.49,
        }),
      ],
      sellerKey,
      {
        ...rules,
        ranges: [
          {
            priceSource: "lowest",
            percentage: 100,
            gapThresholdPercent: 3,
            gapAction: "use-next",
            supportMode: "cluster",
            minimumSellerSupport: 2,
            supportWindowPercent: 5,
          },
        ],
      },
      "row-supported-low",
    );

    expect(row).toMatchObject({
      status: "ready",
      proposedPrice: 0.56,
      lowestSellerSupport: 2,
      supportedClusterPrice: 0.56,
      supportedClusterSellerCount: 2,
      pricingSource: "lowest",
    });
    expect(row.gapPercent).toBe(0);
    expect(row.gapActionApplied).toBeUndefined();
  });

  it("skips when no price band has enough distinct sellers", () => {
    const ownListing = listing({ price: 8 });
    const row = calculateRepricingRow(
      { product: product(ownListing), listing: ownListing },
      [
        listing({ listingId: 2, sellerKey: "seller-a", price: 2 }),
        listing({ listingId: 3, sellerKey: "seller-b", price: 4 }),
        listing({ listingId: 4, sellerKey: "seller-c", price: 7 }),
      ],
      sellerKey,
      {
        ...rules,
        ranges: [
          {
            priceSource: "lowest",
            percentage: 100,
            gapThresholdPercent: 3,
            gapAction: "use-next",
            supportMode: "cluster",
            minimumSellerSupport: 2,
            supportWindowPercent: 5,
          },
        ],
      },
      "row-no-band",
    );

    expect(row).toMatchObject({
      status: "skipped",
      proposedPrice: 8,
      lowestSellerSupport: 1,
      queueable: false,
    });
    expect(row.supportedClusterPrice).toBeUndefined();
    expect(row.reason).toContain("No price band within 5%");
  });

  it("uses the conservative higher-of-market-and-lowest fallback without a seller band", () => {
    const ownListing = listing({ price: 8 });
    const row = calculateRepricingRow(
      { product: product(ownListing), listing: ownListing },
      [
        listing({ listingId: 2, sellerKey: "seller-a", price: 2 }),
        listing({ listingId: 3, sellerKey: "seller-b", price: 4 }),
      ],
      sellerKey,
      {
        ...rules,
        sparseMarketFallback: "higher-of-market-and-lowest",
        ranges: [
          {
            minimumListings: 2,
            priceSource: "lowest",
            percentage: 100,
            gapThresholdPercent: 3,
            gapAction: "use-next",
            supportMode: "cluster",
            minimumSellerSupport: 2,
            supportWindowPercent: 5,
          },
        ],
      },
      "row-conservative-fallback",
    );

    expect(row).toMatchObject({
      status: "ready",
      proposedPrice: 2.5,
      pricingSource: "market",
      sparseMarketFallbackApplied: "higher-of-market-and-lowest",
      queueable: true,
    });
    expect(row.reason).toContain("higher of market and lowest fallback");
  });

  it("uses the Sell now lowest-first fallback and then market when needed", () => {
    const sellNowRules: RepricingRules = {
      ...rules,
      adjustmentCents: 1,
      allowPriceIncreases: true,
      sparseMarketFallback: "lowest-then-market",
      ranges: [
        {
          minimumListings: 0,
          priceSource: "lowest",
          percentage: 100,
          gapThresholdPercent: 0,
          gapAction: "follow-lowest",
          supportMode: "cluster",
          minimumSellerSupport: 1,
          supportWindowPercent: 5,
        },
      ],
    };
    const ownListing = listing({ price: 8 });
    const fromLowest = calculateRepricingRow(
      { product: product(ownListing), listing: ownListing },
      [listing({ sellerKey: "seller-a", price: 3, shippingPrice: 0 })],
      sellerKey,
      sellNowRules,
      "row-sell-now-lowest",
    );
    const fromMarket = calculateRepricingRow(
      { product: product(ownListing), listing: ownListing },
      [],
      sellerKey,
      sellNowRules,
      "row-sell-now-market",
    );

    expect(fromLowest).toMatchObject({
      proposedPrice: 2.99,
      pricingSource: "lowest",
      queueable: true,
    });
    expect(fromLowest.sparseMarketFallbackApplied).toBeUndefined();
    expect(fromMarket).toMatchObject({
      proposedPrice: 2.49,
      pricingSource: "market",
      sparseMarketFallbackApplied: "lowest-then-market",
      queueable: true,
    });
  });

  it("holds a high-value isolated low when the cluster rule says to skip", () => {
    const ownListing = listing({ price: 40 });
    const row = calculateRepricingRow(
      { product: product(ownListing), listing: ownListing },
      [
        listing({ listingId: 2, sellerKey: "isolated", price: 30 }),
        listing({ listingId: 3, sellerKey: "band-a", price: 32 }),
        listing({ listingId: 4, sellerKey: "band-b", price: 33 }),
      ],
      sellerKey,
      {
        ...rules,
        ranges: [
          {
            minimumListings: 3,
            priceSource: "lowest",
            percentage: 100,
            gapThresholdPercent: 3,
            gapAction: "skip",
            supportMode: "cluster",
            minimumSellerSupport: 2,
            supportWindowPercent: 5,
          },
        ],
      },
      "row-high-value-band",
    );

    expect(row).toMatchObject({
      status: "skipped",
      lowestSellerSupport: 1,
      supportedClusterPrice: 32,
      supportedClusterSellerCount: 2,
      gapActionApplied: "skip",
      queueable: false,
    });
    expect(row.reason).toContain("supported price band");
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
    const listSellerInventory = vi.fn(
      (input: { readonly channelId?: number }) =>
        Promise.resolve(input.channelId === 0 ? [product(ownListing)] : []),
    );
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

    expect(preview.totals).toEqual({
      listingCount: 1,
      totalQuantity: 2,
      currentListingValue: 6,
    });

    expect(searchMarketplaceProducts).toHaveBeenCalledWith({
      productIds: [100],
      conditions: [
        "Near Mint",
        "Lightly Played",
        "Moderately Played",
        "Heavily Played",
        "Damaged",
      ],
      printings: ["Normal"],
      languages: ["English"],
      channelId: 0,
      limit: 24,
    });
    expect(searchMarketplaceProducts).toHaveBeenCalledWith({
      productIds: [100],
      conditions: [
        "Near Mint",
        "Lightly Played",
        "Moderately Played",
        "Heavily Played",
        "Damaged",
      ],
      printings: ["Normal"],
      languages: ["English"],
      channelId: 1,
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

  it("reuses one marketplace snapshot across profile calculations", async () => {
    const ownListing = listing();
    const competitor = listing({
      listingId: 2,
      sellerKey: "competitor",
      price: 2,
    });
    const listSellerInventory = vi.fn(
      (input: { readonly channelId?: number }) =>
        Promise.resolve(input.channelId === 0 ? [product(ownListing)] : []),
    );
    const searchMarketplaceProducts = vi.fn().mockResolvedValue({
      totalProducts: 1,
      products: [product(competitor)],
    });
    const service = new RepricingService({
      client: { listSellerInventory, searchMarketplaceProducts },
      sellerKey,
      now: () => new Date("2026-08-05T12:00:00.000Z"),
    });

    const first = await service.preview(rules);
    const second = await service.preview({ ...rules, priceBasis: "item" });

    expect(first.marketplaceSnapshot).toMatchObject({ source: "fresh" });
    expect(second.marketplaceSnapshot).toEqual({
      ...first.marketplaceSnapshot,
      source: "cache",
    });
    expect(listSellerInventory).toHaveBeenCalledTimes(2);
    expect(searchMarketplaceProducts).toHaveBeenCalledTimes(2);

    const row = second.rows[0];
    if (row === undefined) throw new Error("Missing cached preview row");
    service.takeUpdates(second.id, { rowIds: [row.id] });
    const afterQueue = await service.preview(rules);

    expect(afterQueue.marketplaceSnapshot.source).toBe("fresh");
    expect(listSellerInventory).toHaveBeenCalledTimes(4);
    expect(searchMarketplaceProducts).toHaveBeenCalledTimes(4);
  });

  it("reloads an expired or explicitly refreshed marketplace snapshot", async () => {
    const ownListing = listing();
    const competitor = listing({
      listingId: 2,
      sellerKey: "competitor",
      price: 2,
    });
    const listSellerInventory = vi
      .fn()
      .mockResolvedValueOnce([product(ownListing)])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([product(ownListing)])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([product(ownListing)])
      .mockResolvedValueOnce([]);
    const searchMarketplaceProducts = vi.fn().mockResolvedValue({
      totalProducts: 1,
      products: [product(competitor)],
    });
    let now = new Date("2026-08-05T12:00:00.000Z");
    const service = new RepricingService({
      client: { listSellerInventory, searchMarketplaceProducts },
      sellerKey,
      now: () => now,
      marketplaceCacheLifetimeMs: 180_000,
    });

    await service.preview(rules);
    now = new Date("2026-08-05T12:03:01.000Z");
    const expired = await service.preview(rules);
    const forced = await service.preview(rules, { forceRefresh: true });

    expect(expired.marketplaceSnapshot.source).toBe("fresh");
    expect(forced.marketplaceSnapshot.source).toBe("fresh");
    expect(listSellerInventory).toHaveBeenCalledTimes(6);
    expect(searchMarketplaceProducts).toHaveBeenCalledTimes(6);
  });

  it("coalesces simultaneous marketplace snapshot loads", async () => {
    const ownListing = listing();
    const competitor = listing({
      listingId: 2,
      sellerKey: "competitor",
      price: 2,
    });
    let releaseInventory: (() => void) | undefined;
    const inventoryGate = new Promise<void>((resolve) => {
      releaseInventory = resolve;
    });
    const listSellerInventory = vi.fn(
      async (input: { readonly channelId?: number }) => {
        await inventoryGate;
        return input.channelId === 0 ? [product(ownListing)] : [];
      },
    );
    const searchMarketplaceProducts = vi.fn().mockResolvedValue({
      totalProducts: 1,
      products: [product(competitor)],
    });
    const service = new RepricingService({
      client: { listSellerInventory, searchMarketplaceProducts },
      sellerKey,
      now: () => new Date("2026-08-05T12:00:00.000Z"),
    });

    const firstPromise = service.preview(rules);
    const secondPromise = service.preview(rules);
    releaseInventory?.();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect([
      first.marketplaceSnapshot.source,
      second.marketplaceSnapshot.source,
    ]).toEqual(["fresh", "shared"]);
    expect(listSellerInventory).toHaveBeenCalledTimes(2);
    expect(searchMarketplaceProducts).toHaveBeenCalledTimes(2);
  });
});
