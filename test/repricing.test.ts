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

  it("applies a Magic rarity floor from the selected pricing profile", () => {
    const ownListing = listing({ price: 1 });
    const competitor = listing({
      listingId: 2,
      sellerKey: "competitor",
      sellerName: "Other Store",
      price: 0.4,
    });
    const magicProduct = {
      ...product(ownListing),
      productLineName: "Magic: The Gathering",
      rarityName: "Rare",
    };

    const row = calculateRepricingRow(
      { product: magicProduct, listing: ownListing },
      [competitor],
      sellerKey,
      {
        ...rules,
        gamePricingModules: [
          {
            type: "magic-rarity-floor",
            enabled: true,
            floors: [{ rarity: "Rare", minimumPrice: 0.75 }],
          },
        ],
      },
      "magic-rare",
    );

    expect(row).toMatchObject({
      proposedPrice: 0.75,
      effectiveMinimumPrice: 0.75,
      minimumPriceSource: "Magic Rare",
      minimumApplied: true,
      status: "ready",
      queueable: true,
    });
    expect(row.reason).toContain("Magic Rare minimum of $0.75");
  });

  it("ignores channel-1 records with incomplete Direct evidence", () => {
    const ownListing = listing({ price: 3, channelId: 0 });
    const marketplaceCompetitor = listing({
      listingId: 2,
      sellerKey: "marketplace-competitor",
      price: 2.5,
    });
    const directCompetitor = listing({
      listingId: 3,
      sellerKey: "direct-competitor",
      sellerName: "Direct Store",
      channelId: 1,
      directListing: true,
      price: 2,
    });

    const row = calculateRepricingRow(
      { product: product(ownListing), listing: ownListing },
      [directCompetitor, marketplaceCompetitor],
      sellerKey,
      rules,
      "row-ignore-direct",
    );

    expect(row).toMatchObject({
      status: "ready",
      proposedPrice: 2.5,
      competitorPrice: 2.5,
      qualifyingListings: 1,
    });
  });

  it("uses channel-1 records only when every Direct availability signal is present", () => {
    const ownListing = listing({ price: 3, channelId: 0 });
    const directCompetitor = listing({
      listingId: 2,
      sellerKey: "verified-direct-competitor",
      sellerName: "Verified Direct Store",
      channelId: 1,
      directListing: true,
      directInventory: 12,
      directProduct: true,
      directSeller: true,
      listingType: "standard",
      sellerPrograms: ["Direct", "DirectViewable"],
      price: 2,
      shippingPrice: 0.5,
    });

    const row = calculateRepricingRow(
      { product: product(ownListing), listing: ownListing },
      [directCompetitor],
      sellerKey,
      rules,
      "row-verified-direct",
    );

    expect(row).toMatchObject({
      status: "ready",
      proposedPrice: 2.5,
      competitorPrice: 2,
      competitorShipping: 0.5,
      qualifyingListings: 1,
    });
  });

  it.each([
    ["Direct listing flag is false", { directListing: false }],
    ["Direct product flag is false", { directProduct: false }],
    ["Direct seller flag is false", { directSeller: false }],
    ["Direct inventory is zero", { directInventory: 0 }],
    ["listing type is not standard", { listingType: "custom" }],
    ["DirectViewable is absent", { sellerPrograms: ["Direct"] }],
  ] satisfies readonly [string, Partial<MarketplaceListing>][])(
    "rejects channel-1 evidence when the %s",
    (_description, invalidEvidence) => {
      const ownListing = listing({ price: 3, channelId: 0 });
      const marketplaceCompetitor = listing({
        listingId: 2,
        sellerKey: "marketplace-competitor",
        price: 2.5,
      });
      const directCompetitor = listing({
        listingId: 3,
        sellerKey: "unverified-direct-competitor",
        channelId: 1,
        directListing: true,
        directInventory: 12,
        directProduct: true,
        directSeller: true,
        listingType: "standard",
        sellerPrograms: ["Direct", "DirectViewable"],
        price: 1,
        ...invalidEvidence,
      });

      const row = calculateRepricingRow(
        { product: product(ownListing), listing: ownListing },
        [directCompetitor, marketplaceCompetitor],
        sellerKey,
        rules,
        "row-invalid-direct-evidence",
      );

      expect(row).toMatchObject({
        proposedPrice: 2.5,
        competitorPrice: 2.5,
        qualifyingListings: 1,
      });
    },
  );

  it("ignores channel-1 records without relying on Direct eligibility flags", () => {
    const ownListing = listing({
      conditionId: 2,
      condition: "Lightly Played",
      price: 40,
      shippingPrice: 0,
    });
    const marketplaceCompetitor = listing({
      listingId: 2,
      productConditionId: ownListing.productConditionId,
      conditionId: 2,
      condition: "Lightly Played",
      sellerKey: "marketplace-competitor",
      price: 42.19,
      shippingPrice: 0.99,
    });
    const phantomDirectRecord = listing({
      listingId: 3,
      productConditionId: ownListing.productConditionId,
      conditionId: 2,
      condition: "Lightly Played",
      sellerKey: "channel-record",
      channelId: 1,
      directListing: false,
      price: 0.5,
      shippingPrice: 1.49,
    });

    const row = calculateRepricingRow(
      { product: product(ownListing), listing: ownListing },
      [phantomDirectRecord, marketplaceCompetitor],
      sellerKey,
      {
        ...rules,
        priceBasis: "delivered",
        adjustmentCents: 1,
        allowPriceIncreases: true,
      },
      "row-phantom-direct",
    );

    expect(row).toMatchObject({
      status: "ready",
      proposedPrice: 43.17,
      lowestPrice: 42.19,
      lowestShipping: 0.99,
      competitorPrice: 42.19,
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

  it("preserves seller shipping above the marketplace minimum", () => {
    const ownListing = listing({
      conditionId: 2,
      condition: "Lightly Played",
      price: 0.47,
      shippingPrice: 1.49,
    });
    const competitors = [
      listing({
        listingId: 2,
        conditionId: 2,
        condition: "Lightly Played",
        sellerKey: "competitor-a",
        sellerName: "Store A",
        price: 1.21,
        shippingPrice: 3.99,
      }),
      listing({
        listingId: 3,
        conditionId: 2,
        condition: "Lightly Played",
        sellerKey: "competitor-b",
        sellerName: "Store B",
        price: 1.23,
        shippingPrice: 3.99,
      }),
    ];

    const row = calculateRepricingRow(
      { product: product(ownListing), listing: ownListing },
      competitors,
      sellerKey,
      {
        ...rules,
        adjustmentCents: 1,
        allowPriceIncreases: true,
        ranges: [
          {
            priceSource: "lowest",
            percentage: 100,
            gapThresholdPercent: 100,
            gapAction: "follow-lowest",
            supportMode: "cluster",
            minimumSellerSupport: 2,
            supportWindowPercent: 5,
          },
        ],
      },
      "row-normalized-shipping",
    );

    expect(row).toMatchObject({
      status: "ready",
      proposedPrice: 3.7,
      lowestPrice: 1.21,
      lowestShipping: 3.99,
      competitorPrice: 1.21,
      competitorShipping: 3.99,
      lowestSellerSupport: 2,
      qualifyingListings: 2,
    });
    expect(row.competitorPricingShipping).toBeUndefined();
    expect(row.reason).not.toContain("shipping is normalized");

    const itemPriceRow = calculateRepricingRow(
      { product: product(ownListing), listing: ownListing },
      competitors,
      sellerKey,
      {
        ...rules,
        priceBasis: "item",
        adjustmentCents: 1,
        allowPriceIncreases: true,
      },
      "row-item-price-shipping",
    );
    expect(itemPriceRow).toMatchObject({
      proposedPrice: 1.2,
      competitorPrice: 1.21,
      competitorShipping: 3.99,
    });
    expect(itemPriceRow.competitorPricingShipping).toBeUndefined();
    expect(itemPriceRow.reason).not.toContain("shipping is normalized");
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
      gapActionApplied: "use-next",
      pricingSource: "next-lowest",
    });
    expect(row.gapPercent).toBeCloseTo(57.31, 2);
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

  it("does not lower an existing listing from market price when seller details remain truncated", () => {
    const ownListing = listing({ price: 70 });
    const row = calculateRepricingRow(
      { product: product(ownListing), listing: ownListing },
      [],
      sellerKey,
      {
        ...rules,
        sparseMarketFallback: "higher-of-market-and-lowest",
        ranges: [
          {
            minimumListings: 3,
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
      "row-incomplete-market-fallback",
      { reportedQualifyingListings: 8, incomplete: true },
    );

    expect(row).toMatchObject({
      status: "skipped",
      proposedPrice: 70,
      qualifyingListings: 8,
      comparisonSampleIncomplete: true,
      queueable: false,
    });
    expect(row.reason).toContain("did not return enough seller details");
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

  it("applies gap thresholds to normalized delivered prices", () => {
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
      { low: 2, next: 2.2, expected: 2 },
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
      gapActionApplied: "skip",
      queueable: false,
    });
    expect(row.gapPercent).toBeCloseTo(57.31, 2);
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
    const searchMarketplaceProductListings = vi.fn();
    let nextId = 0;
    const service = new RepricingService({
      client: {
        listSellerInventory,
        searchMarketplaceProducts,
        searchMarketplaceProductListings,
      },
      sellerKey,
      now: () => new Date("2026-08-03T12:00:00.000Z"),
      id: () => `id-${String(++nextId)}`,
    });

    const preview = await service.preview(rules);
    const row = preview.rows[0];
    if (row === undefined) throw new Error("Missing preview row");
    const removal = service.takeRemoval(preview.id, row.id);
    const updates = service.takeUpdates(preview.id, { rowIds: [row.id] });

    expect(preview.totals).toEqual({
      listingCount: 1,
      totalQuantity: 2,
      currentListingValue: 6,
    });

    expect(searchMarketplaceProducts).toHaveBeenCalledWith({
      productIds: [100],
      conditions: ["Near Mint", "Lightly Played", "Moderately Played"],
      printings: ["Normal"],
      languages: ["English"],
      channelId: 0,
      limit: 24,
    });
    expect(searchMarketplaceProducts).toHaveBeenCalledWith({
      productIds: [100],
      conditions: ["Near Mint", "Lightly Played", "Moderately Played"],
      printings: ["Normal"],
      languages: ["English"],
      channelId: 1,
      limit: 24,
    });
    expect(searchMarketplaceProducts).toHaveBeenCalledTimes(2);
    expect(searchMarketplaceProductListings).not.toHaveBeenCalled();
    expect(updates).toEqual([
      expect.objectContaining({
        productConditionId: 1003,
        quantity: 2,
        price: 2,
        reserveQuantity: 0,
      }),
    ]);
    expect(row).toMatchObject({ removable: true });
    expect(removal).toEqual(
      expect.objectContaining({
        productConditionId: 1003,
        currentQuantity: 2,
        price: 3,
        reserveQuantity: 0,
      }),
    );
    expect(() => service.takeUpdates(preview.id, { rowIds: [row.id] })).toThrow(
      "Configuration is invalid",
    );
  });

  it("uses one exact listing page when a batch price depends on high shipping", async () => {
    const ownListing = listing({
      productId: 212043,
      productConditionId: 2120432,
      conditionId: 2,
      condition: "Lightly Played",
      price: 0.47,
      shippingPrice: 1.49,
    });
    const ownProduct = {
      ...product(ownListing),
      productName: "Synthetic Showcase Card",
      marketPrice: 1.21,
    };
    const highShippingSpotlight = listing({
      listingId: 2,
      productId: 212043,
      productConditionId: 2120431,
      conditionId: 1,
      condition: "Near Mint",
      listingType: "standard",
      sellerKey: "spotlight-seller",
      price: 1.44,
      shippingPrice: 3.99,
    });
    const actualLow = listing({
      listingId: 3,
      productId: 212043,
      productConditionId: 2120431,
      conditionId: 1,
      condition: "Near Mint",
      listingType: "standard",
      sellerKey: "actual-low-seller",
      price: 0.87,
      shippingPrice: 1.49,
    });
    const secondLow = listing({
      listingId: 4,
      productId: 212043,
      productConditionId: 2120432,
      conditionId: 2,
      condition: "Lightly Played",
      listingType: "standard",
      sellerKey: "second-low-seller",
      price: 0.99,
      shippingPrice: 1.49,
    });
    const searchMarketplaceProducts = vi.fn(
      ({ channelId }: { readonly channelId?: number }) =>
        Promise.resolve(
          channelId === 0
            ? {
                totalProducts: 1,
                products: [
                  {
                    ...ownProduct,
                    totalListings: 113,
                    listings: [ownListing, highShippingSpotlight],
                  },
                ],
              }
            : { totalProducts: 0, products: [] },
        ),
    );
    const searchMarketplaceProductListings = vi.fn().mockResolvedValue({
      productId: 212043,
      totalListings: 2,
      listings: [actualLow, secondLow],
    });
    const service = new RepricingService({
      client: {
        listSellerInventory: ({ channelId }) =>
          Promise.resolve(channelId === 0 ? [ownProduct] : []),
        searchMarketplaceProducts,
        searchMarketplaceProductListings,
      },
      sellerKey,
      now: () => new Date("2026-08-07T05:00:00.000Z"),
    });
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

    const first = await service.preview(sellNowRules);
    const second = await service.preview(sellNowRules);

    expect(first.rows[0]).toMatchObject({
      competitorPrice: 0.87,
      competitorShipping: 1.49,
      proposedPrice: 0.86,
      qualifyingListings: 2,
      comparisonSource: "exact",
      status: "ready",
    });
    expect(first.rows[0]?.reason).toContain("Exact listing verification");
    expect(searchMarketplaceProducts).toHaveBeenCalledTimes(2);
    expect(searchMarketplaceProductListings).toHaveBeenCalledTimes(1);
    expect(searchMarketplaceProductListings).toHaveBeenCalledWith({
      productId: 212043,
      conditions: ["Near Mint", "Lightly Played"],
      printings: ["Normal"],
      languages: ["English"],
      channelIds: [0, 1],
      listingTypes: ["standard"],
      offset: 0,
      limit: 50,
      sort: "price+shipping",
    });
    expect(second.marketplaceSnapshot.source).toBe("cache");
    expect(searchMarketplaceProductListings).toHaveBeenCalledTimes(1);
  });

  it("does not queue a high-shipping batch reference when exact verification fails", async () => {
    const ownListing = listing({
      conditionId: 2,
      condition: "Lightly Played",
      price: 0.47,
      shippingPrice: 1.49,
    });
    const highShippingSpotlight = listing({
      listingId: 2,
      productConditionId: ownListing.productConditionId,
      conditionId: 2,
      condition: "Lightly Played",
      listingType: "standard",
      sellerKey: "spotlight-seller",
      price: 1.21,
      shippingPrice: 3.99,
    });
    const searchMarketplaceProductListings = vi
      .fn()
      .mockRejectedValue(new Error("Synthetic exact-listing failure"));
    const service = new RepricingService({
      client: {
        listSellerInventory: ({ channelId }) =>
          Promise.resolve(channelId === 0 ? [product(ownListing)] : []),
        searchMarketplaceProducts: ({ channelId }) =>
          Promise.resolve(
            channelId === 0
              ? {
                  totalProducts: 1,
                  products: [product(highShippingSpotlight)],
                }
              : { totalProducts: 0, products: [] },
          ),
        searchMarketplaceProductListings,
      },
      sellerKey,
    });

    const first = await service.preview({
      ...rules,
      adjustmentCents: 1,
      allowPriceIncreases: true,
    });
    const second = await service.preview({
      ...rules,
      adjustmentCents: 1,
      allowPriceIncreases: true,
    });
    const row = first.rows[0];
    if (row === undefined) throw new Error("Missing preview row");

    expect(row).toMatchObject({
      proposedPrice: 0.47,
      status: "skipped",
      queueable: false,
    });
    expect(row.reason).toContain("Exact marketplace verification failed");
    expect(() => service.takeUpdates(first.id, { rowIds: [row.id] })).toThrow(
      "Configuration is invalid",
    );
    expect(second.rows[0]?.status).toBe("skipped");
    expect(searchMarketplaceProductListings).toHaveBeenCalledTimes(1);
  });

  it("converts more than 1,000 selected preview rows into one queueable batch", async () => {
    const ownProducts = Array.from({ length: 1200 }, (_, index) => {
      const ownListing = listing({
        listingId: 1000 + index,
        productId: 2000 + index,
        productConditionId: 20_000 + index,
        quantity: 1,
        price: 3,
      });
      return {
        ...product(ownListing),
        productName: `Synthetic Card ${String(index + 1)}`,
        totalListings: 1,
      };
    });
    const productsById = new Map(
      ownProducts.map((candidate) => [candidate.productId, candidate]),
    );
    const service = new RepricingService({
      client: {
        listSellerInventory: (input) =>
          Promise.resolve(input.channelId === 0 ? ownProducts : []),
        searchMarketplaceProducts: (input) => {
          const products = (input.productIds ?? []).flatMap((productId) => {
            const ownProduct = productsById.get(productId);
            if (ownProduct === undefined) return [];
            const competitor = listing({
              listingId: 50_000 + productId,
              productId,
              productConditionId:
                ownProduct.listings[0]?.productConditionId ?? productId,
              sellerKey: `competitor-${String(productId)}`,
              sellerName: "Synthetic Competitor",
              quantity: 1,
              price: 2,
            });
            return [{ ...ownProduct, listings: [competitor] }];
          });
          return Promise.resolve({
            totalProducts: products.length,
            products,
          });
        },
      },
      sellerKey,
      now: () => new Date("2026-08-05T12:00:00.000Z"),
    });

    const preview = await service.preview(rules);
    const updates = service.takeUpdates(preview.id, {
      rowIds: preview.rows.map((row) => row.id),
    });

    expect(preview.rows).toHaveLength(1200);
    expect(preview.counts.ready).toBe(1200);
    expect(updates).toHaveLength(1200);
  });

  it("does not offer automatic removal when the SKU has secondary inventory", async () => {
    const ownListing = listing();
    const secondaryListing = listing({ channelId: 1, quantity: 1 });
    const competitor = listing({
      listingId: 2,
      sellerKey: "competitor",
      price: 2,
    });
    const service = new RepricingService({
      client: {
        listSellerInventory: (input: { readonly channelId?: number }) =>
          Promise.resolve([
            product(input.channelId === 1 ? secondaryListing : ownListing),
          ]),
        searchMarketplaceProducts: () =>
          Promise.resolve({
            totalProducts: 1,
            products: [product(competitor)],
          }),
      },
      sellerKey,
      now: () => new Date("2026-08-03T12:00:00.000Z"),
      id: () => "synthetic-id",
    });

    const preview = await service.preview(rules);
    const row = preview.rows[0];
    if (row === undefined) throw new Error("Missing preview row");

    expect(row).toMatchObject({
      removable: false,
      removalReason: "This SKU also has secondary-channel inventory.",
    });
    expect(() => service.takeRemoval(preview.id, row.id)).toThrow(
      "Configuration is invalid",
    );
  });

  it("recovers exact-condition listings when the broad marketplace sample is truncated", async () => {
    const ownListing = listing({
      productId: 111645,
      productConditionId: 1116451,
      conditionId: 1,
      condition: "Near Mint",
      printing: "Foil",
      quantity: 1,
      price: 70,
    });
    const ownProduct: MarketplaceProduct = {
      ...product(ownListing),
      productName: "Rishadan Port",
      productLineName: "Magic: The Gathering",
      setName: "Judge Promos",
      marketPrice: 24.1,
      totalListings: 9,
    };
    const broadListings = [
      listing({
        listingId: 20,
        productId: 111645,
        productConditionId: 1116455,
        conditionId: 5,
        condition: "Damaged",
        printing: "Foil",
        sellerKey: "damaged-seller",
        price: 22.73,
        shippingPrice: 1.49,
      }),
      listing({
        listingId: 21,
        productId: 111645,
        productConditionId: 1116452,
        conditionId: 2,
        condition: "Lightly Played",
        printing: "Foil",
        sellerKey: "lp-seller",
        price: 48.51,
        shippingPrice: 1.49,
      }),
    ];
    const nearMintListings = [
      ownListing,
      listing({
        listingId: 30,
        productId: 111645,
        productConditionId: 1116451,
        conditionId: 1,
        condition: "Near Mint",
        printing: "Foil",
        sellerKey: "nm-seller-one",
        price: 72.48,
        shippingPrice: 1.49,
      }),
      listing({
        listingId: 31,
        productId: 111645,
        productConditionId: 1116451,
        conditionId: 1,
        condition: "Near Mint",
        printing: "Foil",
        sellerKey: "nm-seller-two",
        price: 72.49,
        shippingPrice: 1.49,
      }),
    ];
    const listSellerInventory = vi.fn(
      (input: { readonly channelId?: number }) =>
        Promise.resolve(input.channelId === 0 ? [ownProduct] : []),
    );
    const searchMarketplaceProducts = vi.fn(
      (input: {
        readonly channelId?: number;
        readonly conditions?: string[];
      }) => {
        if (input.channelId === 1) {
          return Promise.resolve({ totalProducts: 0, products: [] });
        }
        const exactNearMint = input.conditions?.length === 1;
        return Promise.resolve({
          totalProducts: 1,
          products: [
            {
              ...ownProduct,
              totalListings: exactNearMint ? 9 : 16,
              listings: exactNearMint ? nearMintListings : broadListings,
            },
          ],
        });
      },
    );
    const service = new RepricingService({
      client: { listSellerInventory, searchMarketplaceProducts },
      sellerKey,
      now: () => new Date("2026-08-05T12:00:00.000Z"),
    });
    const conservativeRules: RepricingRules = {
      ...rules,
      sparseMarketFallback: "higher-of-market-and-lowest",
      ranges: [
        {
          minimumListings: 3,
          priceSource: "lowest",
          percentage: 100,
          gapThresholdPercent: 10,
          gapAction: "use-next",
          supportMode: "cluster",
          minimumSellerSupport: 2,
          supportWindowPercent: 5,
        },
      ],
    };

    const first = await service.preview(conservativeRules);
    const second = await service.preview(conservativeRules);

    expect(first.rows[0]).toMatchObject({
      productName: "Rishadan Port",
      currentPrice: 70,
      proposedPrice: 70,
      status: "unchanged",
      qualifyingListings: 8,
      distinctSellers: 2,
      supportedClusterPrice: 72.48,
      supportedClusterShipping: 1.49,
      queueable: false,
    });
    expect(first.rows[0]?.reason).toContain("price increases are disabled");
    expect(first.rows[0]?.sparseMarketFallbackApplied).toBeUndefined();
    expect(searchMarketplaceProducts).toHaveBeenCalledTimes(2);
    expect(searchMarketplaceProducts).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        productIds: [111645],
        conditions: ["Near Mint"],
        printings: ["Foil"],
        languages: ["English"],
        channelId: 0,
      }),
    );
    expect(second.marketplaceSnapshot.source).toBe("cache");
    expect(searchMarketplaceProducts).toHaveBeenCalledTimes(2);
  });

  it("recovers marketplace listings hidden by worse conditions", async () => {
    const ownListing = listing({
      listingId: 10,
      productId: 31833,
      productConditionId: 318334,
      conditionId: 4,
      condition: "Heavily Played",
      quantity: 4,
      price: 1.93,
      shippingPrice: 1.49,
    });
    const ownProduct: MarketplaceProduct = {
      ...product(ownListing),
      productName: "Synthetic Cascade Card",
      setName: "Synthetic Multicolor Set",
      marketPrice: 3.24,
      totalListings: 5,
    };
    const damagedListings = [
      listing({
        listingId: 20,
        productId: 31833,
        productConditionId: 318335,
        conditionId: 5,
        condition: "Damaged",
        sellerKey: "damaged-seller-one",
        price: 1.8,
        shippingPrice: 1.49,
      }),
      listing({
        listingId: 21,
        productId: 31833,
        productConditionId: 318335,
        conditionId: 5,
        condition: "Damaged",
        sellerKey: "damaged-seller-two",
        price: 1.84,
        shippingPrice: 1.49,
      }),
      ownListing,
    ];
    const exactMarketplaceListings = [
      ownListing,
      listing({
        listingId: 30,
        productId: 31833,
        productConditionId: 318333,
        conditionId: 3,
        condition: "Moderately Played",
        sellerKey: "marketplace-seller-one",
        price: 1.94,
        shippingPrice: 1.49,
      }),
      listing({
        listingId: 31,
        productId: 31833,
        productConditionId: 318334,
        conditionId: 4,
        condition: "Heavily Played",
        sellerKey: "marketplace-seller-two",
        price: 1.97,
        shippingPrice: 1.49,
      }),
    ];
    const directListing = listing({
      listingId: 40,
      productId: 31833,
      productConditionId: 318334,
      conditionId: 4,
      condition: "Heavily Played",
      channelId: 1,
      directListing: true,
      directInventory: 12,
      directProduct: true,
      directSeller: true,
      listingType: "standard",
      sellerPrograms: ["Direct", "DirectViewable"],
      sellerKey: "direct-seller",
      price: 1.67,
      shippingPrice: 3.99,
    });
    const listSellerInventory = vi.fn(
      (input: { readonly channelId?: number }) =>
        Promise.resolve(input.channelId === 0 ? [ownProduct] : []),
    );
    const searchMarketplaceProducts = vi.fn(
      (input: {
        readonly channelId?: number;
        readonly conditions?: readonly string[];
      }) => {
        const exactConditions = input.conditions?.length === 4;
        if (input.channelId === 1) {
          return Promise.resolve({
            totalProducts: 1,
            products: [
              { ...ownProduct, totalListings: 1, listings: [directListing] },
            ],
          });
        }
        return Promise.resolve({
          totalProducts: 1,
          products: [
            {
              ...ownProduct,
              totalListings: 5,
              listings: exactConditions
                ? exactMarketplaceListings
                : damagedListings,
            },
          ],
        });
      },
    );
    const service = new RepricingService({
      client: { listSellerInventory, searchMarketplaceProducts },
      sellerKey,
      now: () => new Date("2026-08-06T17:00:00.000Z"),
    });
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

    const preview = await service.preview(sellNowRules);

    expect(preview.rows[0]).toMatchObject({
      currentPrice: 1.93,
      competitorPrice: 1.94,
      competitorShipping: 1.49,
      competitorCondition: "Moderately Played",
      proposedPrice: 1.93,
      status: "unchanged",
      pricingSource: "lowest",
    });
    expect(searchMarketplaceProducts).toHaveBeenCalledTimes(2);
    expect(searchMarketplaceProducts).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        productIds: [31833],
        conditions: [
          "Near Mint",
          "Lightly Played",
          "Moderately Played",
          "Heavily Played",
        ],
        channelId: 0,
      }),
    );
  });

  it("recovers a cheaper exact-condition listing hidden behind a qualifying broad result", async () => {
    const ownListing = listing({
      listingId: 10,
      productId: 179491,
      productConditionId: 3904364,
      conditionId: 1,
      condition: "Near Mint",
      quantity: 1,
      price: 4.48,
      shippingPrice: 1.49,
    });
    const ownProduct: MarketplaceProduct = {
      ...product(ownListing),
      productName: "Synthetic Premium Creature",
      setName: "Synthetic Masters Set",
      marketPrice: 6.26,
      totalListings: 67,
    };
    const expensiveMarketplaceListing = listing({
      listingId: 20,
      productId: 179491,
      productConditionId: 3904364,
      conditionId: 1,
      condition: "Near Mint",
      sellerKey: "expensive-marketplace-seller",
      price: 7.27,
      shippingPrice: 3.99,
    });
    const hiddenMarketplaceListing = listing({
      listingId: 21,
      productId: 179491,
      productConditionId: 3904364,
      conditionId: 1,
      condition: "Near Mint",
      sellerKey: "hidden-marketplace-seller",
      price: 5.98,
      shippingPrice: 0,
    });
    const directListing = listing({
      listingId: 30,
      productId: 179491,
      productConditionId: 3904364,
      conditionId: 1,
      condition: "Near Mint",
      channelId: 1,
      directListing: true,
      directInventory: 23,
      directProduct: true,
      directSeller: true,
      listingType: "standard",
      sellerPrograms: ["Direct", "DirectViewable"],
      sellerKey: "direct-seller",
      price: 5.7,
      shippingPrice: 3.99,
    });
    const listSellerInventory = vi.fn(
      (input: { readonly channelId?: number }) =>
        Promise.resolve(input.channelId === 0 ? [ownProduct] : []),
    );
    const searchMarketplaceProducts = vi.fn(
      (input: {
        readonly channelId?: number;
        readonly conditions?: readonly string[];
      }) => {
        const exactNearMint = input.conditions?.length === 1;
        if (input.channelId === 1) {
          return Promise.resolve({
            totalProducts: 1,
            products: [
              { ...ownProduct, totalListings: 17, listings: [directListing] },
            ],
          });
        }
        return Promise.resolve({
          totalProducts: 1,
          products: [
            {
              ...ownProduct,
              totalListings: 67,
              listings: exactNearMint
                ? [
                    ownListing,
                    hiddenMarketplaceListing,
                    expensiveMarketplaceListing,
                  ]
                : [ownListing, expensiveMarketplaceListing],
            },
          ],
        });
      },
    );
    const service = new RepricingService({
      client: { listSellerInventory, searchMarketplaceProducts },
      sellerKey,
      now: () => new Date("2026-08-06T20:00:00.000Z"),
    });
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

    const preview = await service.preview(sellNowRules);

    expect(preview.rows[0]).toMatchObject({
      currentPrice: 4.48,
      competitorPrice: 5.98,
      competitorShipping: 0,
      proposedPrice: 4.48,
      status: "unchanged",
      pricingSource: "lowest",
    });
    expect(searchMarketplaceProducts).toHaveBeenCalledTimes(2);
    expect(searchMarketplaceProducts).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        productIds: [179491],
        conditions: ["Near Mint"],
        channelId: 0,
      }),
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
    expect(first.marketplaceSnapshot.expiresAt).toBe(
      "2026-08-05T12:10:00.000Z",
    );
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
