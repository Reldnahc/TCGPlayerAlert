import { randomUUID } from "node:crypto";
import type {
  MarketplaceListing,
  MarketplaceProduct,
  SellerPriceUpdate,
  TcgplayerSellerClient,
} from "tcgplayer-private-api";
import { ConfigurationError } from "./errors.js";

export const TCGPLAYER_CONDITION_ORDER = [
  "Near Mint",
  "Lightly Played",
  "Moderately Played",
  "Heavily Played",
  "Damaged",
] as const;

export type RepricingConditionPolicy = "same" | "same-or-better";
export type RepricingPriceBasis = "item" | "delivered";
export type RepricingPriceSource = "lowest" | "market";
export type RepricingGapAction = "follow-lowest" | "use-next" | "skip";

export interface RepricingRange {
  readonly maximumPrice?: number;
  readonly priceSource: RepricingPriceSource;
  readonly percentage: number;
  readonly gapThresholdPercent: number;
  readonly gapAction: RepricingGapAction;
}

export interface RepricingRules {
  readonly minimumPrice: number;
  readonly conditionPolicy: RepricingConditionPolicy;
  readonly priceBasis: RepricingPriceBasis;
  /** Zero matches the competitor; one undercuts by one cent. */
  readonly adjustmentCents: number;
  readonly allowPriceIncreases: boolean;
  readonly ranges: readonly RepricingRange[];
}

export type RepricingRowStatus = "ready" | "unchanged" | "skipped";

export interface RepricingPreviewRow {
  readonly id: string;
  readonly productId: number;
  readonly productConditionId: number;
  readonly productName: string;
  readonly productLineName: string;
  readonly setName: string;
  readonly condition: string;
  readonly printing: string;
  readonly language: string;
  readonly quantity: number;
  readonly currentPrice: number;
  readonly currentShipping: number;
  readonly proposedPrice: number;
  readonly competitorPrice?: number;
  readonly competitorShipping?: number;
  readonly competitorCondition?: string;
  readonly marketPrice?: number;
  readonly lowestPrice?: number;
  readonly lowestShipping?: number;
  readonly nextLowestPrice?: number;
  readonly nextLowestShipping?: number;
  readonly gapPercent?: number;
  readonly gapActionApplied?: Exclude<RepricingGapAction, "follow-lowest">;
  readonly pricingSource?: RepricingPriceSource | "next-lowest";
  readonly pricingPercentage?: number;
  readonly rangeMaximumPrice?: number;
  readonly minimumApplied: boolean;
  readonly status: RepricingRowStatus;
  readonly reason: string;
  readonly queueable: boolean;
}

export interface RepricingPreview {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly rules: RepricingRules;
  readonly rows: readonly RepricingPreviewRow[];
  readonly counts: Readonly<Record<RepricingRowStatus, number>>;
}

interface SellerListingContext {
  readonly product: MarketplaceProduct;
  readonly listing: MarketplaceListing;
}

interface StoredPreview {
  readonly expiresAt: number;
  readonly updates: ReadonlyMap<string, SellerPriceUpdate>;
}

