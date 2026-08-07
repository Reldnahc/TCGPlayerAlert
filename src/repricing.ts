import { randomUUID } from "node:crypto";
import type {
  MarketplaceListing,
  MarketplaceProduct,
  SellerInventoryRemoval,
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
export type RepricingSupportMode = "adjacent" | "cluster";
export type SparseMarketFallback =
  | "skip"
  | "higher-of-market-and-lowest"
  | "market-then-lowest"
  | "lowest-then-market";

export interface RepricingRange {
  readonly maximumPrice?: number;
  readonly minimumListings?: number;
  readonly priceSource: RepricingPriceSource;
  readonly percentage: number;
  readonly gapThresholdPercent: number;
  readonly gapAction: RepricingGapAction;
  /** Missing on profiles saved before cluster support; preserve their adjacent-listing behavior. */
  readonly supportMode?: RepricingSupportMode;
  readonly minimumSellerSupport?: number;
  readonly supportWindowPercent?: number;
}

export interface RepricingRules {
  readonly minimumPrice: number;
  readonly conditionPolicy: RepricingConditionPolicy;
  readonly priceBasis: RepricingPriceBasis;
  /** Zero matches the competitor; one undercuts by one cent. */
  readonly adjustmentCents: number;
  readonly allowPriceIncreases: boolean;
  /** Missing preserves the pre-fallback behavior for programmatic consumers. */
  readonly sparseMarketFallback?: SparseMarketFallback;
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
  readonly qualifyingListings?: number;
  readonly comparisonSampleIncomplete?: boolean;
  readonly distinctSellers?: number;
  readonly minimumQualifyingListings?: number;
  readonly supportMode?: RepricingSupportMode;
  readonly lowestSellerSupport?: number;
  readonly minimumSellerSupport?: number;
  readonly supportWindowPercent?: number;
  readonly supportedClusterPrice?: number;
  readonly supportedClusterShipping?: number;
  readonly supportedClusterSellerCount?: number;
  readonly gapActionApplied?: Exclude<RepricingGapAction, "follow-lowest">;
  readonly pricingSource?:
    RepricingPriceSource | "next-lowest" | "supported-cluster";
  readonly pricingPercentage?: number;
  readonly sparseMarketFallbackApplied?: Exclude<SparseMarketFallback, "skip">;
  readonly rangeMaximumPrice?: number;
  readonly minimumApplied: boolean;
  readonly status: RepricingRowStatus;
  readonly reason: string;
  readonly queueable: boolean;
  readonly removable?: boolean;
  readonly removalReason?: string;
}

export interface RepricingPreview {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly rules: RepricingRules;
  readonly rows: readonly RepricingPreviewRow[];
  readonly counts: Readonly<Record<RepricingRowStatus, number>>;
  readonly totals: {
    readonly listingCount: number;
    readonly totalQuantity: number;
    readonly currentListingValue: number;
  };
  readonly marketplaceSnapshot: {
    readonly capturedAt: string;
    readonly expiresAt: string;
    readonly source: "fresh" | "cache" | "shared";
  };
}

interface SellerListingContext {
  readonly product: MarketplaceProduct;
  readonly listing: MarketplaceListing;
}

interface StoredPreview {
  readonly expiresAt: number;
  readonly updates: ReadonlyMap<string, SellerPriceUpdate>;
  readonly removals: ReadonlyMap<string, SellerInventoryRemoval>;
}

interface MarketplaceSnapshot {
  readonly inventory: readonly MarketplaceProduct[];
  readonly secondaryInventory: readonly MarketplaceProduct[];
  readonly comparisonRecoveries: Map<string, MarketplaceComparisonSample>;
  readonly capturedAt: Date;
  readonly expiresAt: Date;
}

interface MarketplaceComparisonSample {
  readonly listings: readonly MarketplaceListing[];
  readonly marketplaceTotalListings: number;
  readonly marketplaceReturnedListings: number;
}

interface RepricingComparisonEvidence {
  readonly reportedQualifyingListings?: number;
  readonly incomplete?: boolean;
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
  readonly marketplaceCacheLifetimeMs?: number;
}

export interface RepricingPreviewOptions {
  readonly forceRefresh?: boolean;
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
  const sparseMarketFallback = source?.sparseMarketFallback ?? "skip";
  if (
    sparseMarketFallback !== "skip" &&
    sparseMarketFallback !== "higher-of-market-and-lowest" &&
    sparseMarketFallback !== "market-then-lowest" &&
    sparseMarketFallback !== "lowest-then-market"
  ) {
    issues.push("Sparse-market fallback is invalid.");
  }
  const ranges = parseRepricingRanges(source?.ranges, issues);
  if (issues.length > 0) throw new ConfigurationError(issues);
  return {
    minimumPrice: Number(minimumPrice),
    conditionPolicy: conditionPolicy as RepricingConditionPolicy,
    priceBasis: priceBasis as RepricingPriceBasis,
    adjustmentCents: Number(adjustmentCents),
    allowPriceIncreases: source?.allowPriceIncreases as boolean,
    sparseMarketFallback: sparseMarketFallback as SparseMarketFallback,
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
        minimumListings: 0,
        priceSource: "lowest",
        percentage: 100,
        gapThresholdPercent: 0,
        gapAction: "follow-lowest",
        supportMode: "adjacent",
        minimumSellerSupport: 2,
        supportWindowPercent: 5,
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
    const minimumListings =
      range?.minimumListings === undefined ? 0 : range.minimumListings;
    if (
      !Number.isInteger(minimumListings) ||
      Number(minimumListings) < 0 ||
      Number(minimumListings) > 100
    ) {
      issues.push(`${path} minimum listings must be between 0 and 100.`);
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
    const supportMode = range?.supportMode ?? "adjacent";
    if (supportMode !== "adjacent" && supportMode !== "cluster") {
      issues.push(`${path} support mode is invalid.`);
    }
    const minimumSellerSupport = range?.minimumSellerSupport ?? 2;
    if (
      !Number.isInteger(minimumSellerSupport) ||
      Number(minimumSellerSupport) < 1 ||
      Number(minimumSellerSupport) > 100
    ) {
      issues.push(`${path} minimum seller support must be between 1 and 100.`);
    }
    const supportWindowPercent = range?.supportWindowPercent ?? 5;
    if (
      typeof supportWindowPercent !== "number" ||
      !Number.isFinite(supportWindowPercent) ||
      supportWindowPercent < 0 ||
      supportWindowPercent > 100
    ) {
      issues.push(`${path} support window must be between 0 and 100%.`);
    }
    return {
      ...(index < value.length - 1 && typeof maximumPrice === "number"
        ? { maximumPrice }
        : {}),
      minimumListings: Number(minimumListings),
      priceSource: priceSource as RepricingPriceSource,
      percentage: Number(percentage),
      gapThresholdPercent: Number(gapThresholdPercent),
      gapAction: gapAction as RepricingGapAction,
      supportMode: supportMode as RepricingSupportMode,
      minimumSellerSupport: Number(minimumSellerSupport),
      supportWindowPercent: Number(supportWindowPercent),
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

function isVerifiedDirectListing(listing: MarketplaceListing): boolean {
  return (
    listing.channelId === 1 &&
    listing.directListing === true &&
    listing.directProduct === true &&
    listing.directSeller === true &&
    Number.isSafeInteger(listing.directInventory) &&
    (listing.directInventory ?? 0) > 0 &&
    listing.listingType === "standard" &&
    listing.sellerPrograms?.includes("DirectViewable") === true &&
    listing.quantity > 0
  );
}

interface SupportedSellerCluster {
  readonly listing: MarketplaceListing;
  readonly sellerCount: number;
}

interface SparseMarketReference {
  readonly listing?: MarketplaceListing;
  readonly marketPrice?: number;
  readonly source: "lowest" | "market";
}

function sparseMarketReference(
  fallback: Exclude<SparseMarketFallback, "skip">,
  lowest: MarketplaceListing | undefined,
  lowestBasis: number | undefined,
  marketPrice: number | undefined,
): SparseMarketReference | undefined {
  if (fallback === "lowest-then-market") {
    if (lowest !== undefined) return { listing: lowest, source: "lowest" };
    return marketPrice === undefined
      ? undefined
      : { marketPrice, source: "market" };
  }
  if (fallback === "market-then-lowest") {
    if (marketPrice !== undefined) return { marketPrice, source: "market" };
    return lowest === undefined
      ? undefined
      : { listing: lowest, source: "lowest" };
  }
  if (
    lowest !== undefined &&
    lowestBasis !== undefined &&
    (marketPrice === undefined || lowestBasis >= marketPrice)
  ) {
    return { listing: lowest, source: "lowest" };
  }
  return marketPrice === undefined
    ? undefined
    : { marketPrice, source: "market" };
}

function cheapestListingsBySeller(
  candidates: readonly MarketplaceListing[],
): readonly MarketplaceListing[] {
  const seen = new Set<string>();
  return candidates.filter((listing) => {
    if (seen.has(listing.sellerKey)) return false;
    seen.add(listing.sellerKey);
    return true;
  });
}

function sellerSupportAt(
  listings: readonly MarketplaceListing[],
  index: number,
  basis: RepricingPriceBasis,
  windowPercent: number,
): number {
  const anchor = listings[index];
  if (anchor === undefined) return 0;
  const maximum = listingBasis(anchor, basis) * (1 + windowPercent / 100);
  let count = 0;
  for (
    let candidateIndex = index;
    candidateIndex < listings.length;
    candidateIndex += 1
  ) {
    const candidate = listings[candidateIndex];
    if (candidate === undefined || listingBasis(candidate, basis) > maximum)
      break;
    count += 1;
  }
  return count;
}

function cheapestSupportedCluster(
  listings: readonly MarketplaceListing[],
  basis: RepricingPriceBasis,
  windowPercent: number,
  minimumSellerSupport: number,
): SupportedSellerCluster | undefined {
  for (let index = 0; index < listings.length; index += 1) {
    const sellerCount = sellerSupportAt(listings, index, basis, windowPercent);
    if (sellerCount >= minimumSellerSupport) {
      const listing = listings[index];
      if (listing !== undefined) return { listing, sellerCount };
    }
  }
  return undefined;
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
  evidence: RepricingComparisonEvidence = {},
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
        (listing.channelId === 0 || isVerifiedDirectListing(listing)) &&
        listing.printing === own.listing.printing &&
        listing.language === own.listing.language &&
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
  const sellerListings = cheapestListingsBySeller(candidates);
  const lowestBasis =
    lowest === undefined ? undefined : listingBasis(lowest, rules.priceBasis);
  const marketPrice =
    own.product.marketPrice > 0 ? own.product.marketPrice : undefined;
  // The exact filtered marketplace comparison is a better value-tier signal
  // than the product-level market figure carried by the inventory response.
  const rangeReference = lowestBasis ?? marketPrice;
  if (rangeReference === undefined) {
    return skippedRow(
      base,
      "No market price or qualifying competing listing was found.",
    );
  }
  const range = matchingRange(rangeReference, rules.ranges);
  const minimumListings = range.minimumListings ?? 0;
  const supportMode = range.supportMode ?? "adjacent";
  const minimumSellerSupport = range.minimumSellerSupport ?? 2;
  const supportWindowPercent = range.supportWindowPercent ?? 5;
  const supportedCluster =
    supportMode === "cluster"
      ? cheapestSupportedCluster(
          sellerListings,
          rules.priceBasis,
          supportWindowPercent,
          minimumSellerSupport,
        )
      : undefined;
  const gapReferenceListing =
    supportMode === "cluster" ? supportedCluster?.listing : nextLowest;
  const gapReferenceBasis =
    gapReferenceListing === undefined
      ? undefined
      : listingBasis(gapReferenceListing, rules.priceBasis);
  const gapPercent =
    gapReferenceBasis === undefined ||
    lowestBasis === undefined ||
    lowestBasis <= 0
      ? undefined
      : ((gapReferenceBasis - lowestBasis) / lowestBasis) * 100;
  const sparseMarketFallback = rules.sparseMarketFallback ?? "skip";
  const qualifyingListingCount = Math.max(
    candidates.length,
    evidence.reportedQualifyingListings ?? 0,
  );
  const insufficientListings = qualifyingListingCount < minimumListings;
  const unsupportedSellerBand =
    supportMode === "cluster" &&
    range.gapAction !== "follow-lowest" &&
    supportedCluster === undefined;
  const selectedSourceUnavailable =
    (range.priceSource === "lowest" && lowest === undefined) ||
    (range.priceSource === "market" && marketPrice === undefined);
  const sparseMarketFallbackRequired =
    insufficientListings || unsupportedSellerBand || selectedSourceUnavailable;
  const fallbackReference =
    sparseMarketFallbackRequired && sparseMarketFallback !== "skip"
      ? sparseMarketReference(
          sparseMarketFallback,
          lowest,
          lowestBasis,
          marketPrice,
        )
      : undefined;
  const sparseMarketFallbackApplied = fallbackReference !== undefined;
  const appliedSparseMarketFallback = sparseMarketFallbackApplied
    ? (sparseMarketFallback as Exclude<SparseMarketFallback, "skip">)
    : undefined;
  const gapDetected =
    !sparseMarketFallbackApplied &&
    range.gapAction !== "follow-lowest" &&
    gapPercent !== undefined &&
    (supportMode === "adjacent" || gapPercent > 0) &&
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
    qualifyingListings: qualifyingListingCount,
    ...(evidence.incomplete === true
      ? { comparisonSampleIncomplete: true }
      : {}),
    distinctSellers: sellerListings.length,
    minimumQualifyingListings: minimumListings,
    supportMode,
    ...(supportMode === "cluster"
      ? {
          lowestSellerSupport: sellerSupportAt(
            sellerListings,
            0,
            rules.priceBasis,
            supportWindowPercent,
          ),
          minimumSellerSupport,
          supportWindowPercent,
          ...(supportedCluster === undefined
            ? {}
            : {
                supportedClusterPrice: supportedCluster.listing.price,
                supportedClusterShipping:
                  supportedCluster.listing.shippingPrice,
                supportedClusterSellerCount: supportedCluster.sellerCount,
              }),
        }
      : {}),
    pricingPercentage: range.percentage,
    ...(range.maximumPrice === undefined
      ? {}
      : { rangeMaximumPrice: range.maximumPrice }),
  };
  if (insufficientListings && !sparseMarketFallbackApplied) {
    return {
      ...base,
      ...rangeDetails,
      proposedPrice: own.listing.price,
      minimumApplied: false,
      status: "skipped",
      reason: `Found ${String(qualifyingListingCount)} qualifying listing${qualifyingListingCount === 1 ? "" : "s"}; this value range requires at least ${String(minimumListings)}.`,
      queueable: false,
    };
  }
  if (unsupportedSellerBand && !sparseMarketFallbackApplied) {
    return {
      ...base,
      ...rangeDetails,
      proposedPrice: own.listing.price,
      minimumApplied: false,
      status: "skipped",
      reason: `No price band within ${String(supportWindowPercent)}% has support from ${String(minimumSellerSupport)} distinct sellers.`,
      queueable: false,
    };
  }
  if (
    sparseMarketFallbackRequired &&
    sparseMarketFallback !== "skip" &&
    fallbackReference === undefined
  ) {
    return {
      ...base,
      ...rangeDetails,
      proposedPrice: own.listing.price,
      minimumApplied: false,
      status: "skipped",
      reason:
        "The configured sparse-market fallback found neither a market price nor a qualifying listing.",
      queueable: false,
    };
  }
  if (
    sparseMarketFallbackApplied &&
    fallbackReference.source === "market" &&
    evidence.incomplete === true
  ) {
    return {
      ...base,
      ...rangeDetails,
      proposedPrice: own.listing.price,
      minimumApplied: false,
      status: "skipped",
      reason:
        "TCGplayer reports additional matching listings but did not return enough seller details for a safe market-price fallback.",
      queueable: false,
    };
  }
  if (gapDetected && range.gapAction === "skip") {
    return {
      ...base,
      ...rangeDetails,
      gapActionApplied: "skip",
      proposedPrice: own.listing.price,
      minimumApplied: false,
      status: "skipped",
      reason:
        supportMode === "cluster"
          ? `The lowest seller is ${gapPercent.toFixed(1)}% below the supported price band, so this range waits without changing the price.`
          : `The lowest listing is ${gapPercent.toFixed(1)}% below the next listing, so this range waits without changing the price.`,
      queueable: false,
    };
  }
  const useNext = gapDetected && range.gapAction === "use-next";
  const referenceListing = sparseMarketFallbackApplied
    ? fallbackReference.listing
    : useNext
      ? gapReferenceListing
      : range.priceSource === "lowest"
        ? lowest
        : undefined;
  if (useNext && referenceListing === undefined) {
    return skippedRow(
      base,
      supportMode === "cluster"
        ? "No supported seller price band was found for the configured gap rule."
        : "No second qualifying listing was found for the configured gap rule.",
    );
  }
  if (
    !sparseMarketFallbackApplied &&
    range.priceSource === "lowest" &&
    referenceListing === undefined
  ) {
    return skippedRow(
      base,
      "No qualifying competing listing was found for this range.",
    );
  }
  const selectedMarketPrice = sparseMarketFallbackApplied
    ? fallbackReference.marketPrice
    : marketPrice;
  if (referenceListing === undefined && selectedMarketPrice === undefined) {
    return skippedRow(
      base,
      "No market price was available for the selected pricing range.",
    );
  }
  const pricingSource:
    RepricingPriceSource | "next-lowest" | "supported-cluster" = useNext
    ? supportMode === "cluster"
      ? "supported-cluster"
      : "next-lowest"
    : sparseMarketFallbackApplied
      ? fallbackReference.source
      : range.priceSource;
  let sourcePrice: number;
  if (referenceListing !== undefined) {
    sourcePrice = listingBasis(referenceListing, rules.priceBasis);
  } else if (selectedMarketPrice !== undefined) {
    sourcePrice = selectedMarketPrice;
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
    ...(appliedSparseMarketFallback === undefined
      ? {}
      : { sparseMarketFallbackApplied: appliedSparseMarketFallback }),
    pricingSource,
    minimumApplied,
  };
  const strategyReason = sparseMarketFallbackApplied
    ? `Seller support was insufficient, so this profile uses its ${sparseMarketFallback.replaceAll("-", " ")} fallback and prices from the ${fallbackReference.source === "market" ? "market price" : "lowest qualifying listing"}.`
    : useNext
      ? supportMode === "cluster"
        ? `The lowest seller is ${gapPercent.toFixed(1)}% below a price band supported by ${String(supportedCluster?.sellerCount ?? 0)} sellers, so this range uses ${String(range.percentage)}% of that band.`
        : `The lowest listing is ${gapPercent.toFixed(1)}% below the next listing, so this range uses ${String(range.percentage)}% of the next listing.`
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

function comparisonRecoveryKey(
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

function sellerConditionKey(context: SellerListingContext): string {
  return JSON.stringify([
    context.product.productId,
    context.listing.printing,
    context.listing.language,
    context.listing.condition,
  ]);
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

function emptyComparisonSample(): MarketplaceComparisonSample {
  return {
    listings: [],
    marketplaceTotalListings: 0,
    marketplaceReturnedListings: 0,
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
  };
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
  private readonly marketplaceCacheLifetimeMs: number;
  private readonly previews = new Map<string, StoredPreview>();
  private marketplaceCache: MarketplaceSnapshot | undefined;
  private marketplaceLoad: Promise<MarketplaceSnapshot> | undefined;
  private readonly marketplaceRecoveryLoads = new WeakMap<
    MarketplaceSnapshot,
    Promise<void>
  >();

  constructor(options: RepricingServiceOptions) {
    this.client = options.client;
    this.sellerKey = options.sellerKey;
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.previewLifetimeMs = options.previewLifetimeMs ?? 15 * 60_000;
    this.marketplaceCacheLifetimeMs =
      options.marketplaceCacheLifetimeMs ?? 10 * 60_000;
  }

  async preview(
    value: unknown,
    options: RepricingPreviewOptions = {},
  ): Promise<RepricingPreview> {
    const rules = parseRepricingRules(value);
    this.removeExpiredPreviews();
    const { snapshot, source } = await this.marketplaceSnapshot(
      options.forceRefresh === true,
    );
    const { inventory, secondaryInventory } = snapshot;
    const sellerListings: SellerListingContext[] = inventory.flatMap(
      (product) =>
        product.listings
          .filter((listing) => listing.sellerKey === this.sellerKey)
          .map((listing) => ({ product, listing })),
    );
    const secondarySkus = new Set(
      secondaryInventory.flatMap((product) =>
        product.listings.map((listing) => listing.productConditionId),
      ),
    );
    const sellerConditionCounts = new Map<string, number>();
    for (const context of sellerListings) {
      const key = sellerConditionKey(context);
      sellerConditionCounts.set(key, (sellerConditionCounts.get(key) ?? 0) + 1);
    }

    await this.recoverSparseComparisons(
      snapshot,
      sellerListings.filter(
        (context) => !secondarySkus.has(context.listing.productConditionId),
      ),
      rules,
    );

    const updates = new Map<string, SellerPriceUpdate>();
    const removals = new Map<string, SellerInventoryRemoval>();
    const rows = sellerListings.map((context) => {
      const hasSecondaryInventory = secondarySkus.has(
        context.listing.productConditionId,
      );
      const row = hasSecondaryInventory
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
        : (() => {
            const conditions = allowedConditions(
              context.listing.condition,
              rules.conditionPolicy,
            );
            const recoveredSample =
              conditions === undefined
                ? undefined
                : snapshot.comparisonRecoveries.get(
                    comparisonRecoveryKey(context, conditions),
                  );
            const sample = recoveredSample ?? emptyComparisonSample();
            const ownMatchingListings =
              conditions === undefined
                ? 0
                : conditions.reduce(
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
            return calculateRepricingRow(
              context,
              sample.listings,
              this.sellerKey,
              rules,
              this.id(),
              recoveredSample === undefined
                ? {}
                : {
                    reportedQualifyingListings: Math.max(
                      0,
                      sample.marketplaceTotalListings - ownMatchingListings,
                    ),
                    incomplete: comparisonSampleIncomplete(sample),
                  },
            );
          })();
      const removable =
        !hasSecondaryInventory &&
        context.listing.quantity > 0 &&
        context.listing.customData.customListingId === undefined;
      const removalReason = hasSecondaryInventory
        ? "This SKU also has secondary-channel inventory."
        : context.listing.quantity <= 0
          ? "This listing has no available inventory."
          : context.listing.customData.customListingId !== undefined
            ? "Custom listings cannot be removed automatically."
            : undefined;
      const inventoryRow = {
        ...row,
        removable,
        ...(removalReason === undefined ? {} : { removalReason }),
      };
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
      if (removable) {
        removals.set(row.id, {
          productId: context.product.productId,
          productName: context.product.productName,
          productConditionId: context.listing.productConditionId,
          conditionId: context.listing.conditionId,
          channelId: context.listing.channelId,
          categoryName: context.product.productLineName,
          currentQuantity: context.listing.quantity,
          price: context.listing.price,
          storePriceCustomId: null,
          reserveQuantity: 0,
        });
      }
      return inventoryRow;
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
      removals,
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
      totals: {
        listingCount: rows.length,
        totalQuantity: rows.reduce((total, row) => total + row.quantity, 0),
        currentListingValue: roundCurrency(
          rows.reduce(
            (total, row) => total + row.currentPrice * row.quantity,
            0,
          ),
        ),
      },
      marketplaceSnapshot: {
        capturedAt: snapshot.capturedAt.toISOString(),
        expiresAt: snapshot.expiresAt.toISOString(),
        source,
      },
    };
  }

  private async marketplaceSnapshot(forceRefresh: boolean): Promise<{
    readonly snapshot: MarketplaceSnapshot;
    readonly source: "fresh" | "cache" | "shared";
  }> {
    const now = this.now().getTime();
    if (
      !forceRefresh &&
      this.marketplaceCache !== undefined &&
      this.marketplaceCache.expiresAt.getTime() > now
    ) {
      return { snapshot: this.marketplaceCache, source: "cache" };
    }
    if (this.marketplaceLoad !== undefined) {
      return { snapshot: await this.marketplaceLoad, source: "shared" };
    }
    const load = this.loadMarketplaceSnapshot();
    this.marketplaceLoad = load;
    try {
      const snapshot = await load;
      this.marketplaceCache = snapshot;
      return { snapshot, source: "fresh" };
    } finally {
      if (this.marketplaceLoad === load) this.marketplaceLoad = undefined;
    }
  }

  private async loadMarketplaceSnapshot(): Promise<MarketplaceSnapshot> {
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
    const capturedAt = this.now();
    return {
      inventory,
      secondaryInventory,
      comparisonRecoveries: new Map(),
      capturedAt,
      expiresAt: new Date(
        capturedAt.getTime() + this.marketplaceCacheLifetimeMs,
      ),
    };
  }

  private async recoverSparseComparisons(
    snapshot: MarketplaceSnapshot,
    contexts: readonly SellerListingContext[],
    rules: RepricingRules,
  ): Promise<void> {
    if (contexts.length === 0) return;
    const existingLoad = this.marketplaceRecoveryLoads.get(snapshot);
    if (existingLoad !== undefined) {
      await existingLoad;
      return this.recoverSparseComparisons(snapshot, contexts, rules);
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
    const load = this.loadComparisonRecoveries(snapshot, groups);
    this.marketplaceRecoveryLoads.set(snapshot, load);
    try {
      await load;
    } finally {
      if (this.marketplaceRecoveryLoads.get(snapshot) === load) {
        this.marketplaceRecoveryLoads.delete(snapshot);
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
  ): Promise<void> {
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
          const result = await this.client.searchMarketplaceProducts({
            productIds: productIdChunk,
            conditions: group.conditions,
            printings: [printing],
            languages: [language],
            channelId,
            limit: 24,
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

  takeUpdates(previewId: string, value: unknown): readonly SellerPriceUpdate[] {
    this.removeExpiredPreviews();
    const preview = this.previews.get(previewId);
    if (preview === undefined) {
      throw new ConfigurationError([
        "The repricing preview expired or does not exist. Update the preview again.",
      ]);
    }
    const source = objectValue(value);
    const rowIds = source?.rowIds;
    if (
      !Array.isArray(rowIds) ||
      rowIds.length === 0 ||
      rowIds.some((rowId) => typeof rowId !== "string") ||
      new Set(rowIds).size !== rowIds.length
    ) {
      throw new ConfigurationError([
        "Choose one or more distinct repricing rows to queue.",
      ]);
    }
    const updates = rowIds.map((rowId) => preview.updates.get(String(rowId)));
    if (updates.some((update) => update === undefined)) {
      throw new ConfigurationError([
        "The selection contains a row that is not eligible for repricing.",
      ]);
    }
    this.previews.delete(previewId);
    // A queued mutation can make the seller-inventory portion stale immediately.
    this.marketplaceCache = undefined;
    return updates as SellerPriceUpdate[];
  }

  takeRemoval(previewId: string, rowId: unknown): SellerInventoryRemoval {
    this.removeExpiredPreviews();
    const preview = this.previews.get(previewId);
    if (preview === undefined) {
      throw new ConfigurationError([
        "The inventory preview expired or does not exist. Update the preview again.",
      ]);
    }
    if (typeof rowId !== "string") {
      throw new ConfigurationError(["The inventory row id is invalid."]);
    }
    const removal = preview.removals.get(rowId);
    if (removal === undefined) {
      throw new ConfigurationError([
        "This inventory row is not eligible for automatic removal.",
      ]);
    }
    return removal;
  }

  private removeExpiredPreviews(): void {
    const now = this.now().getTime();
    for (const [id, preview] of this.previews) {
      if (preview.expiresAt <= now) this.previews.delete(id);
    }
  }
}
