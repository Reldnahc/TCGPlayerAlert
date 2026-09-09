import { describe, expect, it, vi } from "vitest";
import { ManaPoolListingQuoteReader } from "../../src/providers/manapool/listing-quotes.js";

const exactSku = {
  namespace: "tcgplayer.sku",
  value: "456",
  precision: "exact-variant" as const,
};

describe("ManaPool listing quotes", () => {
  it("returns the exact SKU market-low price", async () => {
    const lookupSinglesByTcgplayerSkus = vi.fn(() =>
      Promise.resolve({
        asOf: "2026-09-08T12:00:00.000Z",
        singles: [
          {
            url: "https://manapool.com/card/tst/1/synthetic-card",
            cardId: "318f4c5a-6b7c-7d8e-8f90-123456789abc",
            name: "Synthetic Card",
            setCode: "TST",
            number: "1",
            multiverseId: null,
            scryfallId: "218f4c5a-6b7c-7d8e-8f90-123456789abc",
            tcgplayerProductId: 123,
            availableQuantity: 4,
            marketPrice: 3.25,
            foilMarketPrice: null,
            variants: [
              {
                productType: "mtg_single" as const,
                productId: "118f4c5a-6b7c-7d8e-8f90-123456789abc",
                tcgplayerSkuId: 456,
                languageId: "EN",
                conditionId: "NM",
                finishId: "NF",
                lowPriceCents: 299,
                availableQuantity: 4,
                recentSales: [],
              },
            ],
          },
        ],
      }),
    );
    const reader = new ManaPoolListingQuoteReader({
      lookupSinglesByTcgplayerSkus,
    });

    await expect(reader.quoteExactListing(exactSku)).resolves.toEqual({
      price: { currency: "USD", minorUnits: 299 },
      source: "market-low",
      availableQuantity: 4,
      asOf: "2026-09-08T12:00:00.000Z",
    });
    expect(lookupSinglesByTcgplayerSkus).toHaveBeenCalledWith([456], undefined);
  });

  it("does not substitute another variant when the exact SKU is absent", async () => {
    const reader = new ManaPoolListingQuoteReader({
      lookupSinglesByTcgplayerSkus: () =>
        Promise.resolve({ asOf: "2026-09-08T12:00:00.000Z", singles: [] }),
    });
    await expect(reader.quoteExactListing(exactSku)).resolves.toBeUndefined();
  });
});
