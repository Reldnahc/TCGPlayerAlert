import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ApplicationError } from "./errors.js";
import {
  checkedLocalInventoryQuantity,
  parseLocalInventoryId,
  parseLocalInventoryItem,
  type LocalInventoryItem,
} from "./local-inventory-contracts.js";
import {
  parseInventoryItem,
  type CatalogIdentity,
  type OrderLine,
} from "./marketplaces/contracts.js";
import {
  catalogIdentityMatchTier,
  catalogIdentityMatchTierRank,
  catalogIdentityKey,
  exactVariantCatalogIdentityKeys,
} from "./marketplaces/catalog-identity.js";
import {
  MarketplaceValidationError,
  orderRefKey,
  parseOrderRefKey,
  parseProviderOrderRef,
  type ProviderOrderRef,
} from "./marketplaces/identity.js";

const MAXIMUM_LOCAL_ITEMS = 100_000;
const MAXIMUM_SALE_DEDUCTIONS = 1_000_000;

export { parseLocalInventoryItem } from "./local-inventory-contracts.js";
export type { LocalInventoryItem } from "./local-inventory-contracts.js";

export interface LocalInventorySnapshot {
  readonly items: readonly LocalInventoryItem[];
  readonly completedAt: string;
}

export interface LocalInventoryAddition {
  readonly displayName: string;
  readonly quantity: number;
  readonly catalogIdentities: readonly CatalogIdentity[];
  readonly attributes: Readonly<Record<string, string>>;
}

export interface LocalInventorySale {
  readonly ref: ProviderOrderRef;
  readonly lines: readonly (Pick<
    OrderLine,
    "quantity" | "catalogIdentities"
  > & { readonly attributes?: OrderLine["attributes"] })[];
}

export interface LocalInventorySaleDeduction {
  readonly appliedAt: string;
  readonly requestedQuantity: number;
  readonly deductedQuantity: number;
  readonly unmatchedQuantity: number;
  readonly shortageQuantity: number;
}

export type LocalInventorySaleDeductionResult =
  | { readonly outcome: "tracking-disabled" }
  | ({
      readonly outcome: "applied" | "already-applied";
    } & LocalInventorySaleDeduction);

export interface LocalInventoryState {
  readonly version: 2;
  readonly items: readonly LocalInventoryItem[];
  readonly salesTrackingStartedAt?: string;
  readonly saleDeductions: Readonly<
    Record<string, LocalInventorySaleDeduction>
  >;
}

export interface LocalInventoryStore {
  load(): Promise<LocalInventoryState>;
  save(state: LocalInventoryState): Promise<void>;
}

export function emptyLocalInventoryState(): LocalInventoryState {
  return { version: 2, items: [], saleDeductions: {} };
}

export function localInventoryStatePath(workflowStateFile: string): string {
  return resolve(dirname(resolve(workflowStateFile)), "local-inventory.json");
}

export class JsonLocalInventoryStore implements LocalInventoryStore {
  private readonly absolutePath: string;

  constructor(path: string) {
    this.absolutePath = resolve(path);
  }