export interface RepricingServiceOptions {
  readonly client: Pick<
    TcgplayerSellerClient,
    "listSellerInventory" | "searchMarketplaceProducts"
  >;
  readonly sellerKey: string;
  readonly now?: () => Date;
  readonly id?: () => string;
  readonly previewLifetimeMs?: number;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseRepricingRules(value: unknown): RepricingRules {
  const source = objectValue(value);
  const issues: string[] = [];
  if (source === undefined) issues.push("Repricing rules must be an object.");
  const minimumPrice = source?.minimumPrice;
  if (
    typeof minimumPrice !== "number" ||
    !Number.isFinite(minimumPrice) ||
    minimumPrice < 0.01 ||
    minimumPrice > 1_000_000 ||
    !hasAtMostTwoDecimals(minimumPrice)
  ) {
    issues.push(
      "Minimum price must be $0.01-$1,000,000 with at most two decimals.",
    );
  }
  const conditionPolicy = source?.conditionPolicy;
  if (conditionPolicy !== "same" && conditionPolicy !== "same-or-better") {
    issues.push("Condition policy must be same or same-or-better.");
  }
  const priceBasis = source?.priceBasis;
  if (priceBasis !== "item" && priceBasis !== "delivered") {
    issues.push("Price basis must be item or delivered.");
  }
  const adjustmentCents = source?.adjustmentCents;
  if (
    !Number.isInteger(adjustmentCents) ||
    Number(adjustmentCents) < 0 ||
    Number(adjustmentCents) > 100_000
  ) {
    issues.push("Adjustment must be between 0 and 100,000 cents.");
  }
  if (typeof source?.allowPriceIncreases !== "boolean") {
    issues.push("Allow-price-increases must be true or false.");
  }
  const ranges = parseRepricingRanges(source?.ranges, issues);
  if (issues.length > 0) throw new ConfigurationError(issues);
  return {
    minimumPrice: Number(minimumPrice),
    conditionPolicy: conditionPolicy as RepricingConditionPolicy,
    priceBasis: priceBasis as RepricingPriceBasis,
    adjustmentCents: Number(adjustmentCents),
    allowPriceIncreases: source?.allowPriceIncreases as boolean,
    ranges,
  };
}

function parseRepricingRanges(
  value: unknown,
  issues: string[],
): readonly RepricingRange[] {
  if (value === undefined) {
    return [
      {
        priceSource: "lowest",
        percentage: 100,
        gapThresholdPercent: 0,
        gapAction: "follow-lowest",
      },
    ];
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    issues.push("Repricing ranges must contain between 1 and 20 ranges.");
    return [];
  }
  let previousMaximum = 0;
  return value.map((entry, index) => {
    const range = objectValue(entry);
    const path = `Repricing range ${String(index + 1)}`;
    const maximumPrice = range?.maximumPrice;
    if (index < value.length - 1) {
      if (
        typeof maximumPrice !== "number" ||
        !Number.isFinite(maximumPrice) ||
        maximumPrice <= previousMaximum ||
        maximumPrice > 1_000_000 ||
        !hasAtMostTwoDecimals(maximumPrice)
      ) {
        issues.push(
          `${path} maximum price must increase and be at most $1,000,000 with two decimals.`,
        );
      } else {
        previousMaximum = maximumPrice;
      }
    } else if (maximumPrice !== undefined) {
      issues.push("The final repricing range must have no maximum price.");
    }
    const priceSource = range?.priceSource;
    if (priceSource !== "lowest" && priceSource !== "market") {
      issues.push(`${path} price source must be lowest or market.`);
    }
    const percentage = range?.percentage;
    if (
      typeof percentage !== "number" ||
      !Number.isFinite(percentage) ||
      percentage < 1 ||
      percentage > 500
    ) {
      issues.push(`${path} percentage must be between 1 and 500.`);
    }
    const gapThresholdPercent = range?.gapThresholdPercent;
    if (
      typeof gapThresholdPercent !== "number" ||
      !Number.isFinite(gapThresholdPercent) ||
      gapThresholdPercent < 0 ||
      gapThresholdPercent > 10_000
    ) {
      issues.push(`${path} gap threshold must be between 0 and 10,000%.`);
    }
    const gapAction = range?.gapAction;
    if (
      gapAction !== "follow-lowest" &&
      gapAction !== "use-next" &&
      gapAction !== "skip"
    ) {
      issues.push(`${path} gap action is invalid.`);
    }
    return {
      ...(index < value.length - 1 && typeof maximumPrice === "number"
        ? { maximumPrice }
        : {}),
      priceSource: priceSource as RepricingPriceSource,
      percentage: Number(percentage),
      gapThresholdPercent: Number(gapThresholdPercent),
      gapAction: gapAction as RepricingGapAction,
    };
  });
}

function hasAtMostTwoDecimals(value: number): boolean {
  return Math.abs(value * 100 - Math.round(value * 100)) <= 1e-9;
}

function allowedConditions(
  condition: string,
  policy: RepricingConditionPolicy,
): readonly string[] | undefined {
  if (policy === "same") return [condition];
  const index = TCGPLAYER_CONDITION_ORDER.indexOf(
    condition as (typeof TCGPLAYER_CONDITION_ORDER)[number],
  );
  return index === -1
    ? undefined
    : TCGPLAYER_CONDITION_ORDER.slice(0, index + 1);
}

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function listingBasis(
  listing: MarketplaceListing,
  basis: RepricingPriceBasis,
): number {
  return listing.price + (basis === "delivered" ? listing.shippingPrice : 0);
}

function matchingRange(
  referencePrice: number,
  ranges: readonly RepricingRange[],
): RepricingRange {
  const match = ranges.find(
    (range) =>
      range.maximumPrice === undefined || referencePrice <= range.maximumPrice,
  );
  if (match !== undefined) return match;
  const finalRange = ranges.at(-1);
  if (finalRange === undefined) {
    throw new ConfigurationError(["At least one repricing range is required."]);
  }
  return finalRange;
}

export function calculateRepricingRow(
  own: SellerListingContext,
  comparisonListings: readonly MarketplaceListing[],
  sellerKey: string,
  rules: RepricingRules,
  rowId: string = randomUUID(),
): RepricingPreviewRow {
  const base = {
    id: rowId,
    productId: own.product.productId,
    productConditionId: own.listing.productConditionId,
    productName: own.product.productName,
    productLineName: own.product.productLineName,
    setName: own.product.setName,
    condition: own.listing.condition,
    printing: own.listing.printing,
    language: own.listing.language,
    quantity: own.listing.quantity,
    currentPrice: own.listing.price,
    currentShipping: own.listing.shippingPrice,
  };
  if (own.listing.customData.customListingId !== undefined) {
    return skippedRow(base, "Custom listings are not changed automatically.");
  }
  const conditions = allowedConditions(
    own.listing.condition,
    rules.conditionPolicy,
  );
  if (conditions === undefined) {
    return skippedRow(base, "This listing uses an unsupported condition.");
  }
  const candidates = comparisonListings
    .filter(
      (listing) =>
        listing.productId === own.listing.productId &&
        listing.sellerKey !== sellerKey &&
        listing.channelId === own.listing.channelId &&
        listing.printing === own.listing.printing &&
        listing.languageId === own.listing.languageId &&
        conditions.includes(listing.condition) &&
        listing.quantity > 0 &&
        listing.customData.customListingId === undefined,
    )
    .sort((left, right) => {
      const priceDifference =
        listingBasis(left, rules.priceBasis) -
        listingBasis(right, rules.priceBasis);
      return priceDifference === 0
        ? left.productConditionId - right.productConditionId
        : priceDifference;
    });
  const lowest = candidates[0];
  const nextLowest = candidates[1];
  const lowestBasis =
    lowest === undefined ? undefined : listingBasis(lowest, rules.priceBasis);
  const nextLowestBasis =
    nextLowest === undefined
      ? undefined
      : listingBasis(nextLowest, rules.priceBasis);
  const marketPrice =
    own.product.marketPrice > 0 ? own.product.marketPrice : undefined;
  const rangeReference = marketPrice ?? lowestBasis;
  if (rangeReference === undefined) {
    return skippedRow(
      base,
      "No market price or qualifying competing listing was found.",
    );
  }
  const range = matchingRange(rangeReference, rules.ranges);
  const gapPercent =
    nextLowestBasis === undefined ||
    lowestBasis === undefined ||
    lowestBasis <= 0
      ? undefined
      : ((nextLowestBasis - lowestBasis) / lowestBasis) * 100;
  const gapDetected =
    range.gapAction !== "follow-lowest" &&
    gapPercent !== undefined &&
    gapPercent >= range.gapThresholdPercent;
  const rangeDetails = {
    ...(marketPrice === undefined ? {} : { marketPrice }),
    ...(lowest === undefined
      ? {}
      : {
          lowestPrice: lowest.price,
          lowestShipping: lowest.shippingPrice,
        }),
    ...(nextLowest === undefined
      ? {}
      : {
          nextLowestPrice: nextLowest.price,
          nextLowestShipping: nextLowest.shippingPrice,
        }),
    ...(gapPercent === undefined ? {} : { gapPercent }),
    pricingPercentage: range.percentage,
    ...(range.maximumPrice === undefined
      ? {}
      : { rangeMaximumPrice: range.maximumPrice }),
  };
  if (gapDetected && range.gapAction === "skip") {
    return {
      ...base,
      ...rangeDetails,
      gapActionApplied: "skip",
      proposedPrice: own.listing.price,
      minimumApplied: false,
      status: "skipped",
      reason: `The lowest listing is ${gapPercent.toFixed(1)}% below the next listing, so this range waits without changing the price.`,
      queueable: false,
    };
  }
  const useNext = gapDetected && range.gapAction === "use-next";
  const referenceListing = useNext
    ? nextLowest
    : range.priceSource === "lowest"
      ? lowest
      : undefined;
  if (useNext && referenceListing === undefined) {
    return skippedRow(
      base,
      "No second qualifying listing was found for the configured gap rule.",
    );
  }
  if (range.priceSource === "lowest" && referenceListing === undefined) {
    return skippedRow(
      base,
      "No qualifying competing listing was found for this range.",
    );
  }
  if (referenceListing === undefined && marketPrice === undefined) {
    return skippedRow(
      base,
      "No market price was available for the selected pricing range.",
    );
  }
  const pricingSource: RepricingPriceSource | "next-lowest" = useNext
    ? "next-lowest"
    : range.priceSource;
  let sourcePrice: number;
  if (referenceListing !== undefined) {
    sourcePrice = listingBasis(referenceListing, rules.priceBasis);
  } else if (marketPrice !== undefined) {
    sourcePrice = marketPrice;
  } else {
    return skippedRow(
      base,
      "No price reference was available for the selected pricing range.",
    );
  }
  const rawTarget =
    (sourcePrice * range.percentage) / 100 -
    (referenceListing !== undefined && rules.priceBasis === "delivered"
      ? own.listing.shippingPrice
      : 0) -
    rules.adjustmentCents / 100;
  const minimumApplied = rawTarget < rules.minimumPrice;
  const target = roundCurrency(Math.max(rules.minimumPrice, rawTarget));
  const comparison = {
    ...rangeDetails,
    ...(referenceListing === undefined
      ? {}
      : {
          competitorPrice: referenceListing.price,
          competitorShipping: referenceListing.shippingPrice,
          competitorCondition: referenceListing.condition,
        }),
    ...(useNext ? { gapActionApplied: "use-next" as const } : {}),
    pricingSource,
    minimumApplied,
  };
  const strategyReason = useNext
    ? `The lowest listing is ${gapPercent.toFixed(1)}% below the next listing, so this range uses ${String(range.percentage)}% of the next listing.`
    : range.priceSource === "market"
      ? `Uses ${String(range.percentage)}% of market price.`
      : `Uses ${String(range.percentage)}% of the lowest qualifying listing.`;
  if (target === own.listing.price) {
    return {
      ...base,
      ...comparison,
      proposedPrice: target,
      status: "unchanged",
      reason: minimumApplied
        ? "Already at the configured minimum."
        : `Already matches the profile target. ${strategyReason}`,
      queueable: false,
    };
  }
  if (target > own.listing.price && !rules.allowPriceIncreases) {
    return {
      ...base,
      ...comparison,
      proposedPrice: own.listing.price,
      status: "unchanged",
      reason: "Already below the target; price increases are disabled.",
      queueable: false,
    };
  }
  return {
    ...base,
    ...comparison,
    proposedPrice: target,
    status: "ready",
    reason: minimumApplied
      ? "The minimum price overrides the calculated target."
      : strategyReason,
    queueable: true,
  };
}

function skippedRow(
  base: Omit<
    RepricingPreviewRow,
    "proposedPrice" | "minimumApplied" | "status" | "reason" | "queueable"
  >,
  reason: string,
): RepricingPreviewRow {
  return {
    ...base,
    proposedPrice: base.currentPrice,
    minimumApplied: false,
    status: "skipped",
    reason,
    queueable: false,
  };
}

function comparisonGroupKey(
  listing: MarketplaceListing,
  rules: RepricingRules,
): string | undefined {
  const conditions = allowedConditions(
    listing.condition,
    rules.conditionPolicy,
  );
  return conditions === undefined
    ? undefined
    : JSON.stringify([conditions, listing.printing, listing.language]);
}

function chunks<T>(values: readonly T[], size: number): readonly T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

export class RepricingService {
  private readonly client: RepricingServiceOptions["client"];
  private readonly sellerKey: string;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly previewLifetimeMs: number;
  private readonly previews = new Map<string, StoredPreview>();

