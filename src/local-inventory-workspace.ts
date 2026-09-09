import type { LocalInventoryItem } from "./local-inventory-contracts.js";
import type {
  InventoryItem,
  MarketplaceConnectionDescriptor,
  ProviderIssue,
} from "./marketplaces/contracts.js";
import type { InventoryListResult } from "./marketplaces/inventory.js";
import {
  catalogIdentityMatchTier,
  catalogIdentityMatchTierRank,
  catalogIdentityKey,
  catalogRecordsHaveConflictingProviderExactIdentities,
  exactVariantCatalogIdentityKeys,
} from "./marketplaces/catalog-identity.js";

export interface MarketplaceInventoryObservation {
  readonly descriptor: MarketplaceConnectionDescriptor;
  readonly item: InventoryItem;
  readonly localInventoryId?: string;
}

export interface LocalInventoryWorkspace {
  readonly items: readonly LocalInventoryItem[];
  readonly listings: readonly MarketplaceInventoryObservation[];
  readonly issues: readonly ProviderIssue[];
  readonly completedAt: string;
}

export interface LocalInventoryImportObservation {
  readonly connectionId: string;
  readonly connectionLabel: string;
  readonly inventoryKey: string;
  readonly quantity: number;
}

export interface LocalInventoryImportCandidate {
  readonly candidateKey: string;
  readonly displayName: string;
  readonly suggestedOnHand: number;
  readonly catalogIdentities: readonly InventoryItem["catalogIdentities"][number][];
  readonly attributes: Readonly<Record<string, string>>;
  readonly observations: readonly LocalInventoryImportObservation[];
  readonly crossListed: boolean;
}

export interface LocalInventoryImportPreview {
  readonly candidates: readonly LocalInventoryImportCandidate[];
  readonly alreadyLinkedCount: number;
  readonly skippedWithoutExactIdentityCount: number;
  readonly skippedZeroQuantityCount: number;
  readonly conflictingIdentityCount: number;
  readonly issues: readonly ProviderIssue[];
  readonly completedAt: string;
}

export function projectLocalInventoryWorkspace(
  items: readonly LocalInventoryItem[],
  marketplace: InventoryListResult | undefined,
  completedAt: string,
): LocalInventoryWorkspace {
  const localByExactIdentity = localIdentityIndex(items);
  const localById = new Map(items.map((item) => [item.localInventoryId, item]));
  const listings =
    marketplace?.connections.flatMap((connection) =>
      connection.items.map((item) => {
        const localIds = matchingLocalInventoryIds(
          item,
          localById,
          localByExactIdentity,
        );
        const localInventoryId =
          localIds.size === 1 ? [...localIds][0] : undefined;
        return {
          descriptor: connection.descriptor,
          item,
          ...(localInventoryId === undefined ? {} : { localInventoryId }),
        };
      }),
    ) ?? [];
  return {
    items,
    listings: listings.sort(
      (left, right) =>
        left.item.displayName.localeCompare(right.item.displayName) ||
        left.descriptor.connectionId.localeCompare(
          right.descriptor.connectionId,
        ) ||
        left.item.inventoryKey.localeCompare(right.item.inventoryKey),
    ),
    issues: marketplace?.issues ?? [],
    completedAt,
  };
}

export function planLocalInventoryImport(
  localItems: readonly LocalInventoryItem[],
  marketplace: InventoryListResult | undefined,
  completedAt: string,
): LocalInventoryImportPreview {
  const entries =
    marketplace?.connections.flatMap((connection) =>
      connection.items.map((item) => ({
        descriptor: connection.descriptor,
        item,
        exactKeys: exactVariantCatalogIdentityKeys(
          item.catalogIdentities,
          item.attributes,
        ),
      })),
    ) ?? [];
  const eligible = entries.filter(
    (entry) => entry.item.quantity > 0 && entry.exactKeys.length > 0,
  );
  const parents = eligible.map((_, index) => index);
  const owners = new Map<string, number>();
  for (const [index, entry] of eligible.entries()) {
    for (const key of entry.exactKeys) {
      const owner = owners.get(key);
      if (owner === undefined) owners.set(key, index);
      else unite(parents, index, owner);
    }
  }
  const groups = new Map<number, typeof eligible>();
  for (const [index, entry] of eligible.entries()) {
    const root = findRoot(parents, index);
    const group = groups.get(root) ?? [];
    group.push(entry);
    groups.set(root, group);
  }
  const localByExactIdentity = localIdentityIndex(localItems);
  const localById = new Map(
    localItems.map((item) => [item.localInventoryId, item]),
  );
  let alreadyLinkedCount = 0;
  let conflictingIdentityCount = 0;
  const candidates: LocalInventoryImportCandidate[] = [];
  for (const group of groups.values()) {
    if (
      catalogRecordsHaveConflictingProviderExactIdentities(
        group.map((entry) => entry.item),
      )
    ) {
      conflictingIdentityCount += 1;
      continue;
    }
    const localIds = new Set(
      group.flatMap((entry) => [
        ...matchingLocalInventoryIds(
          entry.item,
          localById,
          localByExactIdentity,
        ),
      ]),
    );
    if (localIds.size > 1) {
      conflictingIdentityCount += 1;
      continue;
    }
    if (localIds.size === 1) {
      alreadyLinkedCount += 1;
      continue;
    }
    candidates.push(importCandidate(group));
  }
  return {
    candidates: candidates.sort(
      (left, right) =>
        left.displayName.localeCompare(right.displayName) ||
        left.candidateKey.localeCompare(right.candidateKey),
    ),
    alreadyLinkedCount,
    skippedWithoutExactIdentityCount: entries.filter(
      (entry) => entry.item.quantity > 0 && entry.exactKeys.length === 0,
    ).length,
    skippedZeroQuantityCount: entries.filter(
      (entry) => entry.item.quantity === 0,
    ).length,
    conflictingIdentityCount,
    issues: marketplace?.issues ?? [],
    completedAt,
  };
}

