import {
  parseInventoryItem,
  type CatalogIdentity,
} from "./marketplaces/contracts.js";
import { MarketplaceValidationError } from "./marketplaces/identity.js";

const MAXIMUM_ON_HAND = 1_000_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface LocalInventoryItem {
  readonly localInventoryId: string;
  readonly displayName: string;
  readonly onHand: number;
  readonly catalogIdentities: readonly CatalogIdentity[];
  readonly attributes: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function parseLocalInventoryItem(value: unknown): LocalInventoryItem {
  if (!isRecord(value)) {
    throw new MarketplaceValidationError(
      "The local inventory item is invalid.",
    );
  }
  const localInventoryId = parseLocalInventoryId(value.localInventoryId);
  const validated = parseInventoryItem({
    inventoryKey: localInventoryId,
    displayName: value.displayName,
    quantity: checkedLocalInventoryQuantity(value.onHand),
    catalogIdentities: value.catalogIdentities,
    attributes: value.attributes,
    quantityMutation: "absolute",
    priceMutable: false,
  });
  const createdAt = localInventoryTimestamp(value.createdAt);
  const updatedAt = localInventoryTimestamp(value.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new MarketplaceValidationError(
      "The local inventory timestamps are invalid.",
    );
  }
  return {
    localInventoryId,
    displayName: validated.displayName,
    onHand: validated.quantity,
    catalogIdentities: validated.catalogIdentities,
    attributes: validated.attributes,
    createdAt,
    updatedAt,
  };
}

export function checkedLocalInventoryQuantity(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    Number(value) > MAXIMUM_ON_HAND
  ) {
    throw new MarketplaceValidationError(
      `Local on-hand quantity must be an integer from 0 through ${String(MAXIMUM_ON_HAND)}.`,
    );
  }
  return Number(value);
}

export function parseLocalInventoryId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new MarketplaceValidationError(
      "The local inventory item ID is invalid.",
    );
  }
  return value.toLocaleLowerCase();
}

function localInventoryTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new MarketplaceValidationError(
      "The local inventory timestamp is invalid.",
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
