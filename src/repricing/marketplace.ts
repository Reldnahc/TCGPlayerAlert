import type {
  MarketplaceListing,
  MarketplaceProduct,
  SearchMarketplaceProductListingsResult,
  SellerInventoryProgress,
  TcgplayerSellerClient,
} from "tcgplayer-private-api";
import type {
  RepricingPreviewRow,
  RepricingProgress,
  RepricingRules,
} from "./contracts.js";
import {
  allowedConditions,
  calculateRepricingRow,
  isVerifiedDirectListing,
  TCGPLAYER_NORMALIZED_MARKETPLACE_SHIPPING,
  type RepricingComparisonEvidence,
  type SellerListingContext,
} from "./pricing.js";

export type RepricingMarketplaceClient = Pick<
  TcgplayerSellerClient,
  "listSellerInventory" | "searchMarketplaceProducts"
> &
  Partial<Pick<TcgplayerSellerClient, "searchMarketplaceProductListings">>;

export interface MarketplaceSnapshot {
  readonly inventory: readonly MarketplaceProduct[];
  readonly secondaryInventory: readonly MarketplaceProduct[];
  readonly comparisonRecoveries: Map<string, MarketplaceComparisonSample>;
  readonly exactComparisonFailures: Set<string>;
  readonly capturedAt: Date;
  readonly expiresAt: Date;
}

export interface MarketplaceComparisonSample {
  readonly listings: readonly MarketplaceListing[];
  readonly marketplaceTotalListings: number;
  readonly marketplaceReturnedListings: number;
  readonly source: "spotlight" | "exact";
}
export function comparisonRecoveryKey(
  context: SellerListingContext,
  conditions: readonly string[],
): string {
  return JSON.stringify([
    context.product.productId,
    context.listing.printing,
    context.listing.language,
    ...conditions,
  ]);
}

export function sellerConditionKey(context: SellerListingContext): string {
  return JSON.stringify([
    context.product.productId,
    context.listing.printing,
    context.listing.language,
    context.listing.condition,
  ]);
}

export function comparisonEvidence(
  context: SellerListingContext,
  conditions: readonly string[],
  sample: MarketplaceComparisonSample,
  sellerConditionCounts: ReadonlyMap<string, number>,
): RepricingComparisonEvidence {
  const ownMatchingListings = conditions.reduce(
    (total, condition) =>
      total +
      (sellerConditionCounts.get(
        JSON.stringify([
          context.product.productId,
          context.listing.printing,
          context.listing.language,
          condition,
        ]),
      ) ?? 0),
    0,
  );
  return {
    ...(sample.source === "spotlight"
      ? {
          reportedQualifyingListings: Math.max(
            0,
            sample.marketplaceTotalListings - ownMatchingListings,
          ),
        }
      : {}),
    incomplete: comparisonSampleIncomplete(sample),
  };
}

export function requiresExactShippingVerification(
  row: RepricingPreviewRow,
  rules: RepricingRules,
): boolean {
  return (
    rules.priceBasis === "delivered" &&
    row.competitorShipping !== undefined &&
    row.competitorShipping > TCGPLAYER_NORMALIZED_MARKETPLACE_SHIPPING
  );
}

function comparisonRecoveryGroupKey(
  context: SellerListingContext,
  conditions: readonly string[],
): string {
  return JSON.stringify([
    context.listing.printing,
    context.listing.language,
    conditions,
  ]);
}

export function emptyComparisonSample(): MarketplaceComparisonSample {
  return {
    listings: [],
    marketplaceTotalListings: 0,
    marketplaceReturnedListings: 0,
    source: "spotlight",
  };
}

function comparisonSampleIncomplete(
  sample: MarketplaceComparisonSample,
): boolean {
  return sample.marketplaceTotalListings > sample.marketplaceReturnedListings;
}

function mergeComparisonProduct(
  sample: MarketplaceComparisonSample,
  product: MarketplaceProduct,
  channelId: number,
): MarketplaceComparisonSample {
  const eligibleListings = product.listings.filter((listing) =>
    channelId === 0
      ? listing.channelId === 0
      : isVerifiedDirectListing(listing),
  );
  const listings = [...sample.listings];
  const listingKeys = new Set(
    listings.map(
      (listing) => `${String(listing.listingId)}:${String(listing.channelId)}`,
    ),
  );
  for (const listing of eligibleListings) {
    const listingKey = `${String(listing.listingId)}:${String(listing.channelId)}`;
    if (listingKeys.has(listingKey)) continue;
    listingKeys.add(listingKey);
    listings.push(listing);
  }
  return {
    listings,
    marketplaceTotalListings:
      channelId === 0 ? product.totalListings : sample.marketplaceTotalListings,
    marketplaceReturnedListings:
      channelId === 0
        ? eligibleListings.length
        : sample.marketplaceReturnedListings,
    source: "spotlight",
  };
}