function importCandidate(
  group: readonly {
    readonly descriptor: MarketplaceConnectionDescriptor;
    readonly item: InventoryItem;
    readonly exactKeys: readonly string[];
  }[],
): LocalInventoryImportCandidate {
  const ordered = [...group].sort(
    (left, right) =>
      Object.keys(right.item.attributes).length -
        Object.keys(left.item.attributes).length ||
      left.descriptor.connectionId.localeCompare(
        right.descriptor.connectionId,
      ) ||
      left.item.inventoryKey.localeCompare(right.item.inventoryKey),
  );
  const first = ordered[0];
  if (first === undefined) throw new Error("Inventory import group is empty.");
  const identities = [
    ...new Map(
      ordered
        .flatMap((entry) => entry.item.catalogIdentities)
        .map((identity) => [identityKey(identity), identity]),
    ).values(),
  ];
  const attributes: Record<string, string> = {};
  for (const entry of ordered) {
    for (const [key, value] of Object.entries(entry.item.attributes)) {
      attributes[key] ??= value;
    }
  }
  const observations = ordered
    .map((entry) => ({
      connectionId: entry.descriptor.connectionId,
      connectionLabel: entry.descriptor.connectionLabel,
      inventoryKey: entry.item.inventoryKey,
      quantity: entry.item.quantity,
    }))
    .sort(
      (left, right) =>
        left.connectionId.localeCompare(right.connectionId) ||
        left.inventoryKey.localeCompare(right.inventoryKey),
    );
  return {
    candidateKey:
      identities
        .filter((identity) => identity.precision === "exact-variant")
        .map(identityKey)
        .sort()[0] ?? first.item.inventoryKey,
    displayName: first.item.displayName,
    suggestedOnHand: Math.max(...observations.map((item) => item.quantity)),
    catalogIdentities: identities,
    attributes,
    observations,
    crossListed:
      new Set(observations.map((item) => item.connectionId)).size > 1,
  };
}

function findRoot(parents: number[], index: number): number {
  const parent = parents[index];
  if (parent === undefined)
    throw new Error("Inventory import index is invalid.");
  if (parent === index) return index;
  const root = findRoot(parents, parent);
  parents[index] = root;
  return root;
}

function unite(parents: number[], left: number, right: number): void {
  const leftRoot = findRoot(parents, left);
  const rightRoot = findRoot(parents, right);
  if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
}

function identityKey(identity: {
  readonly namespace: string;
  readonly value: string;
  readonly precision: "exact-variant" | "product";
}): string {
  return catalogIdentityKey(identity);
}

function localIdentityIndex(
  items: readonly LocalInventoryItem[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const index = new Map<string, Set<string>>();
  for (const item of items) {
    for (const key of exactVariantCatalogIdentityKeys(
      item.catalogIdentities,
      item.attributes,
    )) {
      const ids = index.get(key) ?? new Set<string>();
      ids.add(item.localInventoryId);
      index.set(key, ids);
    }
  }
  return index;
}

function matchingLocalInventoryIds(
  subject: Pick<InventoryItem, "catalogIdentities" | "attributes">,
  localById: ReadonlyMap<string, LocalInventoryItem>,
  identityIndex: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlySet<string> {
  const candidateIds = new Set(
    exactVariantCatalogIdentityKeys(
      subject.catalogIdentities,
      subject.attributes,
    ).flatMap((key) => [...(identityIndex.get(key) ?? [])]),
  );
  const matches = [...candidateIds].flatMap((localInventoryId) => {
    const local = localById.get(localInventoryId);
    if (local === undefined) return [];
    const tier = catalogIdentityMatchTier(subject, local);
    return tier === undefined
      ? []
      : [{ localInventoryId, rank: catalogIdentityMatchTierRank(tier) }];
  });
  const bestRank = Math.min(...matches.map((match) => match.rank));
  return new Set(
    matches
      .filter((match) => match.rank === bestRank)
      .map((match) => match.localInventoryId),
  );
}
