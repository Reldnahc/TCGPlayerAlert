import { randomUUID } from "node:crypto";
import type {
  MarketplaceListing,
  MarketplaceProduct,
} from "tcgplayer-private-api";
import { ConfigurationError } from "../errors.js";
import { effectiveMinimumPrice } from "../game-pricing.js";
import {
  TCGPLAYER_CONDITION_ORDER,
  type RepricingConditionPolicy,
  type RepricingPreviewRow,
  type RepricingPriceBasis,
  type RepricingPriceSource,
  type RepricingRange,
  type RepricingRules,
  type SparseMarketFallback,
} from "./contracts.js";

export interface SellerListingContext {
  readonly product: MarketplaceProduct;
  readonly listing: MarketplaceListing;
}

export interface RepricingComparisonEvidence {
  readonly reportedQualifyingListings?: number;
  readonly incomplete?: boolean;
}
export function allowedConditions(
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

export function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

const TCGPLAYER_LOW_VALUE_MARKETPLACE_THRESHOLD = 5;
export const TCGPLAYER_NORMALIZED_MARKETPLACE_SHIPPING = 1.49;

function listingShippingForPricing(
  listing: MarketplaceListing,
  basis: RepricingPriceBasis,
): number {
  if (basis === "item") return 0;
  return listing.channelId === 0 &&
    listing.price < TCGPLAYER_LOW_VALUE_MARKETPLACE_THRESHOLD
    ? Math.max(listing.shippingPrice, TCGPLAYER_NORMALIZED_MARKETPLACE_SHIPPING)
    : listing.shippingPrice;
}

function listingBasis(
  listing: MarketplaceListing,
  basis: RepricingPriceBasis,
): number {
  return listing.price + listingShippingForPricing(listing, basis);
}

function ownShippingForPricing(
  ownListing: MarketplaceListing,
  referenceListing: MarketplaceListing,
  basis: RepricingPriceBasis,
): number {
  if (basis === "item") return 0;
  return ownListing.channelId === 0 &&
    referenceListing.channelId === 0 &&
    referenceListing.price < TCGPLAYER_LOW_VALUE_MARKETPLACE_THRESHOLD
    ? Math.max(
        ownListing.shippingPrice,
        TCGPLAYER_NORMALIZED_MARKETPLACE_SHIPPING,
      )
    : ownListing.shippingPrice;
}

export function isVerifiedDirectListing(listing: MarketplaceListing): boolean {
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
        (listing.listingType === undefined ||
          listing.listingType === "standard") &&
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
  const lowestEquivalentItemPrice =
    lowest === undefined || lowestBasis === undefined
      ? undefined
      : lowestBasis -
        ownShippingForPricing(own.listing, lowest, rules.priceBasis);
  const fallbackReference =
    sparseMarketFallbackRequired && sparseMarketFallback !== "skip"
      ? sparseMarketReference(
          sparseMarketFallback,
          lowest,
          lowestEquivalentItemPrice,
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
  const competitorPricingShipping =
    referenceListing !== undefined &&
    rules.priceBasis === "delivered" &&
    referenceListing.channelId === 0 &&
    referenceListing.price < TCGPLAYER_LOW_VALUE_MARKETPLACE_THRESHOLD &&
    referenceListing.shippingPrice < TCGPLAYER_NORMALIZED_MARKETPLACE_SHIPPING
      ? TCGPLAYER_NORMALIZED_MARKETPLACE_SHIPPING
      : undefined;
  const rawTarget =
    (sourcePrice * range.percentage) / 100 -
    (referenceListing !== undefined && rules.priceBasis === "delivered"
      ? ownShippingForPricing(own.listing, referenceListing, rules.priceBasis)
      : 0) -
    rules.adjustmentCents / 100;
  const minimum = effectiveMinimumPrice(
    rules.minimumPrice,
    own.product,
    rules.gamePricingModules ?? [],
  );
  const minimumApplied = rawTarget < minimum.minimumPrice;
  const target = roundCurrency(Math.max(minimum.minimumPrice, rawTarget));
  const comparison = {
    ...rangeDetails,
    ...(referenceListing === undefined
      ? {}
      : {
          competitorPrice: referenceListing.price,
          competitorShipping: referenceListing.shippingPrice,
          ...(competitorPricingShipping === undefined
            ? {}
            : { competitorPricingShipping }),
          competitorCondition: referenceListing.condition,
        }),
    ...(useNext ? { gapActionApplied: "use-next" as const } : {}),
    ...(appliedSparseMarketFallback === undefined
      ? {}
      : { sparseMarketFallbackApplied: appliedSparseMarketFallback }),
    pricingSource,
    minimumApplied,
    ...(minimumApplied
      ? {
          effectiveMinimumPrice: minimum.minimumPrice,
          ...(minimum.source === undefined
            ? {}
            : { minimumPriceSource: minimum.source.label }),
        }
      : {}),
  };
  const strategy = sparseMarketFallbackApplied
    ? `Seller support was insufficient, so this profile uses its ${sparseMarketFallback.replaceAll("-", " ")} fallback and prices from the ${fallbackReference.source === "market" ? "market price" : "lowest qualifying listing"}.`
    : useNext
      ? supportMode === "cluster"
        ? `The lowest seller is ${gapPercent.toFixed(1)}% below a price band supported by ${String(supportedCluster?.sellerCount ?? 0)} sellers, so this range uses ${String(range.percentage)}% of that band.`
        : `The lowest listing is ${gapPercent.toFixed(1)}% below the next listing, so this range uses ${String(range.percentage)}% of the next listing.`
      : range.priceSource === "market"
        ? `Uses ${String(range.percentage)}% of market price.`
        : `Uses ${String(range.percentage)}% of the lowest qualifying listing.`;
  const strategyReason =
    competitorPricingShipping !== undefined && referenceListing !== undefined
      ? `${strategy} Sub-$5 marketplace shipping is normalized to $${competitorPricingShipping.toFixed(2)} for pricing.`
      : strategy;
  if (target === own.listing.price) {
    return {
      ...base,
      ...comparison,
      proposedPrice: target,
      status: "unchanged",
      reason: minimumApplied
        ? minimum.source === undefined
          ? "Already at the configured minimum."
          : `Already at the ${minimum.source.label} minimum of $${minimum.minimumPrice.toFixed(2)}.`
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
      ? minimum.source === undefined
        ? "The minimum price overrides the calculated target."
        : `The ${minimum.source.label} minimum of $${minimum.minimumPrice.toFixed(2)} overrides the calculated target.`
      : strategyReason,
    queueable: true,
  };
}

export function skippedRow(
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