function exactComparisonSample(
  result: SearchMarketplaceProductListingsResult,
): MarketplaceComparisonSample {
  return {
    listings: result.listings,
    marketplaceTotalListings: result.totalListings,
    marketplaceReturnedListings: result.listings.length,
    source: "exact",
  };
}

function chunks<T>(values: readonly T[], size: number): readonly T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
export class RepricingMarketplace {
  private readonly client: RepricingMarketplaceClient;
  private readonly sellerKey: () => string;
  private readonly now: () => Date;
  private readonly cacheLifetimeMs: number;
  private marketplaceCache: MarketplaceSnapshot | undefined;
  private marketplaceLoad: Promise<MarketplaceSnapshot> | undefined;
  private readonly marketplaceRecoveryLoads = new WeakMap<
    MarketplaceSnapshot,
    Promise<void>
  >();
  private readonly exactComparisonLoads = new WeakMap<
    MarketplaceSnapshot,
    Promise<void>
  >();

  constructor(options: {
    readonly client: RepricingMarketplaceClient;
    readonly sellerKey: () => string;
    readonly now: () => Date;
    readonly cacheLifetimeMs: number;
  }) {
    this.client = options.client;
    this.sellerKey = options.sellerKey;
    this.now = options.now;
    this.cacheLifetimeMs = options.cacheLifetimeMs;
  }

  invalidate(): void {
    this.marketplaceCache = undefined;
    this.marketplaceLoad = undefined;
  }

