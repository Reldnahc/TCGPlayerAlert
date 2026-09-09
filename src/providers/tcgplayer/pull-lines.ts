import type {
  PullSheetOrderAllocation,
  PullSheetRow,
  TcgplayerSellerClient,
} from "tcgplayer-private-api";
import {
  type PullLine,
  type PullLineReader,
} from "../../marketplaces/contracts.js";
import {
  MarketplaceValidationError,
  orderRefKey,
  parseConnectionId,
  parseProviderOrderRef,
  type ProviderOrderRef,
} from "../../marketplaces/identity.js";
import {
  assertTcgplayerOrderConnection,
  normalizeTcgplayerProductLine,
} from "./normalization.js";

type PullClient = Pick<TcgplayerSellerClient, "exportPullSheet" | "getOrder">;
const DETAIL_CONCURRENCY = 4;
const SKU_PRODUCT_CACHE_LIMIT = 50_000;

export class TcgplayerPullLineReader implements PullLineReader {
  private readonly connectionId: string;
  private readonly productIdsBySku = new Map<string, number>();

  constructor(
    private readonly client: PullClient,
    connectionId: string,
    private readonly timezoneOffsetMinutes: number,
  ) {
    this.connectionId = parseConnectionId(connectionId);
    if (
      !Number.isSafeInteger(timezoneOffsetMinutes) ||
      timezoneOffsetMinutes < -14 * 60 ||
      timezoneOffsetMinutes > 14 * 60
    ) {
      throw new MarketplaceValidationError(
        "The pull-list timezone offset is invalid.",
      );
    }
  }

  async getPullLines(
    rawRefs: readonly ProviderOrderRef[],
    signal?: AbortSignal,
  ): Promise<readonly PullLine[]> {
    if (rawRefs.length === 0 || rawRefs.length > 10_000) {
      throw new MarketplaceValidationError(
        "The pull-list order selection is invalid.",
      );
    }
    const refs = rawRefs.map(parseProviderOrderRef);
    for (const ref of refs) {
      assertTcgplayerOrderConnection(this.connectionId, ref.connectionId);
    }
    if (new Set(refs.map(orderRefKey)).size !== refs.length) {
      throw new MarketplaceValidationError(
        "The pull-list order selection contains duplicates.",
      );
    }
    const byRemoteId = new Map(refs.map((ref) => [ref.remoteId, ref]));
    if (byRemoteId.size !== refs.length) {
      throw new MarketplaceValidationError(
        "The pull-list order selection contains duplicate remote IDs.",
      );
    }
    const result = await this.client.exportPullSheet(
      {
        orderNumbers: refs.map((ref) => ref.remoteId),
        timezoneOffsetMinutes: this.timezoneOffsetMinutes,
      },
      signal === undefined ? undefined : { signal },
    );
    assertExactOrderSet(result.orderNumbers, byRemoteId);
    const productIdsBySku = await resolveProductIds(
      this.client,
      result.rows,
      refs,
      this.productIdsBySku,
      signal,
    );
    return result.rows.flatMap((row) =>
      row.orderAllocations.map((allocation) =>
        normalizeAllocation(
          row,
          allocation,
          byRemoteId,
          productIdsBySku.get(row.skuId),
        ),
      ),
    );
  }
}

function normalizeAllocation(
  row: PullSheetRow,
  allocation: PullSheetOrderAllocation,
  byRemoteId: ReadonlyMap<string, ProviderOrderRef>,
  productId: number | undefined,
): PullLine {
  const order = byRemoteId.get(allocation.orderNumber);
  if (
    order === undefined ||
    !Number.isSafeInteger(allocation.quantity) ||
    allocation.quantity < 1
  ) {
    throw new MarketplaceValidationError(
      "TCGplayer returned an invalid pull-list allocation.",
    );
  }
  const skuId = requiredText(row.skuId, "pull-list SKU", 256);
  return {
    description: requiredText(row.productName, "pull-list description", 512),
    quantity: allocation.quantity,
    attributes: compactAttributes({
      productLine: normalizeTcgplayerProductLine(row.productLine),
      condition: row.condition,
      number: row.number,
      setName: row.setName,
      rarity: row.rarity,
      mainPhotoUrl: row.mainPhotoUrl,
      setReleaseDate: row.setReleaseDate,
    }),
    catalogIdentities: [
      {
        namespace: "tcgplayer.sku",
        value: skuId,
        precision: "exact-variant",
      },
      ...(productId === undefined
        ? []
        : [
            {
              namespace: "tcgplayer.product",
              value: String(productId),
              precision: "product" as const,
            },
          ]),
    ],
    allocations: [{ order, lineKey: skuId, quantity: allocation.quantity }],
  };
}