  constructor(options: RepricingServiceOptions) {
    this.client = options.client;
    this.sellerKey = options.sellerKey;
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.previewLifetimeMs = options.previewLifetimeMs ?? 15 * 60_000;
  }

  async preview(value: unknown): Promise<RepricingPreview> {
    const rules = parseRepricingRules(value);
    this.removeExpiredPreviews();
    const [inventory, secondaryInventory] = await Promise.all([
      this.client.listSellerInventory({
        sellerKey: this.sellerKey,
        channelId: 0,
      }),
      this.client.listSellerInventory({
        sellerKey: this.sellerKey,
        channelId: 1,
      }),
    ]);
    const secondarySkus = new Set(
      secondaryInventory.flatMap((product) =>
        product.listings.map((listing) => listing.productConditionId),
      ),
    );
    const sellerListings: SellerListingContext[] = inventory.flatMap(
      (product) =>
        product.listings
          .filter((listing) => listing.sellerKey === this.sellerKey)
          .map((listing) => ({ product, listing })),
    );
    const groups = new Map<string, SellerListingContext[]>();
    for (const context of sellerListings) {
      const key = comparisonGroupKey(context.listing, rules);
      if (key === undefined) continue;
      const group = groups.get(key) ?? [];
      group.push(context);
      groups.set(key, group);
    }
    const comparisons = new Map<number, MarketplaceListing[]>();
    for (const [key, contexts] of groups) {
      const [conditions, printing, language] = JSON.parse(key) as [
        string[],
        string,
        string,
      ];
      const productIds = [
        ...new Set(contexts.map((context) => context.product.productId)),
      ];
      for (const productIdChunk of chunks(productIds, 24)) {
        const result = await this.client.searchMarketplaceProducts({
          productIds: productIdChunk,
          conditions,
          printings: [printing],
          languages: [language],
          channelId: 0,
          limit: 24,
        });
        for (const product of result.products) {
          const listings = comparisons.get(product.productId) ?? [];
          listings.push(...product.listings);
          comparisons.set(product.productId, listings);
        }
      }
    }

    const updates = new Map<string, SellerPriceUpdate>();
    const rows = sellerListings.map((context) => {
      const row = secondarySkus.has(context.listing.productConditionId)
        ? skippedRow(
            {
              id: this.id(),
              productId: context.product.productId,
              productConditionId: context.listing.productConditionId,
              productName: context.product.productName,
              productLineName: context.product.productLineName,
              setName: context.product.setName,
              condition: context.listing.condition,
              printing: context.listing.printing,
              language: context.listing.language,
              quantity: context.listing.quantity,
              currentPrice: context.listing.price,
              currentShipping: context.listing.shippingPrice,
            },
            "This SKU also has secondary-channel inventory, so reserve quantity cannot be changed safely.",
          )
        : calculateRepricingRow(
            context,
            comparisons.get(context.product.productId) ?? [],
            this.sellerKey,
            rules,
            this.id(),
          );
      if (row.queueable) {
        updates.set(row.id, {
          productId: context.product.productId,
          productName: context.product.productName,
          productConditionId: context.listing.productConditionId,
          conditionId: context.listing.conditionId,
          channelId: context.listing.channelId,
          categoryName: context.product.productLineName,
          quantity: context.listing.quantity,
          price: row.proposedPrice,
          storePriceCustomId: null,
          reserveQuantity: 0,
        });
      }
      return row;
    });
    rows.sort(
      (left, right) =>
        left.productLineName.localeCompare(right.productLineName) ||
        left.setName.localeCompare(right.setName) ||
        left.productName.localeCompare(right.productName) ||
        left.condition.localeCompare(right.condition),
    );
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.previewLifetimeMs);
    const previewId = this.id();
    this.previews.set(previewId, {
      expiresAt: expiresAt.getTime(),
      updates,
    });
    return {
      id: previewId,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      rules,
      rows,
      counts: {
        ready: rows.filter((row) => row.status === "ready").length,
        unchanged: rows.filter((row) => row.status === "unchanged").length,
        skipped: rows.filter((row) => row.status === "skipped").length,
      },
    };
  }