  async prepareComparisons(
    snapshot: MarketplaceSnapshot,
    contexts: readonly SellerListingContext[],
    rules: RepricingRules,
    sellerConditionCounts: ReadonlyMap<string, number>,
    onProgress?: (progress: RepricingProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.recoverSparseComparisons(
      snapshot,
      contexts,
      rules,
      onProgress,
      signal,
    );
    await this.recoverSuspiciousShippingComparisons(
      snapshot,
      contexts,
      rules,
      sellerConditionCounts,
      onProgress,
      signal,
    );
  }
  async snapshot(
    forceRefresh: boolean,
    onProgress?: (progress: RepricingProgress) => void,
    signal?: AbortSignal,
  ): Promise<{
    readonly snapshot: MarketplaceSnapshot;
    readonly source: "fresh" | "cache" | "shared";
  }> {
    const now = this.now().getTime();
    if (
      !forceRefresh &&
      this.marketplaceCache !== undefined &&
      this.marketplaceCache.expiresAt.getTime() > now
    ) {
      const total =
        this.marketplaceCache.inventory.length +
        this.marketplaceCache.secondaryInventory.length;
      onProgress?.({
        phase: "inventory",
        completed: total,
        total,
        unit: "products",
        detail: "Using cached seller inventory",
      });
      return { snapshot: this.marketplaceCache, source: "cache" };
    }
    if (this.marketplaceLoad !== undefined) {
      const snapshot = await this.marketplaceLoad;
      const total =
        snapshot.inventory.length + snapshot.secondaryInventory.length;
      onProgress?.({
        phase: "inventory",
        completed: total,
        total,
        unit: "products",
        detail: "Using the shared seller inventory load",
      });
      return { snapshot, source: "shared" };
    }
    const load = this.loadMarketplaceSnapshot(onProgress, signal);
    this.marketplaceLoad = load;
    try {
      const snapshot = await load;
      this.marketplaceCache = snapshot;
      return { snapshot, source: "fresh" };
    } finally {
      if (this.marketplaceLoad === load) this.marketplaceLoad = undefined;
    }
  }

  private async loadMarketplaceSnapshot(
    onProgress?: (progress: RepricingProgress) => void,
    signal?: AbortSignal,
  ): Promise<MarketplaceSnapshot> {
    const channelProgress = new Map<number, SellerInventoryProgress>();
    const reportInventory = (progress: SellerInventoryProgress) => {
      channelProgress.set(progress.channelId, progress);
      const channels = [...channelProgress.values()];
      const completed = channels.reduce(
        (total, channel) => total + channel.productsLoaded,
        0,
      );
      const total =
        channelProgress.size < 2
          ? undefined
          : channels.reduce((sum, channel) => sum + channel.totalProducts, 0);
      onProgress?.({
        phase: "inventory",
        completed,
        ...(total === undefined ? {} : { total }),
        unit: "products",
        detail: "Loading seller inventory",
      });
    };
    const [inventory, secondaryInventory] = await Promise.all([
      this.client.listSellerInventory(
        {
          sellerKey: this.sellerKey(),
          channelId: 0,
        },
        {
          onProgress: reportInventory,
          ...(signal === undefined ? {} : { signal }),
        },
      ),
      this.client.listSellerInventory(
        {
          sellerKey: this.sellerKey(),
          channelId: 1,
        },
        {
          onProgress: reportInventory,
          ...(signal === undefined ? {} : { signal }),
        },
      ),
    ]);
    const capturedAt = this.now();
    return {
      inventory,
      secondaryInventory,
      comparisonRecoveries: new Map(),
      exactComparisonFailures: new Set(),
      capturedAt,
      expiresAt: new Date(capturedAt.getTime() + this.cacheLifetimeMs),
    };
  }

  private async recoverSparseComparisons(
    snapshot: MarketplaceSnapshot,
    contexts: readonly SellerListingContext[],
    rules: RepricingRules,
    onProgress?: (progress: RepricingProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (contexts.length === 0) return;
    const existingLoad = this.marketplaceRecoveryLoads.get(snapshot);
    if (existingLoad !== undefined) {
      await existingLoad;
      return this.recoverSparseComparisons(
        snapshot,
        contexts,
        rules,
        onProgress,
        signal,
      );
    }
    const groups = new Map<
      string,
      {
        readonly conditions: readonly string[];
        readonly contexts: SellerListingContext[];
      }
    >();
    for (const context of contexts) {
      const conditions = allowedConditions(
        context.listing.condition,
        rules.conditionPolicy,
      );
      if (conditions === undefined) continue;
      const recoveryKey = comparisonRecoveryKey(context, conditions);
      if (snapshot.comparisonRecoveries.has(recoveryKey)) continue;
      const groupKey = comparisonRecoveryGroupKey(context, conditions);
      const group = groups.get(groupKey) ?? { conditions, contexts: [] };
      group.contexts.push(context);
      groups.set(groupKey, group);
    }
    if (groups.size === 0) return;
    const load = this.loadComparisonRecoveries(
      snapshot,
      groups,
      onProgress,
      signal,
    );
    this.marketplaceRecoveryLoads.set(snapshot, load);
    try {
      await load;
    } finally {
      if (this.marketplaceRecoveryLoads.get(snapshot) === load) {
        this.marketplaceRecoveryLoads.delete(snapshot);
      }
    }
  }

  private async recoverSuspiciousShippingComparisons(
    snapshot: MarketplaceSnapshot,
    contexts: readonly SellerListingContext[],
    rules: RepricingRules,
    sellerConditionCounts: ReadonlyMap<string, number>,
    onProgress?: (progress: RepricingProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (contexts.length === 0) return;
    const existingLoad = this.exactComparisonLoads.get(snapshot);
    if (existingLoad !== undefined) {
      await existingLoad;
      return this.recoverSuspiciousShippingComparisons(
        snapshot,
        contexts,
        rules,
        sellerConditionCounts,
        onProgress,
        signal,
      );
    }
    const suspicious = new Map<
      string,
      {
        readonly context: SellerListingContext;
        readonly conditions: readonly string[];
      }
    >();
    for (const context of contexts) {
      const conditions = allowedConditions(
        context.listing.condition,
        rules.conditionPolicy,
      );
      if (conditions === undefined) continue;
      const recoveryKey = comparisonRecoveryKey(context, conditions);
      const sample = snapshot.comparisonRecoveries.get(recoveryKey);
      if (
        sample === undefined ||
        sample.source === "exact" ||
        snapshot.exactComparisonFailures.has(recoveryKey)
      ) {
        continue;
      }
      const provisional = calculateRepricingRow(
        context,
        sample.listings,
        this.sellerKey(),
        rules,
        `shipping-verification:${recoveryKey}`,
        comparisonEvidence(context, conditions, sample, sellerConditionCounts),
      );
      if (requiresExactShippingVerification(provisional, rules)) {
        suspicious.set(recoveryKey, { context, conditions });
      }
    }
    if (suspicious.size === 0) return;
    const searchExact = this.client.searchMarketplaceProductListings;
    if (searchExact === undefined) {
      for (const recoveryKey of suspicious.keys()) {
        snapshot.exactComparisonFailures.add(recoveryKey);
      }
      return;
    }
    let completed = 0;
    onProgress?.({
      phase: "exact-comparisons",
      completed,
      total: suspicious.size,
      unit: "products",
      detail: "Verifying exact marketplace listings",
    });
    const load = Promise.all(
      [...suspicious].map(async ([recoveryKey, { context, conditions }]) => {
        try {
          const request = {
            productId: context.product.productId,
            conditions,
            printings: [context.listing.printing],
            languages: [context.listing.language],
            channelIds: [0, 1],
            listingTypes: ["standard"],
            offset: 0,
            limit: 50,
            sort: "price+shipping",
          } as const;
          const result =
            signal === undefined
              ? await searchExact.call(this.client, request)
              : await searchExact.call(this.client, request, { signal });
          snapshot.comparisonRecoveries.set(
            recoveryKey,
            exactComparisonSample(result),
          );
          snapshot.exactComparisonFailures.delete(recoveryKey);
        } catch (error) {
          if (signal?.aborted === true) throw error;
          snapshot.exactComparisonFailures.add(recoveryKey);
        } finally {
          completed += 1;
          onProgress?.({
            phase: "exact-comparisons",
            completed,
            total: suspicious.size,
            unit: "products",
            detail: "Verifying exact marketplace listings",
          });
        }
      }),
    ).then(() => undefined);
    this.exactComparisonLoads.set(snapshot, load);
    try {
      await load;
    } finally {
      if (this.exactComparisonLoads.get(snapshot) === load) {
        this.exactComparisonLoads.delete(snapshot);
      }
    }
  }

  private async loadComparisonRecoveries(
    snapshot: MarketplaceSnapshot,
    groups: ReadonlyMap<
      string,
      {
        readonly conditions: readonly string[];
        readonly contexts: readonly SellerListingContext[];
      }
    >,
    onProgress?: (progress: RepricingProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const total = [...groups.values()].reduce((count, group) => {
      const productCount = new Set(
        group.contexts.map((context) => context.product.productId),
      ).size;
      return count + Math.ceil(productCount / 24) * 2;
    }, 0);
    let completed = 0;
    onProgress?.({
      phase: "comparisons",
      completed,
      total,
      unit: "batches",
      detail: "Loading marketplace comparison batches",
    });
    for (const [groupKey, group] of groups) {
      const [printing, language] = JSON.parse(groupKey) as [string, string];
      const productIds = [
        ...new Set(group.contexts.map((context) => context.product.productId)),
      ];
      for (const productIdChunk of chunks(productIds, 24)) {
        const samples = new Map<number, MarketplaceComparisonSample>(
          productIdChunk.map((productId) => [
            productId,
            emptyComparisonSample(),
          ]),
        );
        for (const channelId of [0, 1]) {
          const request = {
            productIds: productIdChunk,
            conditions: group.conditions,
            printings: [printing],
            languages: [language],
            channelId,
            limit: 24,
          };
          const result =
            signal === undefined
              ? await this.client.searchMarketplaceProducts(request)
              : await this.client.searchMarketplaceProducts(request, {
                  signal,
                });
          completed += 1;
          onProgress?.({
            phase: "comparisons",
            completed,
            total,
            unit: "batches",
            detail: "Loading marketplace comparison batches",
          });
          for (const product of result.products) {
            samples.set(
              product.productId,
              mergeComparisonProduct(
                samples.get(product.productId) ?? emptyComparisonSample(),
                product,
                channelId,
              ),
            );
          }
        }
        for (const context of group.contexts) {
          if (!productIdChunk.includes(context.product.productId)) continue;
          snapshot.comparisonRecoveries.set(
            comparisonRecoveryKey(context, group.conditions),
            samples.get(context.product.productId) ?? emptyComparisonSample(),
          );
        }
      }
    }
  }
}
