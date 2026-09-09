import type { ManaPoolSellerClient } from "manapool-seller-api";
import type {
  CatalogIdentity,
  ListingQuote,
  ListingQuoteReader,
} from "../../marketplaces/contracts.js";
import { MarketplaceValidationError } from "../../marketplaces/identity.js";

export type ManaPoolListingQuoteClient = Pick<
  ManaPoolSellerClient,
  "lookupSinglesByTcgplayerSkus"
>;

export class ManaPoolListingQuoteReader implements ListingQuoteReader {
  constructor(private readonly client: ManaPoolListingQuoteClient) {}

  async quoteExactListing(
    identity: CatalogIdentity,
    signal?: AbortSignal,
  ): Promise<ListingQuote | undefined> {
    if (
      identity.namespace !== "tcgplayer.sku" ||
      identity.precision !== "exact-variant" ||
      !/^[1-9]\d{0,15}$/u.test(identity.value)
    ) {
      throw new MarketplaceValidationError(
        "ManaPool listing quotes require an exact TCGplayer SKU identity.",
      );
    }
    const sku = Number(identity.value);
    if (!Number.isSafeInteger(sku)) {
      throw new MarketplaceValidationError(
        "The TCGplayer SKU identity is invalid.",
      );
    }
    const result = await this.client.lookupSinglesByTcgplayerSkus(
      [sku],
      signal === undefined ? undefined : { signal },
    );
    const candidates = result.singles.flatMap((single) =>
      single.variants.filter((variant) => variant.tcgplayerSkuId === sku),
    );
    if (candidates.length === 0) return undefined;
    const priced = candidates
      .filter((variant) => variant.lowPriceCents > 0)
      .sort((left, right) => left.lowPriceCents - right.lowPriceCents)[0];
    if (priced === undefined) return undefined;
    return {
      price: { currency: "USD", minorUnits: priced.lowPriceCents },
      source: "market-low",
      availableQuantity: priced.availableQuantity,
      asOf: result.asOf,
    };
  }
}
