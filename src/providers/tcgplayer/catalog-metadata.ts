import type { TcgplayerSellerClient } from "tcgplayer-private-api";
import type {
  CatalogIdentity,
  CatalogMetadataReader,
} from "../../marketplaces/contracts.js";
import { MarketplaceValidationError } from "../../marketplaces/identity.js";

type CatalogClient = Pick<TcgplayerSellerClient, "searchMarketplaceProducts">;
const METADATA_CACHE_LIMIT = 50_000;

type CatalogAttributes = Readonly<Record<string, readonly string[]>>;

export class TcgplayerCatalogMetadataReader implements CatalogMetadataReader {
  private readonly cache = new Map<number, CatalogAttributes>();

  constructor(private readonly client: CatalogClient) {}

  async readCatalogMetadata(
    identities: readonly CatalogIdentity[],
    signal?: AbortSignal,
  ): Promise<
    Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>
  > {
    const requested = new Map<number, string>();
    for (const identity of identities) {
      if (identity.namespace !== "tcgplayer.product") continue;
      const productId = parseProductId(identity.value);
      requested.set(productId, identityToken(identity));
    }
    const metadata: Record<
      string,
      Readonly<Record<string, readonly string[]>>
    > = {};
    const productIds = [...requested.keys()].filter((productId) => {
      const cached = this.cache.get(productId);
      const token = requested.get(productId);
      if (cached === undefined || token === undefined) return true;
      metadata[token] = cached;
      return false;
    });
    for (let offset = 0; offset < productIds.length; offset += 24) {
      signal?.throwIfAborted();
      const batch = productIds.slice(offset, offset + 24);
      const result = await this.client.searchMarketplaceProducts(
        { productIds: batch, channelId: 0, offset: 0, limit: batch.length },
        signal === undefined ? undefined : { signal },
      );
      const batchIds = new Set(batch);
      for (const product of result.products) {
        if (!batchIds.has(product.productId)) continue;
        const token = requested.get(product.productId);
        if (token === undefined) continue;
        const attributes = compactAttributes({
          ...(product.attributes ?? {}),
          ...(product.colors === undefined ? {} : { color: product.colors }),
          ...(product.cardTypes === undefined
            ? {}
            : { cardType: product.cardTypes }),
        });
        rememberMetadata(this.cache, product.productId, attributes);
        metadata[token] = attributes;
      }
    }
    return metadata;
  }
}

function rememberMetadata(
  cache: Map<number, CatalogAttributes>,
  productId: number,
  attributes: CatalogAttributes,
): void {
  if (!cache.has(productId) && cache.size >= METADATA_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.delete(productId);
  cache.set(productId, attributes);
}

function parseProductId(value: string): number {
  if (!/^[1-9]\d{0,15}$/u.test(value)) {
    throw new MarketplaceValidationError(
      "The TCGplayer catalog product identity is invalid.",
    );
  }
  const productId = Number(value);
  if (!Number.isSafeInteger(productId)) {
    throw new MarketplaceValidationError(
      "The TCGplayer catalog product identity is invalid.",
    );
  }
  return productId;
}

function identityToken(identity: CatalogIdentity): string {
  return `${identity.namespace}:${encodeURIComponent(identity.value)}`;
}

function compactAttributes(
  attributes: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(
    Object.entries(attributes).flatMap(([key, values]) => {
      const normalized = values
        .map((value) => value.trim())
        .filter(
          (value) =>
            value.length > 0 &&
            Array.from(value).length <= 256 &&
            !/\p{Cc}/u.test(value),
        );
      return normalized.length === 0 ? [] : [[key, normalized] as const];
    }),
  );
}
