import { ConfigurationError } from "../errors.js";
import { parseGamePricingModules } from "../game-pricing.js";
import type {
  RepricingConditionPolicy,
  RepricingGapAction,
  RepricingPriceBasis,
  RepricingPriceSource,
  RepricingRange,
  RepricingRules,
  RepricingSupportMode,
  SparseMarketFallback,
  UnsupportedSellerBandAction,
} from "./contracts.js";

export function objectValue(
  value: unknown,
): Record<string, unknown> | undefined {
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
  const unsupportedSellerBandAction =
    source?.unsupportedSellerBandAction ?? "fallback";
  if (
    unsupportedSellerBandAction !== "wait" &&
    unsupportedSellerBandAction !== "fallback"
  ) {
    issues.push("Unsupported-seller-band action is invalid.");
  }
  const automaticDecreaseGuard = source?.automaticDecreaseGuard ?? false;
  if (typeof automaticDecreaseGuard !== "boolean") {
    issues.push("Automatic-decrease guard must be true or false.");
  }
  const automaticDecreaseThresholdPercent =
    source?.automaticDecreaseThresholdPercent ?? 25;
  if (
    typeof automaticDecreaseThresholdPercent !== "number" ||
    !Number.isFinite(automaticDecreaseThresholdPercent) ||
    automaticDecreaseThresholdPercent < 0.1 ||
    automaticDecreaseThresholdPercent > 100
  ) {
    issues.push("Automatic-decrease percentage must be between 0.1 and 100.");
  }
  const automaticDecreaseThresholdAmount =
    source?.automaticDecreaseThresholdAmount ?? 0.5;
  if (
    typeof automaticDecreaseThresholdAmount !== "number" ||
    !Number.isFinite(automaticDecreaseThresholdAmount) ||
    automaticDecreaseThresholdAmount < 0.01 ||
    automaticDecreaseThresholdAmount > 1_000_000 ||
    !hasAtMostTwoDecimals(automaticDecreaseThresholdAmount)
  ) {
    issues.push(
      "Automatic-decrease amount must be $0.01-$1,000,000 with at most two decimals.",
    );
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
  const gamePricingModules = parseGamePricingModules(
    source?.gamePricingModules,
    "gamePricingModules",
    issues,
  );
  if (issues.length > 0) throw new ConfigurationError(issues);
  return {
    minimumPrice: Number(minimumPrice),
    conditionPolicy: conditionPolicy as RepricingConditionPolicy,
    priceBasis: priceBasis as RepricingPriceBasis,
    adjustmentCents: Number(adjustmentCents),
    allowPriceIncreases: source?.allowPriceIncreases as boolean,
    unsupportedSellerBandAction:
      unsupportedSellerBandAction as UnsupportedSellerBandAction,
    automaticDecreaseGuard: automaticDecreaseGuard as boolean,
    automaticDecreaseThresholdPercent: Number(
      automaticDecreaseThresholdPercent,
    ),
    automaticDecreaseThresholdAmount: Number(automaticDecreaseThresholdAmount),
    sparseMarketFallback: sparseMarketFallback as SparseMarketFallback,
    gamePricingModules,
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
