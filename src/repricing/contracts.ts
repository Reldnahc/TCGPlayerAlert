import type { GamePricingModuleConfig } from "../game-pricing.js";

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
export type UnsupportedSellerBandAction = "wait" | "fallback";
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
  /** Missing preserves the pre-policy behavior for programmatic consumers. */
  readonly unsupportedSellerBandAction?: UnsupportedSellerBandAction;
  /** Missing disables the independent automatic-decrease review guard. */
  readonly automaticDecreaseGuard?: boolean;
  readonly automaticDecreaseThresholdPercent?: number;
  readonly automaticDecreaseThresholdAmount?: number;
  /** Missing preserves the pre-fallback behavior for programmatic consumers. */
  readonly sparseMarketFallback?: SparseMarketFallback;
  /** Missing preserves profiles saved before game-specific modules. */
  readonly gamePricingModules?: readonly GamePricingModuleConfig[];
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
  /** Shipping used for pricing when it differs from TCGplayer's displayed amount. */
  readonly competitorPricingShipping?: number;
  readonly competitorCondition?: string;
  readonly marketPrice?: number;
  readonly marketPriceScope?: "product" | "exact-sku";
  readonly lowestPrice?: number;
  readonly lowestShipping?: number;
  readonly nextLowestPrice?: number;
  readonly nextLowestShipping?: number;
  readonly gapPercent?: number;
  readonly qualifyingListings?: number;
  readonly comparisonSampleIncomplete?: boolean;
  readonly comparisonSource?: "batched" | "exact";
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
  readonly effectiveMinimumPrice?: number;
  readonly minimumPriceSource?: string;
  readonly automaticDecreaseGuardApplied?: boolean;
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

export type RepricingProgressPhase =
  | "inventory"
  | "market-prices"
  | "comparisons"
  | "exact-comparisons"
  | "finalizing";

export interface RepricingProgress {
  readonly phase: RepricingProgressPhase;
  readonly completed: number;
  readonly total?: number;
  readonly unit: "products" | "batches" | "listings";
  readonly detail: string;
}
