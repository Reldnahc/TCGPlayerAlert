import {
  parseConnectionId,
  parseProviderOrderRef,
  type ProviderOrderRef,
  MarketplaceValidationError,
} from "./marketplaces/identity.js";
import { parseLocalInventoryId } from "./local-inventory-contracts.js";

export type ReplenishmentStatus =
  | "watching"
  | "waiting-shipment"
  | "running"
  | "review-required"
  | "paused"
  | "out-of-stock";
export interface ReplenishmentTicket {
  readonly ref: ProviderOrderRef;
  readonly quantity: number;
}
export interface ReplenishmentJob {
  readonly id: string;
  readonly at: string;
  readonly quantity: number;
  readonly status: "running" | "submitted" | "skipped" | "review-required";
  readonly message: string;
}
export interface ReplenishmentRule {
  readonly displayName: string;
  readonly accountScope: string;
  readonly localInventoryId: string;
  readonly connectionId: string;
  readonly targetQuantity: number;
  readonly price: number;
  readonly pricingProfileId?: string;
  readonly enabled: boolean;
  readonly status: ReplenishmentStatus;
  readonly tickets: readonly ReplenishmentTicket[];
  readonly jobs: readonly ReplenishmentJob[];
  readonly checkedAt?: string;
  readonly message: string;
}
export interface ReplenishmentSetupPreview {
  readonly id: string;
  readonly quantity: number;
  readonly targetQuantity: number;
  readonly addQuantity: number;
  readonly price: number;
}
export interface ReplenishmentSnapshot {
  readonly pricingProfiles?: readonly {
    readonly id: string;
    readonly name: string;
  }[];
  readonly preview?: ReplenishmentSetupPreview;
  readonly connectionId?: string;
  readonly workerRunning: boolean;
  readonly rules: readonly ReplenishmentRule[];
}
function invalid(): never {
  throw new MarketplaceValidationError(
    "The replenishment settings or state are invalid.",
  );
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}
export function replenishmentQuantity(value: unknown, maximum = 100): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 1 ||
    Number(value) > maximum
  )
    return invalid();
  return Number(value);
}
export function replenishmentPrice(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0.01 ||
    value > 1_000_000 ||
    Math.abs(value * 100 - Math.round(value * 100)) > 1e-9
  )
    return invalid();
  return value;
}
function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return invalid();
  return value;
}
function message(value: unknown): string {
  if (typeof value !== "string" || value.length > 500) return invalid();
  return value;
}
export function parseReplenishmentRule(value: unknown): ReplenishmentRule {
  const v = record(value);
  if (
    typeof v.enabled !== "boolean" ||
    ![
      "watching",
      "waiting-shipment",
      "running",
      "review-required",
      "paused",
      "out-of-stock",
    ].includes(String(v.status)) ||
    !Array.isArray(v.tickets) ||
    v.tickets.length > 10000 ||
    !Array.isArray(v.jobs) ||
    v.jobs.length > 100
  )
    return invalid();
  const connectionId = parseConnectionId(v.connectionId);
  return {
    displayName:
      typeof v.displayName === "string" &&
      v.displayName.length > 0 &&
      v.displayName.length <= 1024
        ? v.displayName
        : invalid(),
    accountScope:
      typeof v.accountScope === "string" &&
      v.accountScope.length > 0 &&
      v.accountScope.length <= 128
        ? v.accountScope
        : invalid(),
    localInventoryId: parseLocalInventoryId(v.localInventoryId),
    connectionId,
    targetQuantity: replenishmentQuantity(v.targetQuantity),
    price: replenishmentPrice(v.price),
    ...(v.pricingProfileId === undefined
      ? {}
      : { pricingProfileId: replenishmentProfileId(v.pricingProfileId) }),
    enabled: v.enabled,
    status: v.status as ReplenishmentStatus,
    message: message(v.message),
    ...(v.checkedAt === undefined ? {} : { checkedAt: timestamp(v.checkedAt) }),
    tickets: v.tickets.map((entry) => {
      const t = record(entry);
      const ref = parseProviderOrderRef(t.ref);
      if (ref.connectionId !== connectionId) return invalid();
      return { ref, quantity: replenishmentQuantity(t.quantity, 1000000) };
    }),
    jobs: v.jobs.map((entry) => {
      const j = record(entry);
      if (
        !["running", "submitted", "skipped", "review-required"].includes(
          String(j.status),
        )
      )
        return invalid();
      return {
        id: parseLocalInventoryId(j.id),
        at: timestamp(j.at),
        quantity:
          Number.isSafeInteger(j.quantity) &&
          Number(j.quantity) >= 0 &&
          Number(j.quantity) <= 100
            ? Number(j.quantity)
            : invalid(),
        status: j.status as ReplenishmentJob["status"],
        message: message(j.message),
      };
    }),
  };
}

export function replenishmentProfileId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(value))
    return invalid();
  return value;
}
