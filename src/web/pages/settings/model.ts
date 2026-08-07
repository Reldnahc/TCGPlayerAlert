import type { Settings } from "../../contracts.js";

export type PricingProfile = Settings["repricingProfiles"][number];
export type PricingRange = PricingProfile["ranges"][number];
export type MerchandiseProfile = Settings["merchandiseProfiles"][number];
export type Output = Settings["outputs"][number];

export const conditions = [
  "Near Mint",
  "Lightly Played",
  "Moderately Played",
  "Heavily Played",
  "Damaged",
  "Unopened",
] as const;

export function uniqueId(prefix: string, existing: readonly string[]): string {
  let suffix = Date.now().toString(36);
  let id = `${prefix}-${suffix}`;
  while (existing.includes(id)) {
    suffix += "x";
    id = `${prefix}-${suffix}`;
  }
  return id;
}

export function addPricingRange(profile: PricingProfile): PricingProfile {
  if (profile.ranges.length >= 20) return profile;
  const ranges = [...profile.ranges];
  const openRange = ranges.pop();
  if (openRange === undefined) return profile;
  const previousMaximum = ranges.at(-1)?.maximumPrice ?? 0;
  if (previousMaximum >= 1_000_000) return profile;
  const suggestedMaximum =
    previousMaximum < 5
      ? 5
      : Math.min(1_000_000, Math.round(previousMaximum * 2 * 100) / 100);
  const openRangeWithoutMaximum = withoutMaximum(openRange);
  return {
    ...profile,
    ranges: [
      ...ranges,
      { ...openRangeWithoutMaximum, maximumPrice: suggestedMaximum },
      openRangeWithoutMaximum,
    ],
  };
}

export function removePricingRange(
  profile: PricingProfile,
  index: number,
): PricingProfile {
  if (profile.ranges.length === 1) return profile;
  const ranges = profile.ranges.filter(
    (_range, candidate) => candidate !== index,
  );
  const last = ranges.at(-1);
  if (last === undefined) return profile;
  const lastWithoutMaximum = withoutMaximum(last);
  return { ...profile, ranges: [...ranges.slice(0, -1), lastWithoutMaximum] };
}

function withoutMaximum(
  range: PricingRange,
): Omit<PricingRange, "maximumPrice"> {
  return {
    minimumListings: range.minimumListings,
    priceSource: range.priceSource,
    percentage: range.percentage,
    gapThresholdPercent: range.gapThresholdPercent,
    gapAction: range.gapAction,
    ...(range.supportMode === undefined
      ? {}
      : { supportMode: range.supportMode }),
    ...(range.minimumSellerSupport === undefined
      ? {}
      : { minimumSellerSupport: range.minimumSellerSupport }),
    ...(range.supportWindowPercent === undefined
      ? {}
      : { supportWindowPercent: range.supportWindowPercent }),
  };
}
