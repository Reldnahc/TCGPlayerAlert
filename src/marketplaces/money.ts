import type { Money } from "./contracts.js";
import { parseMoney } from "./contracts.js";
import { MarketplaceValidationError } from "./identity.js";

export function majorUnitsToMoney(value: number, currency: string): Money {
  if (!Number.isFinite(value)) {
    throw new MarketplaceValidationError("Money must be a finite number.");
  }
  const minorUnits = Math.round(value * 100);
  if (Math.abs(value * 100 - minorUnits) > 1e-6) {
    throw new MarketplaceValidationError(
      "Money cannot contain more than two decimal places.",
    );
  }
  return parseMoney({ currency, minorUnits });
}

export function moneyToMajorUnits(value: Money): number {
  return parseMoney(value).minorUnits / 100;
}