async function resolveProductIds(
  client: PullClient,
  rows: readonly PullSheetRow[],
  refs: readonly ProviderOrderRef[],
  cache: Map<string, number>,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, number>> {
  const bySku = new Map<string, number>();
  const unresolved = new Set<string>();
  for (const row of rows) {
    const productId = productIdFromPhotoUrl(row.mainPhotoUrl);
    const resolved = productId ?? cache.get(row.skuId);
    if (resolved === undefined) {
      unresolved.add(row.skuId);
    } else {
      bySku.set(row.skuId, resolved);
      rememberProductId(cache, row.skuId, resolved);
    }
  }
  if (unresolved.size === 0) return bySku;

  const remainingRefs = new Map(refs.map((ref) => [ref.remoteId, ref]));
  const skusByOrder = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!unresolved.has(row.skuId)) continue;
    for (const allocation of row.orderAllocations) {
      const skus = skusByOrder.get(allocation.orderNumber) ?? new Set<string>();
      skus.add(row.skuId);
      skusByOrder.set(allocation.orderNumber, skus);
    }
  }
  while (unresolved.size > 0 && remainingRefs.size > 0) {
    signal?.throwIfAborted();
    const batch = selectReferenceBatch(remainingRefs, skusByOrder, unresolved);
    if (batch.length === 0) break;
    const details = await Promise.all(
      batch.map(async (ref) => {
        try {
          const detail = await client.getOrder(
            ref.remoteId,
            signal === undefined ? undefined : { signal },
          );
          return detail.orderNumber === ref.remoteId ? detail : undefined;
        } catch {
          signal?.throwIfAborted();
          return undefined;
        }
      }),
    );
    for (const detail of details) {
      if (detail === undefined) continue;
      for (const product of detail.products) {
        const productId = productIdValue(product.productId);
        if (productId === undefined) continue;
        rememberProductId(cache, product.skuId, productId);
        if (unresolved.delete(product.skuId)) {
          bySku.set(product.skuId, productId);
        }
      }
    }
  }
  return bySku;
}

function selectReferenceBatch(
  remainingRefs: Map<string, ProviderOrderRef>,
  skusByOrder: ReadonlyMap<string, ReadonlySet<string>>,
  unresolved: ReadonlySet<string>,
): readonly ProviderOrderRef[] {
  const selected: ProviderOrderRef[] = [];
  const covered = new Set<string>();
  while (selected.length < DETAIL_CONCURRENCY && remainingRefs.size > 0) {
    let best: ProviderOrderRef | undefined;
    let bestCoverage = 0;
    for (const ref of remainingRefs.values()) {
      const coverage = [...(skusByOrder.get(ref.remoteId) ?? [])].filter(
        (skuId) => unresolved.has(skuId) && !covered.has(skuId),
      ).length;
      if (coverage > bestCoverage) {
        best = ref;
        bestCoverage = coverage;
      }
    }
    if (best === undefined) break;
    remainingRefs.delete(best.remoteId);
    selected.push(best);
    for (const skuId of skusByOrder.get(best.remoteId) ?? []) {
      if (unresolved.has(skuId)) covered.add(skuId);
    }
  }
  return selected;
}

function rememberProductId(
  cache: Map<string, number>,
  skuId: string,
  productId: number,
): void {
  if (!cache.has(skuId) && cache.size >= SKU_PRODUCT_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.delete(skuId);
  cache.set(skuId, productId);
}

function productIdFromPhotoUrl(value: string): number | undefined {
  try {
    const url = new URL(value);
    if (url.hostname.toLocaleLowerCase() !== "product-images.tcgplayer.com") {
      return undefined;
    }
    const match = /\/([1-9]\d{0,15})\.(?:jpe?g|png|webp)$/iu.exec(url.pathname);
    const raw = match?.[1];
    if (raw === undefined) return undefined;
    const productId = Number(raw);
    return Number.isSafeInteger(productId) ? productId : undefined;
  } catch {
    return undefined;
  }
}

function productIdValue(value: string): number | undefined {
  if (!/^[1-9]\d{0,15}$/u.test(value)) return undefined;
  const productId = Number(value);
  return Number.isSafeInteger(productId) ? productId : undefined;
}

function assertExactOrderSet(
  actual: readonly string[],
  expected: ReadonlyMap<string, ProviderOrderRef>,
): void {
  if (
    actual.length !== expected.size ||
    new Set(actual).size !== actual.length ||
    actual.some((orderNumber) => !expected.has(orderNumber))
  ) {
    throw new MarketplaceValidationError(
      "TCGplayer returned a pull sheet for the wrong order selection.",
    );
  }
}

function requiredText(value: string, label: string, maximum: number): string {
  if (
    value.trim().length === 0 ||
    Array.from(value).length > maximum ||
    /\p{Cc}/u.test(value)
  ) {
    throw new MarketplaceValidationError(`The ${label} is invalid.`);
  }
  return value;
}

function compactAttributes(
  attributes: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value.trim().length > 0),
  );
}
