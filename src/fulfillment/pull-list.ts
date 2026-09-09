import { ApplicationError } from "../errors.js";
import {
  parseOrderDetail,
  parsePullLine,
  type CatalogIdentity,
  type ProviderIssue,
  type PullLine,
} from "../marketplaces/contracts.js";
import {
  orderRefKey,
  parseProviderOrderRef,
  type ProviderOrderRef,
} from "../marketplaces/identity.js";
import type { OrderQueryService } from "../marketplaces/order-query.js";
import type { MarketplaceConnectionRegistry } from "../marketplaces/registry.js";
import {
  catalogRecordsHaveConflictingProviderExactIdentities,
  canonicalVariantAttribute,
  exactVariantCatalogIdentities,
} from "../marketplaces/catalog-identity.js";
import {
  pullListBin,
  pullListColorGroup,
  pullListSettingsKey,
  type PullListGroupingSettings,
} from "../pull-list-binning.js";
import type {
  PullProgressAllocation,
  QualifiedPullListProgressState,
  QualifiedPullListProgressStore,
} from "./pull-list-progress.js";

const DEFAULT_CACHE_MILLISECONDS = 30_000;
const DETAIL_CONCURRENCY = 4;

export interface MasterPullListMetadata {
  readonly label: string;
  readonly values: readonly string[];
}

export interface MasterPullListRow {
  readonly rowKey: string;
  /** Temporary browser compatibility alias removed in Package 9. */
  readonly skuId: string;
  readonly productLine: string;
  readonly productName: string;
  readonly condition: string;
  readonly number: string;
  readonly setName: string;
  readonly rarity: string;
  readonly quantity: number;
  readonly mainPhotoUrl: string;
  readonly setReleaseDate: string;
  readonly orderQuantity: number;
  readonly productId?: number;
  readonly attributes: Readonly<Record<string, readonly string[]>>;
  readonly metadata: readonly MasterPullListMetadata[];
  readonly bin: string;
  readonly pulledQuantity: number;
  readonly remainingQuantity: number;
  readonly pulled: boolean;
  readonly canTrackPullProgress: boolean;
}

export interface MasterPullList {
  readonly orderCount: number;
  readonly rows: readonly MasterPullListRow[];
  readonly totalQuantity: number;
  readonly pulledQuantity: number;
  readonly remainingQuantity: number;
  readonly fetchedAt: string;
  readonly issues: readonly ProviderIssue[];
  readonly metadataIssue?: string;
}

interface PullAtom {
  readonly description: string;
  readonly quantity: number;
  readonly attributes: Readonly<Record<string, readonly string[]>>;
  readonly catalogIdentities: readonly CatalogIdentity[];
  readonly allocation: {
    readonly order: ProviderOrderRef;
    readonly lineKey: string;
    readonly quantity: number;
  };
}

interface CachedPullList {
  readonly expiresAt: number;
  readonly groupingKey: string;
  readonly atoms: readonly PullAtom[];
  readonly orderCount: number;
  readonly issues: readonly ProviderIssue[];
  readonly value: MasterPullList;
  readonly allocationsByRow: ReadonlyMap<string, readonly PullAtom[]>;
}

interface BuiltPullList {
  readonly value: MasterPullList;
  readonly allocationsByRow: ReadonlyMap<string, readonly PullAtom[]>;
  readonly progress: QualifiedPullListProgressState;
}

export class AggregatePullListError extends Error {
  readonly code = "ALL_PULL_CONNECTIONS_FAILED" as const;

  constructor(readonly issues: readonly ProviderIssue[]) {
    super(
      "Every marketplace connection with ready orders failed to provide pull lines.",
    );
    this.name = "AggregatePullListError";
  }
}

export class MasterPullListService {
  private readonly now: () => Date;
  private readonly cacheMilliseconds: number;
  private cache: CachedPullList | undefined;
  private progressOperation: Promise<void> = Promise.resolve();
  private readonly excludedOrders = new Set<string>();