  async load(): Promise<LocalInventoryState> {
    try {
      return parseLocalInventoryState(
        JSON.parse(await readFile(this.absolutePath, "utf8")) as unknown,
      );
    } catch (error) {
      if (hasCode(error, "ENOENT")) return emptyLocalInventoryState();
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        "PERSISTENCE_ERROR",
        "Unable to read local inventory.",
        { cause: error },
      );
    }
  }

  async save(state: LocalInventoryState): Promise<void> {
    const validated = parseLocalInventoryState(state);
    const directory = dirname(this.absolutePath);
    const temporaryPath = `${this.absolutePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(
        temporaryPath,
        `${JSON.stringify(validated, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      await rename(temporaryPath, this.absolutePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw new ApplicationError(
        "PERSISTENCE_ERROR",
        "Unable to persist local inventory atomically.",
        { cause: error },
      );
    }
  }
}

export class LocalInventoryService {
  private readonly now: () => Date;
  private readonly id: () => string;
  private mutations: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: LocalInventoryStore,
    options: {
      readonly now?: () => Date;
      readonly id?: () => string;
    } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  async snapshot(): Promise<LocalInventorySnapshot> {
    const state = await this.store.load();
    return {
      items: sortItems(state.items),
      completedAt: this.now().toISOString(),
    };
  }

  add(value: LocalInventoryAddition): Promise<LocalInventoryItem> {
    const addition = parseLocalInventoryAddition(value);
    return this.exclusive(async () => {
      const state = await this.store.load();
      const matches = matchingExactItems(state.items, addition);
      if (matches.length > 1) {
        throw new ApplicationError(
          "PERSISTENCE_ERROR",
          "Local inventory contains conflicting exact catalog identities.",
        );
      }
      const timestamp = this.now().toISOString();
      const existing = matches[0];
      const item =
        existing === undefined
          ? parseLocalInventoryItem({
              localInventoryId: this.id(),
              displayName: addition.displayName,
              onHand: addition.quantity,
              catalogIdentities: addition.catalogIdentities,
              attributes: addition.attributes,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
          : parseLocalInventoryItem({
              ...existing,
              displayName: addition.displayName,
              onHand: checkedLocalInventoryQuantity(
                existing.onHand + addition.quantity,
              ),
              catalogIdentities: mergeIdentities(
                existing.catalogIdentities,
                addition.catalogIdentities,
              ),
              attributes: { ...existing.attributes, ...addition.attributes },
              updatedAt: timestamp,
            });
      const items =
        existing === undefined
          ? [...state.items, item]
          : state.items.map((candidate) =>
              candidate.localInventoryId === existing.localInventoryId
                ? item
                : candidate,
            );
      await this.store.save({
        ...state,
        items,
        salesTrackingStartedAt: state.salesTrackingStartedAt ?? timestamp,
      });
      return item;
    });
  }

  initializeMissing(
    values: readonly LocalInventoryAddition[],
  ): Promise<readonly LocalInventoryItem[]> {
    const additions = values.map(parseLocalInventoryAddition);
    return this.exclusive(async () => {
      const state = await this.store.load();
      const timestamp = this.now().toISOString();
      const items = [...state.items];
      const created: LocalInventoryItem[] = [];
      for (const addition of additions) {
        const matches = matchingExactItems(items, addition);
        if (matches.length > 1) {
          throw new ApplicationError(
            "PERSISTENCE_ERROR",
            "Local inventory contains conflicting exact catalog identities.",
          );
        }
        if (matches.length === 1) continue;
        const item = parseLocalInventoryItem({
          localInventoryId: this.id(),
          displayName: addition.displayName,
          onHand: addition.quantity,
          catalogIdentities: addition.catalogIdentities,
          attributes: addition.attributes,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        items.push(item);
        created.push(item);
      }
      if (created.length > 0) {
        await this.store.save({
          ...state,
          items,
          salesTrackingStartedAt: state.salesTrackingStartedAt ?? timestamp,
        });
      }
      return sortItems(created);
    });
  }

  deductSale(
    value: LocalInventorySale,
  ): Promise<LocalInventorySaleDeductionResult> {
    const sale = parseLocalInventorySale(value);
    const saleKey = orderRefKey(sale.ref);
    return this.exclusive(async () => {
      const state = await this.store.load();
      if (state.salesTrackingStartedAt === undefined) {
        return { outcome: "tracking-disabled" };
      }
      const existing = state.saleDeductions[saleKey];
      if (existing !== undefined) {
        return { outcome: "already-applied", ...existing };
      }
      if (Object.keys(state.saleDeductions).length >= MAXIMUM_SALE_DEDUCTIONS) {
        throw new ApplicationError(
          "PERSISTENCE_ERROR",
          "The local sale-deduction ledger reached its supported limit.",
        );
      }
      const localByExactIdentity = exactIdentityOwners(state.items);
      const localById = new Map(
        state.items.map((item) => [item.localInventoryId, item]),
      );
      const requestedByItem = new Map<string, number>();
      let requestedQuantity = 0;
      let unmatchedQuantity = 0;
      for (const line of sale.lines) {
        requestedQuantity = checkedQuantitySum(
          requestedQuantity,
          line.quantity,
        );
        const candidateIds = new Set(
          exactVariantCatalogIdentityKeys(
            line.catalogIdentities,
            line.attributes ?? {},
          ).flatMap((key) => {
            return [...(localByExactIdentity.get(key) ?? [])];
          }),
        );
        const rankedMatches = [...candidateIds].flatMap((localId) => {
          const item = localById.get(localId);
          if (item === undefined) return [];
          const tier = catalogIdentityMatchTier(
            {
              catalogIdentities: line.catalogIdentities,
              attributes: line.attributes ?? {},
            },
            item,
          );
          return tier === undefined
            ? []
            : [{ localId, rank: catalogIdentityMatchTierRank(tier) }];
        });
        const bestRank = Math.min(...rankedMatches.map((match) => match.rank));
        const localIds = new Set(
          rankedMatches
            .filter((match) => match.rank === bestRank)
            .map((match) => match.localId),
        );
        if (localIds.size > 1) {
          throw new ApplicationError(
            "PERSISTENCE_ERROR",
            "One sold variant resolves to conflicting local inventory items.",
          );
        }
        const localId = [...localIds][0];
        if (localId === undefined) {
          unmatchedQuantity = checkedQuantitySum(
            unmatchedQuantity,
            line.quantity,
          );
          continue;
        }
        requestedByItem.set(
          localId,
          checkedQuantitySum(requestedByItem.get(localId) ?? 0, line.quantity),
        );
      }
      const appliedAt = this.now().toISOString();
      let deductedQuantity = 0;
      const items = state.items.map((item) => {
        const requested = requestedByItem.get(item.localInventoryId) ?? 0;
        if (requested === 0) return item;
        const deducted = Math.min(item.onHand, requested);
        deductedQuantity = checkedQuantitySum(deductedQuantity, deducted);
        return parseLocalInventoryItem({
          ...item,
          onHand: item.onHand - deducted,
          updatedAt: appliedAt,
        });
      });
      const matchedRequested = requestedQuantity - unmatchedQuantity;
      const deduction: LocalInventorySaleDeduction = {
        appliedAt,
        requestedQuantity,
        deductedQuantity,
        unmatchedQuantity,
        shortageQuantity: matchedRequested - deductedQuantity,
      };
      await this.store.save({
        ...state,
        items,
        saleDeductions: { ...state.saleDeductions, [saleKey]: deduction },
      });
      return { outcome: "applied", ...deduction };
    });
  }

  setQuantity(
    localInventoryId: string,
    quantity: number,
  ): Promise<LocalInventoryItem> {
    const parsedId = parseLocalInventoryId(localInventoryId);
    const parsedQuantity = checkedLocalInventoryQuantity(quantity);
    return this.exclusive(async () => {
      const state = await this.store.load();
      const existing = state.items.find(
        (item) => item.localInventoryId === parsedId,
      );
      if (existing === undefined) {
        throw new LocalInventoryNotFoundError();
      }
      const item = parseLocalInventoryItem({
        ...existing,
        onHand: parsedQuantity,
        updatedAt: this.now().toISOString(),
      });
      await this.store.save({
        ...state,
        items: state.items.map((candidate) =>
          candidate.localInventoryId === parsedId ? item : candidate,
        ),
      });
      return item;
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation, operation);
    this.mutations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class LocalInventoryNotFoundError extends Error {
  constructor() {
    super("The local inventory item was not found.");
    this.name = "LocalInventoryNotFoundError";
  }
}

export function parseLocalInventoryState(value: unknown): LocalInventoryState {
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== 2) ||
    !Array.isArray(value.items)
  ) {
    throw invalidState();
  }
  if (value.items.length > MAXIMUM_LOCAL_ITEMS) throw invalidState();
  const items = value.items.map(parseLocalInventoryItem);
  assertUniqueLocalInventory(items);
  if (value.version === 1) {
    return {
      version: 2,
      items,
      saleDeductions: {},
      ...(items.length === 0
        ? {}
        : {
            salesTrackingStartedAt: [...items]
              .map((item) => item.createdAt)
              .sort()[0],
          }),
    };
  }
  const salesTrackingStartedAt =
    value.salesTrackingStartedAt === undefined
      ? undefined
      : checkedTimestamp(value.salesTrackingStartedAt);
  if (!isRecord(value.saleDeductions)) throw invalidState();
  const deductionEntries = Object.entries(value.saleDeductions);
  if (deductionEntries.length > MAXIMUM_SALE_DEDUCTIONS) throw invalidState();
  const saleDeductions = Object.fromEntries(
    deductionEntries.map(([key, deduction]) => {
      parseOrderRefKey(key);
      return [key, parseSaleDeduction(deduction)];
    }),
  );
  if (
    Object.keys(saleDeductions).length > 0 &&
    salesTrackingStartedAt === undefined
  ) {
    throw invalidState();
  }
  return {
    version: 2,
    items,
    saleDeductions,
    ...(salesTrackingStartedAt === undefined ? {} : { salesTrackingStartedAt }),
  };
}

function assertUniqueLocalInventory(
  items: readonly LocalInventoryItem[],
): void {
  const ids = items.map((item) => item.localInventoryId);
  if (new Set(ids).size !== ids.length) throw invalidState();
  const exactIdentities = new Set<string>();
  for (const item of items) {
    for (const key of item.catalogIdentities
      .filter((identity) => identity.precision === "exact-variant")
      .map(catalogIdentityKey)) {
      if (exactIdentities.has(key)) throw invalidState();
      exactIdentities.add(key);
    }
  }
}

function parseSaleDeduction(value: unknown): LocalInventorySaleDeduction {
  if (!isRecord(value)) throw invalidState();
  const appliedAt = checkedTimestamp(value.appliedAt);
  const requestedQuantity = checkedLocalInventoryQuantity(
    value.requestedQuantity,
  );
  const deductedQuantity = checkedLocalInventoryQuantity(
    value.deductedQuantity,
  );
  const unmatchedQuantity = checkedLocalInventoryQuantity(
    value.unmatchedQuantity,
  );
  const shortageQuantity = checkedLocalInventoryQuantity(
    value.shortageQuantity,
  );
  if (
    unmatchedQuantity > requestedQuantity ||
    deductedQuantity + unmatchedQuantity + shortageQuantity !==
      requestedQuantity
  ) {
    throw invalidState();
  }
  return {
    appliedAt,
    requestedQuantity,
    deductedQuantity,
    unmatchedQuantity,
    shortageQuantity,
  };
}

function parseLocalInventoryAddition(
  value: LocalInventoryAddition,
): LocalInventoryAddition {
  const validated = parseInventoryItem({
    inventoryKey: "local-inventory-addition",
    displayName: value.displayName,
    quantity: checkedPositiveQuantity(value.quantity),
    catalogIdentities: value.catalogIdentities,
    attributes: value.attributes,
    quantityMutation: "absolute",
    priceMutable: false,
  });
  if (
    exactVariantCatalogIdentityKeys(
      validated.catalogIdentities,
      validated.attributes,
    ).length === 0
  ) {
    throw new MarketplaceValidationError(
      "A local catalog addition requires an exact-variant identity.",
    );
  }
  return {
    displayName: validated.displayName,
    quantity: validated.quantity,
    catalogIdentities: validated.catalogIdentities,
    attributes: validated.attributes,
  };
}

function parseLocalInventorySale(
  value: LocalInventorySale,
): LocalInventorySale {
  if (!isRecord(value) || !Array.isArray(value.lines)) {
    throw new MarketplaceValidationError(
      "The local inventory sale is invalid.",
    );
  }
  const ref = parseProviderOrderRef(value.ref);
  const lines = value.lines.map((line, index) => {
    if (!isRecord(line)) {
      throw new MarketplaceValidationError(
        "The local inventory sale line is invalid.",
      );
    }
    const validated = parseInventoryItem({
      inventoryKey: `sale-line-${String(index)}`,
      displayName: "Sold inventory",
      quantity: checkedPositiveQuantity(line.quantity),
      catalogIdentities: line.catalogIdentities,
      attributes: line.attributes ?? {},
      quantityMutation: "unavailable",
      priceMutable: false,
    });
    return {
      quantity: validated.quantity,
      catalogIdentities: validated.catalogIdentities,
      attributes: validated.attributes,
    };
  });
  return { ref, lines };
}

function matchingExactItems(
  items: readonly LocalInventoryItem[],
  addition: LocalInventoryAddition,
): readonly LocalInventoryItem[] {
  const matches = items.flatMap((item) => {
    const tier = catalogIdentityMatchTier(
      {
        catalogIdentities: addition.catalogIdentities,
        attributes: addition.attributes,
      },
      item,
    );
    return tier === undefined
      ? []
      : [{ item, rank: catalogIdentityMatchTierRank(tier) }];
  });
  const bestRank = Math.min(...matches.map((match) => match.rank));
  return matches
    .filter((match) => match.rank === bestRank)
    .map((match) => match.item);
}

function mergeIdentities(
  left: readonly CatalogIdentity[],
  right: readonly CatalogIdentity[],
): readonly CatalogIdentity[] {
  return [
    ...new Map(
      [...left, ...right].map((identity) => [identityKey(identity), identity]),
    ).values(),
  ];
}

function identityKey(identity: CatalogIdentity): string {
  return catalogIdentityKey(identity);
}

function exactIdentityOwners(
  items: readonly LocalInventoryItem[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const owners = new Map<string, Set<string>>();
  for (const item of items) {
    for (const key of exactVariantCatalogIdentityKeys(
      item.catalogIdentities,
      item.attributes,
    )) {
      const ids = owners.get(key) ?? new Set<string>();
      ids.add(item.localInventoryId);
      owners.set(key, ids);
    }
  }
  return owners;
}

function checkedQuantitySum(left: number, right: number): number {
  return checkedLocalInventoryQuantity(left + right);
}

function checkedPositiveQuantity(value: unknown): number {
  const quantity = checkedLocalInventoryQuantity(value);
  if (quantity === 0) {
    throw new MarketplaceValidationError(
      "A local inventory addition must be positive.",
    );
  }
  return quantity;
}

function sortItems(
  items: readonly LocalInventoryItem[],
): readonly LocalInventoryItem[] {
  return [...items].sort(
    (left, right) =>
      left.displayName.localeCompare(right.displayName) ||
      left.localInventoryId.localeCompare(right.localInventoryId),
  );
}

function checkedTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw invalidState();
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function invalidState(): ApplicationError {
  return new ApplicationError(
    "PERSISTENCE_ERROR",
    "The local inventory state is invalid.",
  );
}
