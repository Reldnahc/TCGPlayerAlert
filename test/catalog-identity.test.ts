import { describe, expect, it } from "vitest";
import {
  catalogIdentityMatchTier,
  catalogIdentityKey,
  exactVariantCatalogIdentities,
} from "../src/marketplaces/catalog-identity.js";

describe("provider-neutral catalog identity", () => {
  it("prefers provider exact identities and derives the same product variant across vocabularies", () => {
    const tcgplayer = exactVariantCatalogIdentities(
      [
        {
          namespace: "tcgplayer.sku",
          value: "123",
          precision: "exact-variant",
        },
        {
          namespace: "tcgplayer.product",
          value: "456",
          precision: "product",
        },
      ],
      {
        language: "English",
        condition: "Near Mint",
        printing: "Normal",
      },
    );
    const manaPool = exactVariantCatalogIdentities(
      [
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
      {
        language: "en",
        condition: "near_mint",
        finish: "nonfoil",
      },
    );

    expect(tcgplayer[0]).toMatchObject({
      namespace: "tcgplayer.sku",
      precision: "exact-variant",
    });
    expect(
      tcgplayer
        .map(catalogIdentityKey)
        .filter((key) => manaPool.map(catalogIdentityKey).includes(key)),
    ).toEqual([
      catalogIdentityKey({
        namespace: "normalized.tcgplayer-variant.v1",
        value: '["456","en","near-mint","nonfoil"]',
        precision: "exact-variant",
      }),
    ]);
  });

  it("derives exact Scryfall and MTGJSON variants from complete attributes", () => {
    expect(
      exactVariantCatalogIdentities(
        [
          {
            namespace: "scryfall.printing",
            value: "printing-id",
            precision: "product",
          },
          {
            namespace: "mtgjson.uuid",
            value: "mtgjson-id",
            precision: "product",
          },
        ],
        { language: "ja", condition: "LP", finish: "foil" },
      ),
    ).toEqual([
      {
        namespace: "normalized.scryfall-variant.v1",
        value: '["printing-id","ja","lightly-played","foil"]',
        precision: "exact-variant",
      },
      {
        namespace: "normalized.mtgjson-variant.v1",
        value: '["mtgjson-id","ja","lightly-played","foil"]',
        precision: "exact-variant",
      },
    ]);
  });

  it("uses set code, collector number, and List status only as a complete final fallback", () => {
    const list = exactVariantCatalogIdentities([], {
      productType: "mtg_single",
      setCode: "PLST",
      collectorNumber: "42",
      language: "English",
      condition: "NM",
      finish: "non-foil",
    });
    const standard = exactVariantCatalogIdentities([], {
      game: "Magic: The Gathering",
      setCode: "TST",
      number: "42",
      listIcon: "false",
      language: "en",
      condition: "near_mint",
      printing: "Normal",
    });
    const missingListStatus = exactVariantCatalogIdentities([], {
      productType: "mtg_single",
      setCode: "TST",
      number: "42",
      language: "en",
      condition: "near_mint",
      finish: "nonfoil",
    });

    expect(list).toEqual([
      expect.objectContaining({
        namespace: "normalized.mtg-natural-variant.v1",
        value: '["plst","42","list","en","near-mint","nonfoil"]',
      }),
    ]);
    expect(standard).toEqual([
      expect.objectContaining({
        namespace: "normalized.mtg-natural-variant.v1",
        value: '["tst","42","standard","en","near-mint","nonfoil"]',
      }),
    ]);
    expect(missingListStatus).toEqual([]);
  });

  it("fails closed when a variant is incomplete or contradictory", () => {
    const product = {
      namespace: "tcgplayer.product",
      value: "456",
      precision: "product" as const,
    };

    expect(
      exactVariantCatalogIdentities([product], {
        language: "English",
        condition: "Near Mint",
      }),
    ).toEqual([]);
    expect(
      exactVariantCatalogIdentities([product], {
        language: "English",
        condition: "Near Mint",
        finish: "nonfoil",
        printing: "Foil",
      }),
    ).toEqual([]);
  });

  it("lets a shared exact ID decide and blocks fallbacks across contradictory exact IDs", () => {
    const subject = (sku: string, finish: string) => ({
      catalogIdentities: [
        {
          namespace: "tcgplayer.sku",
          value: sku,
          precision: "exact-variant" as const,
        },
        {
          namespace: "tcgplayer.product",
          value: "456",
          precision: "product" as const,
        },
      ],
      attributes: {
        language: "English",
        condition: "Near Mint",
        printing: finish,
      },
    });

    expect(
      catalogIdentityMatchTier(
        subject("123", "Normal"),
        subject("123", "Foil"),
      ),
    ).toBe("provider-exact");
    expect(
      catalogIdentityMatchTier(
        subject("123", "Normal"),
        subject("999", "Normal"),
      ),
    ).toBeUndefined();
  });
});