  takeUpdates(previewId: string, value: unknown): readonly SellerPriceUpdate[] {
    this.removeExpiredPreviews();
    const preview = this.previews.get(previewId);
    if (preview === undefined) {
      throw new ConfigurationError([
        "The repricing preview expired or does not exist. Refresh inventory and preview again.",
      ]);
    }
    const source = objectValue(value);
    const rowIds = source?.rowIds;
    if (
      !Array.isArray(rowIds) ||
      rowIds.length === 0 ||
      rowIds.length > 100 ||
      rowIds.some((rowId) => typeof rowId !== "string") ||
      new Set(rowIds).size !== rowIds.length
    ) {
      throw new ConfigurationError([
        "Choose 1-100 distinct repricing rows to queue.",
      ]);
    }
    const updates = rowIds.map((rowId) => preview.updates.get(String(rowId)));
    if (updates.some((update) => update === undefined)) {
      throw new ConfigurationError([
        "The selection contains a row that is not eligible for repricing.",
      ]);
    }
    this.previews.delete(previewId);
    return updates as SellerPriceUpdate[];
  }

  private removeExpiredPreviews(): void {
    const now = this.now().getTime();
    for (const [id, preview] of this.previews) {
      if (preview.expiresAt <= now) this.previews.delete(id);
    }
  }
}