  constructor(
    private readonly options: {
      readonly registry: MarketplaceConnectionRegistry;
      readonly orders: OrderQueryService;
      readonly progress: QualifiedPullListProgressStore;
      readonly grouping: () => Promise<PullListGroupingSettings>;
      readonly now?: () => Date;
      readonly cacheMilliseconds?: number;
    },
  ) {
    this.now = options.now ?? (() => new Date());
    this.cacheMilliseconds =
      options.cacheMilliseconds ?? DEFAULT_CACHE_MILLISECONDS;
    if (
      !Number.isSafeInteger(this.cacheMilliseconds) ||
      this.cacheMilliseconds < 1
    ) {
      throw new ApplicationError(
        "CONFIGURATION_ERROR",
        "The pull-list cache duration is invalid.",
      );
    }
  }

  async getMasterPullList(
    options: { readonly force?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<MasterPullList> {
    const now = this.now();
    const grouping = await this.options.grouping();
    const groupingKey = pullListSettingsKey(grouping);
    const cached = this.cache;
    if (
      options.force !== true &&
      cached !== undefined &&
      cached.expiresAt > now.getTime() &&
      cached.groupingKey === groupingKey
    ) {
      return cached.value;
    }
    if (
      options.force !== true &&
      cached !== undefined &&
      cached.expiresAt > now.getTime()
    ) {
      return this.rebuildCache(cached, grouping, groupingKey, now);
    }

    const ready = await this.options.orders.listOrders("ready-to-ship", {
      ...(options.force === undefined ? {} : { force: options.force }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const currentOrderKeys = new Set(
      ready.data.map((order) => orderRefKey(order.ref)),
    );
    for (const key of this.excludedOrders) {
      if (!currentOrderKeys.has(key)) this.excludedOrders.delete(key);
    }
    const refs = ready.data
      .map((order) => order.ref)
      .filter((ref) => !this.excludedOrders.has(orderRefKey(ref)));
    const groupedRefs = groupRefsByConnection(refs);
    const loaded = await Promise.all(
      [...groupedRefs].map(([connectionId, connectionRefs]) =>
        this.loadConnection(connectionId, connectionRefs, options.signal),
      ),
    );
    if (groupedRefs.size > 0 && loaded.every((result) => !result.succeeded)) {
      throw new AggregatePullListError(
        deduplicateIssues([
          ...ready.issues,
          ...loaded.flatMap((result) => result.issues),
        ]),
      );
    }
    const loadedAtoms = loaded.flatMap((result) => result.atoms);
    const enrichment = await this.enrichAcrossConnections(
      loadedAtoms,
      options.signal,
    );
    const atoms = enrichment.atoms;
    const issues = deduplicateIssues([
      ...ready.issues,
      ...loaded.flatMap((result) => result.issues),
      ...enrichment.issues,
    ]);
    const successfulOrderKeys = new Set(
      atoms.map((atom) => orderRefKey(atom.allocation.order)),
    );
    const built = await this.withProgressOperation(() =>
      this.build(
        atoms,
        successfulOrderKeys.size,
        issues,
        grouping,
        now.toISOString(),
      ),
    );
    this.cache = {
      expiresAt: now.getTime() + this.cacheMilliseconds,
      groupingKey,
      atoms,
      orderCount: successfulOrderKeys.size,
      issues,
      value: built.value,
      allocationsByRow: built.allocationsByRow,
    };
    return built.value;
  }

  async setRowPulled(
    rowKey: string,
    pulled: boolean,
    signal?: AbortSignal,
  ): Promise<MasterPullListRow> {
    const normalizedRowKey = safeRowKey(rowKey);
    if (typeof pulled !== "boolean") {
      throw new ApplicationError(
        "CONFIGURATION_ERROR",
        "Pulled must be true or false.",
      );
    }
    await this.getMasterPullList(signal === undefined ? {} : { signal });
    return this.withProgressOperation(async () => {
      signal?.throwIfAborted();
      const cached = this.cache;
      const atoms = cached?.allocationsByRow.get(normalizedRowKey);
      if (cached === undefined || atoms === undefined) {
        throw new ApplicationError(
          "CONFIGURATION_ERROR",
          "The selected item is not in the current master pull list.",
        );
      }
      const current = await this.options.progress.load();
      const next = setAllocationProgress(
        current,
        atoms,
        pulled,
        this.now().toISOString(),
      );
      await this.options.progress.save(next);
      const built = buildProjectedList(
        cached.atoms,
        cached.orderCount,
        cached.issues,
        await this.options.grouping(),
        cached.value.fetchedAt,
        next,
      );
      this.cache = {
        ...cached,
        value: built.value,
        allocationsByRow: built.allocationsByRow,
      };
      const updated = built.value.rows.find(
        (row) => row.rowKey === normalizedRowKey,
      );
      if (updated === undefined) {
        throw new ApplicationError(
          "PERSISTENCE_ERROR",
          "The updated pull-list row disappeared.",
        );
      }
      return updated;
    });
  }

  async removeOrder(ref: ProviderOrderRef): Promise<void> {
    const parsed = parseProviderOrderRef(ref);
    const orderKey = orderRefKey(parsed);
    this.excludedOrders.add(orderKey);
    const cached = this.cache;
    if (cached === undefined) return;
    const atoms = cached.atoms.filter(
      (atom) => orderRefKey(atom.allocation.order) !== orderKey,
    );
    if (atoms.length === cached.atoms.length) return;
    await this.withProgressOperation(async () => {
      const grouping = await this.options.grouping();
      const orderCount = new Set(
        atoms.map((atom) => orderRefKey(atom.allocation.order)),
      ).size;
      const built = await this.build(
        atoms,
        orderCount,
        cached.issues,
        grouping,
        this.now().toISOString(),
      );
      this.cache = {
        ...cached,
        atoms,
        orderCount,
        groupingKey: pullListSettingsKey(grouping),
        value: built.value,
        allocationsByRow: built.allocationsByRow,
      };
    });
  }

  invalidate(): void {
    this.cache = undefined;
  }

  private async rebuildCache(
    cached: CachedPullList,
    grouping: PullListGroupingSettings,
    groupingKey: string,
    now: Date,
  ): Promise<MasterPullList> {
    const built = await this.withProgressOperation(() =>
      this.build(
        cached.atoms,
        cached.orderCount,
        cached.issues,
        grouping,
        now.toISOString(),
      ),
    );
    this.cache = {
      ...cached,
      groupingKey,
      value: built.value,
      allocationsByRow: built.allocationsByRow,
    };
    return built.value;
  }

  private async build(
    atoms: readonly PullAtom[],
    orderCount: number,
    issues: readonly ProviderIssue[],
    grouping: PullListGroupingSettings,
    fetchedAt: string,
  ): Promise<BuiltPullList> {
    const current = await this.options.progress.load();
    const active = new Map(
      atoms.map((atom) => [allocationKey(atom.allocation), atom] as const),
    );
    const reconciled: QualifiedPullListProgressState = {
      version: 2,
      allocations: current.allocations
        .flatMap((stored) => {
          const atom = active.get(progressKey(stored));
          if (atom === undefined) return [];
          return [
            {
              ...stored,
              quantity: Math.min(stored.quantity, atom.quantity),
            },
          ];
        })
        .sort(compareProgress),
    };
    if (JSON.stringify(reconciled) !== JSON.stringify(current)) {
      await this.options.progress.save(reconciled);
    }
    return buildProjectedList(
      atoms,
      orderCount,
      issues,
      grouping,
      fetchedAt,
      reconciled,
    );
  }

  private async loadConnection(
    connectionId: string,
    refs: readonly ProviderOrderRef[],
    signal?: AbortSignal,
  ): Promise<{
    readonly succeeded: boolean;
    readonly atoms: readonly PullAtom[];
    readonly issues: readonly ProviderIssue[];
  }> {
    const connection = this.options.registry.get(connectionId);
    if (connection === undefined) {
      return {
        succeeded: false,
        atoms: [],
        issues: [pullIssue(connectionId, "PULL_CONNECTION_MISSING", false)],
      };
    }
    try {
      const lines =
        connection.facets.pullLines === undefined
          ? await this.deriveLines(connectionId, refs, signal)
          : await connection.facets.pullLines.getPullLines(refs, signal);
      return {
        succeeded: true,
        atoms: normalizePullLines(lines, refs),
        issues: [],
      };
    } catch {
      signal?.throwIfAborted();
      return {
        succeeded: false,
        atoms: [],
        issues: [
          providerIssue(
            connectionId,
            connection.facets.pullLines === undefined
              ? "get-order"
              : "pull-lines",
            connection.facets.pullLines === undefined
              ? "ORDER_DETAIL_PULL_FAILED"
              : "PULL_LINE_READER_FAILED",
            true,
          ),
        ],
      };
    }
  }

  private async enrichAcrossConnections(
    atoms: readonly PullAtom[],
    signal?: AbortSignal,
  ): Promise<{
    readonly atoms: readonly PullAtom[];
    readonly issues: readonly ProviderIssue[];
  }> {
    const identities = uniqueIdentities(
      atoms.flatMap((atom) => atom.catalogIdentities),
    );
    if (atoms.length === 0 || identities.length === 0) {
      return { atoms, issues: [] };
    }
    const readers = this.options.registry
      .list()
      .filter((connection) => connection.facets.catalogMetadata !== undefined);
    if (readers.length === 0) return { atoms, issues: [] };

    const results = await Promise.all(
      readers.map(async (connection) => {
        try {
          const value =
            await connection.facets.catalogMetadata?.readCatalogMetadata(
              identities,
              signal,
            );
          return {
            metadata: parseCatalogMetadata(value ?? {}, identities),
            issues: [] as readonly ProviderIssue[],
          };
        } catch {
          signal?.throwIfAborted();
          return {
            metadata: {},
            issues: [
              pullIssue(
                connection.descriptor.connectionId,
                "CATALOG_METADATA_FAILED",
                true,
              ),
            ],
          };
        }
      }),
    );
    const metadata = results.reduce<
      Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>
    >(
      (combined, result) => mergeCatalogMetadata(combined, result.metadata),
      {},
    );
    return {
      atoms: enrichAtoms(atoms, metadata),
      issues: results.flatMap((result) => result.issues),
    };
  }

  private async deriveLines(
    connectionId: string,
    refs: readonly ProviderOrderRef[],
    signal?: AbortSignal,
  ): Promise<readonly PullLine[]> {
    const reader = this.options.registry.facet(connectionId, "orderDetails");
    const details = await mapConcurrent(
      refs,
      DETAIL_CONCURRENCY,
      async (ref) => {
        const detail = parseOrderDetail(await reader.getOrder(ref, signal));
        if (orderRefKey(detail.ref) !== orderRefKey(ref)) {
          throw new ApplicationError(
            "PROVIDER_ERROR",
            "A provider returned detail for the wrong pull-list order.",
          );
        }
        return detail;
      },
    );
    return details.flatMap((detail) =>
      detail.lines.map((line) => ({
        description: line.description,
        quantity: line.quantity,
        attributes: line.attributes,
        catalogIdentities: line.catalogIdentities,
        allocations: [
          {
            order: detail.ref,
            lineKey: line.lineKey,
            quantity: line.quantity,
          },
        ],
      })),
    );
  }

  private withProgressOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.progressOperation.then(operation);
    this.progressOperation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function normalizePullLines(
  values: readonly PullLine[],
  requestedRefs: readonly ProviderOrderRef[],
): readonly PullAtom[] {
  if (!Array.isArray(values) || values.length > 100_000) {
    throw new ApplicationError(
      "PROVIDER_ERROR",
      "The pull-line response is invalid.",
    );
  }
  const requested = new Set(requestedRefs.map(orderRefKey));
  const represented = new Set<string>();
  const allocationKeys = new Set<string>();
  const atoms: PullAtom[] = [];
  for (const value of values) {
    const line = parsePullLine(value);
    for (const allocation of line.allocations) {
      const key = orderRefKey(allocation.order);
      if (!requested.has(key)) {
        throw new ApplicationError(
          "PROVIDER_ERROR",
          "The pull-line response included an unrequested order.",
        );
      }
      represented.add(key);
      const atom: PullAtom = {
        description: line.description,
        quantity: allocation.quantity,
        attributes: Object.fromEntries(
          Object.entries(line.attributes).map(([attribute, value]) => [
            attribute,
            [value],
          ]),
        ),
        catalogIdentities: line.catalogIdentities,
        allocation,
      };
      const allocationIdentity = allocationKey(allocation);
      if (allocationKeys.has(allocationIdentity)) {
        throw new ApplicationError(
          "PROVIDER_ERROR",
          "The pull-line response repeated an order allocation.",
        );
      }
      allocationKeys.add(allocationIdentity);
      atoms.push(atom);
    }
  }
  if (represented.size !== requested.size) {
    throw new ApplicationError(
      "PROVIDER_ERROR",
      "The pull-line response omitted a requested order.",
    );
  }
  return atoms;
}

function buildProjectedList(
  atoms: readonly PullAtom[],
  orderCount: number,
  sourceIssues: readonly ProviderIssue[],
  grouping: PullListGroupingSettings,
  fetchedAt: string,
  progress: QualifiedPullListProgressState,
): BuiltPullList {
  const components = exactIdentityComponents(atoms);
  const progressByAllocation = new Map(
    progress.allocations.map(
      (allocation) => [progressKey(allocation), allocation] as const,
    ),
  );
  const rows: MasterPullListRow[] = [];
  const allocationsByRow = new Map<string, readonly PullAtom[]>();
  const issues = [...sourceIssues];
  for (const component of components) {
    const conflictConnections = conflictingVariantConnections(component);
    if (conflictConnections.length > 0) {
      issues.push(
        ...conflictConnections.map((connectionId) =>
          pullIssue(connectionId, "PULL_VARIANT_CONFLICT", false),
        ),
      );
      continue;
    }
    const rowKey = componentRowKey(component);
    const row = projectRow(component, rowKey, grouping, progressByAllocation);
    rows.push(row);
    allocationsByRow.set(rowKey, component);
  }
  rows.sort((left, right) => left.rowKey.localeCompare(right.rowKey));
  const totalQuantity = rows.reduce(
    (total, row) => total + row.orderQuantity,
    0,
  );
  const pulledQuantity = rows.reduce(
    (total, row) => total + row.pulledQuantity,
    0,
  );
  return {
    value: {
      orderCount,
      rows,
      totalQuantity,
      pulledQuantity,
      remainingQuantity: totalQuantity - pulledQuantity,
      fetchedAt,
      issues: deduplicateIssues(issues),
    },
    allocationsByRow,
    progress,
  };
}

function exactIdentityComponents(
  atoms: readonly PullAtom[],
): readonly (readonly PullAtom[])[] {
  const parents = atoms.map((_, index) => index);
  const byIdentity = new Map<string, number>();
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root] ?? root;
    let current = index;
    while (current !== root) {
      const next = parents[current] ?? root;
      parents[current] = root;
      current = next;
    }
    return root;
  };
  const unite = (left: number, right: number) => {
    const first = find(left);
    const second = find(right);
    if (first !== second) parents[second] = first;
  };
  atoms.forEach((atom, index) => {
    for (const identity of exactVariantCatalogIdentities(
      atom.catalogIdentities,
      atom.attributes,
    )) {
      const token = catalogIdentityToken(identity);
      const existing = byIdentity.get(token);
      if (existing === undefined) byIdentity.set(token, index);
      else unite(existing, index);
    }
  });
  const components = new Map<number, PullAtom[]>();
  atoms.forEach((atom, index) => {
    const root = find(index);
    const component = components.get(root) ?? [];
    component.push(atom);
    components.set(root, component);
  });
  return [...components.values()];
}

function conflictingVariantConnections(
  component: readonly PullAtom[],
): readonly string[] {
  if (catalogRecordsHaveConflictingProviderExactIdentities(component)) {
    return [
      ...new Set(component.map((atom) => atom.allocation.order.connectionId)),
    ];
  }
  const variantFields: readonly (readonly [
    "condition" | "language" | "finish",
    ReadonlySet<string>,
  ])[] = [
    ["condition", new Set(["condition", "conditionid"])],
    ["language", new Set(["lang", "language", "languageid"])],
    ["finish", new Set(["finish", "finishid", "printing"])],
  ];
  for (const [field, names] of variantFields) {
    const values = new Set(
      component.flatMap((atom) =>
        Object.entries(atom.attributes)
          .filter(([name]) => names.has(normalizedAttributeName(name)))
          .flatMap(([, attributeValues]) => attributeValues)
          .map((value) => value.trim())
          .filter(Boolean)
          .map((value) => canonicalVariantAttribute(field, value)),
      ),
    );
    if (values.size > 1) {
      return [
        ...new Set(component.map((atom) => atom.allocation.order.connectionId)),
      ];
    }
  }
  return [];
}

function projectRow(
  component: readonly PullAtom[],
  rowKey: string,
  grouping: PullListGroupingSettings,
  progress: ReadonlyMap<string, PullProgressAllocation>,
): MasterPullListRow {
  const attributes = mergeAttributes(component);
  const productName =
    [...new Set(component.map((atom) => atom.description))].sort()[0] ?? "Item";
  const productLine =
    firstAttribute(attributes, "productLine", "productType") || "Marketplace";
  const condition = displayCondition(attributes);
  const number = firstAttribute(attributes, "number");
  const setName = firstAttribute(attributes, "setName", "set");
  const rarity = firstAttribute(attributes, "rarity");
  const mainPhotoUrl = firstAttribute(attributes, "mainPhotoUrl");
  const setReleaseDate = firstAttribute(
    attributes,
    "setReleaseDate",
    "releaseDate",
  );
  const colorGroup = pullListColorGroup(attributes, grouping);
  const orderQuantity = component.reduce(
    (total, atom) => total + atom.quantity,
    0,
  );
  const pulledQuantity = component.reduce((total, atom) => {
    const stored = progress.get(allocationKey(atom.allocation));
    return total + Math.min(stored?.quantity ?? 0, atom.quantity);
  }, 0);
  const facts = {
    productLine,
    productName,
    setName,
    number,
    rarity,
    condition,
    setReleaseDate,
    attributes,
  };
  return {
    rowKey,
    skuId: rowKey,
    productLine,
    productName,
    condition,
    number,
    setName,
    rarity,
    quantity: 0,
    mainPhotoUrl,
    setReleaseDate,
    orderQuantity,
    attributes,
    metadata:
      colorGroup.length === 0 ? [] : [{ label: "Color", values: colorGroup }],
    bin: pullListBin(facts, grouping),
    pulledQuantity,
    remainingQuantity: orderQuantity - pulledQuantity,
    pulled: pulledQuantity === orderQuantity,
    canTrackPullProgress: true,
  };
}

function componentRowKey(component: readonly PullAtom[]): string {
  const identityCounts = new Map<string, { count: number; derived: boolean }>();
  for (const atom of component) {
    const tokens = new Map(
      exactVariantCatalogIdentities(
        atom.catalogIdentities,
        atom.attributes,
      ).map((identity) => [catalogIdentityToken(identity), identity]),
    );
    for (const [token, identity] of tokens) {
      const current = identityCounts.get(token);
      identityCounts.set(token, {
        count: (current?.count ?? 0) + 1,
        derived: identity.namespace.startsWith("normalized."),
      });
    }
  }
  const exact = [...identityCounts].sort(
    ([leftToken, left], [rightToken, right]) =>
      right.count - left.count ||
      Number(left.derived) - Number(right.derived) ||
      leftToken.localeCompare(rightToken),
  )[0]?.[0];
  if (exact !== undefined) return exact;
  const atom = component[0];
  if (atom === undefined)
    throw new Error("An empty pull component is invalid.");
  return `allocation:${encodeURIComponent(orderRefKey(atom.allocation.order))}:${encodeURIComponent(atom.allocation.lineKey)}`;
}

function normalizedAttributeName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function catalogIdentityToken(identity: CatalogIdentity): string {
  return `${identity.namespace}:${encodeURIComponent(identity.value)}`;
}

function mergeAttributes(
  component: readonly PullAtom[],
): Readonly<Record<string, readonly string[]>> {
  const values = new Map<string, Map<string, string>>();
  for (const atom of component) {
    for (const [key, attributeValues] of Object.entries(atom.attributes)) {
      const entries = values.get(key) ?? new Map<string, string>();
      for (const value of attributeValues) {
        entries.set(normalizedValue(value), value);
      }
      values.set(key, entries);
    }
  }
  return Object.fromEntries(
    [...values]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entries]) => [key, [...entries.values()].sort()]),
  );
}

function firstAttribute(
  attributes: Readonly<Record<string, readonly string[]>>,
  ...keys: readonly string[]
): string {
  for (const key of keys) {
    const value = attributes[key]?.[0];
    if (value !== undefined) return value;
  }
  return "";
}

function displayCondition(
  attributes: Readonly<Record<string, readonly string[]>>,
): string {
  const condition = firstAttribute(attributes, "condition");
  const finish = firstAttribute(attributes, "finish", "printing");
  if (
    finish === "" ||
    normalizedValue(condition).includes(normalizedValue(finish))
  ) {
    return condition;
  }
  return condition === "" ? finish : `${condition} · ${finish}`;
}

function setAllocationProgress(
  state: QualifiedPullListProgressState,
  atoms: readonly PullAtom[],
  pulled: boolean,
  pulledAt: string,
): QualifiedPullListProgressState {
  const updates = new Map(
    state.allocations.map((entry) => [progressKey(entry), entry] as const),
  );
  for (const atom of atoms) {
    const key = allocationKey(atom.allocation);
    if (pulled) {
      updates.set(key, {
        connectionId: atom.allocation.order.connectionId,
        remoteId: atom.allocation.order.remoteId,
        lineKey: atom.allocation.lineKey,
        quantity: atom.quantity,
        pulledAt,
      });
    } else {
      updates.delete(key);
    }
  }
  return {
    version: 2,
    allocations: [...updates.values()].sort(compareProgress),
  };
}

function allocationKey(allocation: PullAtom["allocation"]): string {
  return JSON.stringify([
    allocation.order.connectionId,
    allocation.order.remoteId,
    allocation.lineKey,
  ]);
}

function progressKey(allocation: PullProgressAllocation): string {
  return JSON.stringify([
    allocation.connectionId,
    allocation.remoteId,
    allocation.lineKey,
  ]);
}

function compareProgress(
  left: PullProgressAllocation,
  right: PullProgressAllocation,
): number {
  return progressKey(left).localeCompare(progressKey(right));
}

function groupRefsByConnection(
  refs: readonly ProviderOrderRef[],
): ReadonlyMap<string, readonly ProviderOrderRef[]> {
  const groups = new Map<string, ProviderOrderRef[]>();
  for (const ref of refs) {
    const group = groups.get(ref.connectionId) ?? [];
    group.push(ref);
    groups.set(ref.connectionId, group);
  }
  return groups;
}

function pullIssue(
  connectionId: string,
  code: string,
  retryable: boolean,
): ProviderIssue {
  return providerIssue(connectionId, "pull-lines", code, retryable);
}

function providerIssue(
  connectionId: string,
  operation: ProviderIssue["operation"],
  code: string,
  retryable: boolean,
): ProviderIssue {
  return { connectionId, operation, code, retryable };
}

function deduplicateIssues(
  issues: readonly ProviderIssue[],
): readonly ProviderIssue[] {
  return [
    ...new Map(
      issues.map((issue) => [
        JSON.stringify([issue.connectionId, issue.operation, issue.code]),
        issue,
      ]),
    ).values(),
  ];
}

function normalizedValue(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function safeRowKey(value: string): string {
  if (
    value.trim().length === 0 ||
    Array.from(value).length > 512 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new ApplicationError(
      "CONFIGURATION_ERROR",
      "The pull-list row key is invalid.",
    );
  }
  return value;
}

function uniqueIdentities(
  identities: readonly CatalogIdentity[],
): readonly CatalogIdentity[] {
  return [
    ...new Map(
      identities.map((identity) => [
        `${catalogIdentityToken(identity)}:${identity.precision}`,
        identity,
      ]),
    ).values(),
  ];
}

function enrichAtoms(
  atoms: readonly PullAtom[],
  metadata: Readonly<
    Record<string, Readonly<Record<string, readonly string[]>>>
  >,
): readonly PullAtom[] {
  return atoms.map((atom) => {
    let enriched: Readonly<Record<string, readonly string[]>> = {};
    for (const identity of atom.catalogIdentities) {
      enriched = mergeAttributeRecords(
        enriched,
        metadata[catalogIdentityToken(identity)] ?? {},
      );
    }
    return {
      ...atom,
      attributes: { ...enriched, ...atom.attributes },
    };
  });
}

function mergeAttributeRecords(
  left: Readonly<Record<string, readonly string[]>>,
  right: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, readonly string[]>> {
  const result: Record<string, readonly string[]> = { ...left };
  for (const [key, values] of Object.entries(right)) {
    result[key] = [
      ...new Map(
        [...(result[key] ?? []), ...values].map((value) => [
          normalizedValue(value),
          value,
        ]),
      ).values(),
    ];
  }
  return result;
}

function mergeCatalogMetadata(
  left: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>,
  right: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>,
): Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> {
  const result = { ...left };
  for (const [identity, attributes] of Object.entries(right)) {
    result[identity] = mergeAttributeRecords(
      result[identity] ?? {},
      attributes,
    );
  }
  return result;
}

function parseCatalogMetadata(
  value: unknown,
  identities: readonly CatalogIdentity[],
): Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidCatalogMetadata();
  }
  const allowed = new Set(identities.map(catalogIdentityToken));
  const entries = Object.entries(value);
  if (entries.length > allowed.size) throw invalidCatalogMetadata();
  const result: Record<
    string,
    Readonly<Record<string, readonly string[]>>
  > = {};
  for (const [identity, rawAttributes] of entries) {
    if (
      !allowed.has(identity) ||
      typeof rawAttributes !== "object" ||
      rawAttributes === null ||
      Array.isArray(rawAttributes)
    ) {
      throw invalidCatalogMetadata();
    }
    const attributeEntries = Object.entries(
      rawAttributes as Record<string, unknown>,
    );
    if (attributeEntries.length > 64) throw invalidCatalogMetadata();
    result[identity] = Object.fromEntries(
      attributeEntries.map(([attribute, rawValues]) => {
        if (
          attribute.trim().length === 0 ||
          Array.from(attribute).length > 128 ||
          /\p{Cc}/u.test(attribute)
        ) {
          throw invalidCatalogMetadata();
        }
        return [attribute, metadataValues(rawValues)] as const;
      }),
    );
  }
  return result;
}

function metadataValues(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw invalidCatalogMetadata();
  }
  return value.map((item) => {
    if (
      typeof item !== "string" ||
      item.trim().length === 0 ||
      Array.from(item).length > 256 ||
      /\p{Cc}/u.test(item)
    ) {
      throw invalidCatalogMetadata();
    }
    return item;
  });
}

function invalidCatalogMetadata(): ApplicationError {
  return new ApplicationError(
    "PROVIDER_ERROR",
    "The catalog metadata response is invalid.",
  );
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<readonly R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value !== undefined) results[index] = await operation(value);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
