import {
  SellerOrderStatus,
  type OrderRefundMutationResult,
  type PullSheetOrderAllocation,
  type PullSheetRow,
  type RefundOrderProductInput,
  type SellerOrderDetail,
  type SellerOrderRefundOptions,
  type TcgplayerSellerClient,
} from "tcgplayer-private-api";
import { ApplicationError, safeErrorCode } from "./errors.js";
import type {
  PulledOrderLineProgress,
  PullListProgressState,
  PullListProgressStore,
} from "./pull-list-progress.js";
import {
  resolveSellerKey,
  type SellerKeySource,
} from "./seller-credentials.js";
import {
  toManagedOrder,
  type ManagedOrderList,
  type ManagedOrderSummary,
} from "./ready-orders.js";
import {
  DEFAULT_PULL_LIST_BINNING_CONFIG,
  pullListBin,
  pullListColorGroup,
  pullListSettingsKey,
  type PullListGroupingSettings,
} from "./pull-list-binning.js";
import { requiresShipmentTracking } from "./shipment-policy.js";

export type { ManagedOrderList, ManagedOrderSummary } from "./ready-orders.js";

export type OrderListScope = "all" | "ready-to-ship";
export type ManualPrintActionType =
  "print-address-label" | "print-packing-slip";

export interface AddTrackingResult {
  readonly orderNumber: string;
  readonly carrier: string;
  readonly outcome: "applied" | "already-applied";
}

export type ManagedOrderRefundInput =
  | {
      readonly type: "full";
      readonly origin: string;
      readonly reason: string;
      readonly reasonText: string;
    }
  | {
      readonly type: "partial";
      readonly origin: string;
      readonly reason: string;
      readonly reasonText: string;
      readonly shippingRefundAmount: number;
      readonly products: readonly RefundOrderProductInput[];
    };

export interface PirateShipPreparation {
  readonly url: "https://ship.pirateship.com/ship/single";
  readonly pasteAddress: string;
}

export interface ManagedOrderDetail extends Omit<
  SellerOrderDetail,
  "allowedActions"
> {
  readonly canMarkShipped: boolean;
  readonly fetchedAt: string;
}

export interface PullListMetadata {
  readonly label: string;
  readonly values: readonly string[];
}

export interface ManagedPullListRow extends Omit<
  PullSheetRow,
  "orderAllocations"
> {
  readonly productId?: number;
  readonly attributes: Readonly<Record<string, readonly string[]>>;
  readonly metadata: readonly PullListMetadata[];
  readonly bin: string;
  readonly pulledQuantity: number;
  readonly remainingQuantity: number;
  readonly pulled: boolean;
  readonly canTrackPullProgress: boolean;
}

export interface ManagedMasterPullList {
  readonly orderCount: number;
  readonly rows: readonly ManagedPullListRow[];
  readonly totalQuantity: number;
  readonly pulledQuantity: number;
  readonly remainingQuantity: number;
  readonly fetchedAt: string;
  readonly metadataIssue?: string;
}

type OrderManagementClient = Pick<
  TcgplayerSellerClient,
  | "searchOrders"
  | "getOrder"
  | "confirmOrder"
  | "getPackingSlip"
  | "exportPullSheet"
  | "searchMarketplaceProducts"
  | "detectCarrier"
  | "addOrderTracking"
  | "markOrdersShipped"
  | "getOrderRefundOptions"
  | "refundOrderFull"
  | "refundOrderPartial"
>;

export interface OrderManagementServiceOptions {
  readonly client: OrderManagementClient;
  readonly sellerKey: SellerKeySource;
  readonly pullListProgressStore: PullListProgressStore;
  readonly pageSize: number;
  readonly maximumPages: number;
  readonly timezoneOffsetMinutes: number;
  readonly pullListGrouping?: () => Promise<PullListGroupingSettings>;
  readonly cacheMilliseconds?: number;
  readonly now?: () => Date;
  readonly executePrint?: (
    orderNumber: string,
    actionType: ManualPrintActionType,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly onShipmentAccepted?: (orderNumber: string) => void;
  readonly onShipmentAttempt?: (attempt: {
    readonly orderNumber: string;
    readonly outcome: "applied" | "already-applied" | "failed";
    readonly errorCode?: string;
    readonly occurredAt: string;
  }) => void | Promise<void>;
}

interface CachedOrders {
  readonly expiresAt: number;
  readonly value: ManagedOrderList;
}

interface CachedPirateShipPreparation {
  readonly expiresAt: number;
  readonly value: PirateShipPreparation;
}

interface CachedOrderDetail {
  readonly expiresAt: number;
  readonly value: ManagedOrderDetail;
}

interface CachedRefundOptions {
  readonly expiresAt: number;
  readonly value: SellerOrderRefundOptions;
}

interface CachedPullList {
  readonly expiresAt: number;
  readonly value: ManagedMasterPullList;
  readonly groupingKey: string;
  readonly orderNumbers: ReadonlySet<string>;
  readonly allocationsBySku: ReadonlyMap<
    string,
    readonly PullSheetOrderAllocation[]
  >;
}

interface LoadedPullListRows {
  readonly rows: readonly ManagedPullListRow[];
  readonly allocationsBySku: ReadonlyMap<
    string,
    readonly PullSheetOrderAllocation[]
  >;
  readonly metadataIssue?: string;
}

export class OrderManagementService {
  private readonly client: OrderManagementClient;
  private readonly sellerKey: SellerKeySource;
  private readonly pullListProgressStore: PullListProgressStore;
  private cachedSellerKey: string | undefined;
  private readonly pageSize: number;
  private readonly maximumPages: number;
  private readonly timezoneOffsetMinutes: number;
  private readonly pullListGrouping: () => Promise<PullListGroupingSettings>;
  private readonly cacheMilliseconds: number;
  private readonly now: () => Date;
  private readonly executePrint?: OrderManagementServiceOptions["executePrint"];
  private readonly onShipmentAccepted:
    OrderManagementServiceOptions["onShipmentAccepted"] | undefined;
  private readonly onShipmentAttempt:
    OrderManagementServiceOptions["onShipmentAttempt"] | undefined;
  private readonly cache = new Map<OrderListScope, CachedOrders>();
  private readonly detailCache = new Map<string, CachedOrderDetail>();
  private pullListCache: CachedPullList | undefined;
  private pullListProgressOperation: Promise<void> = Promise.resolve();
  private readonly shippedOrdersPendingPullListReconciliation =
    new Set<string>();
  private readonly refundingOrders = new Set<string>();
  private refundOptionsCache: CachedRefundOptions | undefined;
  private readonly pirateShipCache = new Map<
    string,
    CachedPirateShipPreparation
  >();

  constructor(options: OrderManagementServiceOptions) {
    this.client = options.client;
    this.sellerKey = options.sellerKey;
    this.pullListProgressStore = options.pullListProgressStore;
    if (typeof options.sellerKey === "string") {
      requiredText(options.sellerKey, "Seller key", 256);
    }
    this.pageSize = boundedInteger(options.pageSize, 1, 500, "Page size");
    this.maximumPages = boundedInteger(
      options.maximumPages,
      1,
      10_000,
      "Maximum pages",
    );
    this.timezoneOffsetMinutes = boundedInteger(
      options.timezoneOffsetMinutes,
      -1440,
      1440,
      "Timezone offset",
    );
    this.pullListGrouping =
      options.pullListGrouping ??
      (() =>
        Promise.resolve({
          groupLands: true,
          groupMulticolored: true,
          binning: DEFAULT_PULL_LIST_BINNING_CONFIG,
        }));
    this.cacheMilliseconds = boundedInteger(
      options.cacheMilliseconds ?? 30_000,
      0,
      3_600_000,
      "Cache duration",
    );
    this.now = options.now ?? (() => new Date());
    this.executePrint = options.executePrint;
    this.onShipmentAccepted = options.onShipmentAccepted;
    this.onShipmentAttempt = options.onShipmentAttempt;
  }

  async listOrders(
    scope: OrderListScope,
    options: { readonly force?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<ManagedOrderList> {
    const sellerKey = this.currentSellerKey();
    const now = this.now();
    const cached = this.cache.get(scope);
    if (
      options.force !== true &&
      cached !== undefined &&
      cached.expiresAt > now.getTime()
    ) {
      return cached.value;
    }

    const orders = new Map<string, ManagedOrderSummary>();
    let offset = 0;
    for (let page = 0; page < this.maximumPages; page += 1) {
      const response = await this.client.searchOrders(
        {
          sellerKey,
          searchRange: "LastThreeMonths",
          ...(scope === "ready-to-ship"
            ? { statuses: [SellerOrderStatus.ReadyToShip] }
            : {}),
          sort: [{ field: "orderDate", direction: "descending" }],
          offset,
          limit: this.pageSize,
        },
        options.signal === undefined ? undefined : { signal: options.signal },
      );
      for (const order of response.orders) {
        orders.set(order.orderNumber, toManagedOrder(order));
      }
      offset += response.orders.length;
      if (offset >= response.totalOrders) {
        const value = {
          orders: [...orders.values()],
          fetchedAt: now.toISOString(),
        };
        this.cache.set(scope, {
          expiresAt: now.getTime() + this.cacheMilliseconds,
          value,
        });
        return value;
      }
      if (response.orders.length === 0) {
        throw new ApplicationError(
          "PROVIDER_ERROR",
          "Order pagination ended before the reported total.",
          { retryable: true },
        );
      }
    }
    throw new ApplicationError(
      "PROVIDER_ERROR",
      "Order history exceeded the configured page limit.",
    );
  }

  async getPackingSlip(
    orderNumber: string,
    signal?: AbortSignal,
  ): Promise<{ readonly fileName: string; readonly bytes: Uint8Array }> {
    const normalized = requiredText(orderNumber, "Order number", 128);
    const document = await this.client.getPackingSlip(
      {
        orderNumber: normalized,
        timezoneOffsetMinutes: this.timezoneOffsetMinutes,
      },
      signal === undefined ? undefined : { signal },
    );
    if (
      document.orderNumbers.length !== 1 ||
      document.orderNumbers[0] !== normalized
    ) {
      throw new ApplicationError(
        "PROVIDER_ERROR",
        "The packing slip did not identify the requested order.",
      );
    }
    return { fileName: document.fileName, bytes: document.bytes };
  }

  async getOrder(
    orderNumber: string,
    options: { readonly force?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<ManagedOrderDetail> {
    const sellerKey = this.currentSellerKey();
    const normalized = requiredText(orderNumber, "Order number", 128);
    const now = this.now();
    const cacheKey = normalized.toLocaleLowerCase();
    const cached = this.detailCache.get(cacheKey);
    if (
      options.force !== true &&
      cached !== undefined &&
      cached.expiresAt > now.getTime()
    ) {
      return cached.value;
    }
    const confirmed = await this.client.confirmOrder(
      { sellerKey, orderNumber: normalized },
      options.signal === undefined ? undefined : { signal: options.signal },
    );
    if (confirmed.order.orderNumber !== normalized) {
      throw new ApplicationError(
        "PROVIDER_ERROR",
        "The confirmed order did not match the requested order.",
      );
    }
    const value = toManagedOrderDetail(confirmed.order, now.toISOString());
    this.detailCache.set(cacheKey, {
      expiresAt: now.getTime() + this.cacheMilliseconds,
      value,
    });
    return value;
  }

  async getMasterPullList(
    options: { readonly force?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<ManagedMasterPullList> {
    this.currentSellerKey();
    const now = this.now();
    const grouping = await this.pullListGrouping();
    const groupingKey = pullListSettingsKey(grouping);
    const previousCache = this.pullListCache;
    const matchingCache =
      previousCache === undefined
        ? undefined
        : previousCache.groupingKey === groupingKey
          ? previousCache
          : {
              ...previousCache,
              groupingKey,
              value: projectMasterPullList(previousCache.value, grouping),
            };
    if (
      options.force !== true &&
      matchingCache !== undefined &&
      matchingCache.expiresAt > now.getTime()
    ) {
      return matchingCache.value;
    }
    const readyOrders = await this.listOrders("ready-to-ship", options);
    const providerReadyOrderNumbers = readyOrders.orders
      .filter((order) => order.statusCode === SellerOrderStatus.ReadyToShip)
      .map((order) => order.orderNumber);
    const providerReadyOrderNumberSet = new Set(providerReadyOrderNumbers);
    for (const orderNumber of this.shippedOrdersPendingPullListReconciliation) {
      if (!providerReadyOrderNumberSet.has(orderNumber)) {
        this.shippedOrdersPendingPullListReconciliation.delete(orderNumber);
      }
    }
    const readyOrderNumbers = providerReadyOrderNumbers.filter(
      (orderNumber) =>
        !this.shippedOrdersPendingPullListReconciliation.has(orderNumber),
    );
    const readyOrderNumberSet = new Set(readyOrderNumbers);
    const activeCache =
      matchingCache === undefined ||
      sameStringSet([...matchingCache.orderNumbers], readyOrderNumbers)
        ? matchingCache
        : await this.retainPullListOrders(
            matchingCache,
            readyOrderNumberSet,
            now.toISOString(),
          );
    const orderNumbers =
      activeCache === undefined
        ? readyOrderNumbers
        : readyOrderNumbers.filter(
            (orderNumber) => !activeCache.orderNumbers.has(orderNumber),
          );
    if (orderNumbers.length === 0) {
      if (activeCache !== undefined) {
        const value = {
          ...activeCache.value,
          fetchedAt: now.toISOString(),
        };
        this.pullListCache = {
          ...activeCache,
          expiresAt: now.getTime() + this.cacheMilliseconds,
          value,
        };
        return value;
      }
      return this.withPullListProgressOperation(async () => {
        const allocationsBySku = new Map<
          string,
          readonly PullSheetOrderAllocation[]
        >();
        await this.loadReconciledPullListProgress(allocationsBySku);
        const value: ManagedMasterPullList = {
          orderCount: 0,
          rows: [],
          totalQuantity: 0,
          pulledQuantity: 0,
          remainingQuantity: 0,
          fetchedAt: now.toISOString(),
        };
        this.pullListCache = {
          expiresAt: now.getTime() + this.cacheMilliseconds,
          value,
          groupingKey,
          orderNumbers: new Set(),
          allocationsBySku,
        };
        return value;
      });
    }
    const loaded = await this.loadPullListRows(
      orderNumbers,
      grouping,
      options.signal,
    );
    const baseRows =
      activeCache === undefined
        ? loaded.rows
        : mergeManagedPullListRows(activeCache.value.rows, loaded.rows);
    const allocationsBySku =
      activeCache === undefined
        ? loaded.allocationsBySku
        : mergePullListAllocationMaps(
            activeCache.allocationsBySku,
            loaded.allocationsBySku,
          );
    const accumulatedOrderNumbers = new Set([
      ...(activeCache?.orderNumbers ?? []),
      ...orderNumbers,
    ]);
    return this.withPullListProgressOperation(async () => {
      const progress =
        await this.loadReconciledPullListProgress(allocationsBySku);
      const metadataIssue = combinePullListMetadataIssues(
        activeCache?.value.metadataIssue,
        loaded.metadataIssue,
      );
      const value = applyPullListProgress(
        {
          orderCount: accumulatedOrderNumbers.size,
          rows: baseRows,
          totalQuantity: baseRows.reduce(
            (total, row) => total + row.orderQuantity,
            0,
          ),
          pulledQuantity: 0,
          remainingQuantity: 0,
          fetchedAt: now.toISOString(),
          ...(metadataIssue === undefined ? {} : { metadataIssue }),
        },
        allocationsBySku,
        progress,
      );
      this.pullListCache = {
        expiresAt: now.getTime() + this.cacheMilliseconds,
        value,
        groupingKey,
        orderNumbers: accumulatedOrderNumbers,
        allocationsBySku,
      };
      return value;
    });
  }

  private async retainPullListOrders(
    cached: CachedPullList,
    retainedOrderNumbers: ReadonlySet<string>,
    fetchedAt: string,
  ): Promise<CachedPullList> {
    const reduced = retainCachedPullListOrders(
      cached,
      retainedOrderNumbers,
      fetchedAt,
    );
    this.pullListCache = reduced;
    return this.withPullListProgressOperation(async () => {
      const progress = await this.loadReconciledPullListProgress(
        reduced.allocationsBySku,
      );
      const reconciled = {
        ...reduced,
        value: applyPullListProgress(
          reduced.value,
          reduced.allocationsBySku,
          progress,
        ),
      };
      if (this.pullListCache === reduced) this.pullListCache = reconciled;
      return reconciled;
    });
  }

  private async removeOrderFromPullListCache(
    orderNumber: string,
  ): Promise<void> {
    const cached = this.pullListCache;
    if (cached?.orderNumbers.has(orderNumber) !== true) return;
    const retainedOrderNumbers = new Set(
      [...cached.orderNumbers].filter((candidate) => candidate !== orderNumber),
    );
    try {
      await this.retainPullListOrders(
        cached,
        retainedOrderNumbers,
        this.now().toISOString(),
      );
    } catch {
      // The in-memory list was already reduced. A progress-store failure must
      // not turn a confirmed remote shipment into an uncertain mutation.
    }
  }

  private async loadPullListRows(
    orderNumbers: readonly string[],
    grouping: PullListGroupingSettings,
    signal?: AbortSignal,
  ): Promise<LoadedPullListRows> {
    const requestOptions = signal === undefined ? undefined : { signal };
    const rowsBySku = new Map<string, PullSheetRow>();
    for (let offset = 0; offset < orderNumbers.length; offset += 500) {
      signal?.throwIfAborted();
      const batch = orderNumbers.slice(offset, offset + 500);
      const document = await this.client.exportPullSheet(
        {
          orderNumbers: batch,
          timezoneOffsetMinutes: this.timezoneOffsetMinutes,
        },
        requestOptions,
      );
      if (!sameStringSet(document.orderNumbers, batch)) {
        throw new ApplicationError(
          "PROVIDER_ERROR",
          "The pull sheet did not identify every requested order.",
        );
      }
      for (const row of document.rows) {
        const existing = rowsBySku.get(row.skuId);
        if (existing === undefined) {
          rowsBySku.set(row.skuId, row);
          continue;
        }
        if (!samePullSheetProduct(existing, row)) {
          throw new ApplicationError(
            "PROVIDER_ERROR",
            "The pull sheet returned conflicting details for one SKU.",
          );
        }
        rowsBySku.set(row.skuId, {
          ...existing,
          orderQuantity: existing.orderQuantity + row.orderQuantity,
          orderAllocations: mergeOrderAllocations(
            existing.orderAllocations,
            row.orderAllocations,
          ),
        });
      }
    }
    const pullSheetRows = [...rowsBySku.values()];
    const productIds = await this.loadPullListProductIds(
      pullSheetRows,
      orderNumbers,
      signal,
    );
    const uniqueProductIds = [...new Set(productIds.bySku.values())];
    const metadata = await this.loadPullListMetadata(uniqueProductIds, signal);
    const baseRows = pullSheetRows.map<ManagedPullListRow>((row) => {
      const productId = productIds.bySku.get(row.skuId);
      const attributes =
        productId === undefined
          ? {}
          : (metadata.attributes.get(productId) ?? {});
      const colorGroup = pullListColorGroup(attributes, grouping);
      const facts = {
        productLine: row.productLine,
        productName: row.productName,
        setName: row.setName,
        number: row.number,
        rarity: row.rarity,
        condition: row.condition,
        setReleaseDate: row.setReleaseDate,
        attributes,
      };
      return {
        productLine: row.productLine,
        productName: row.productName,
        condition: row.condition,
        number: row.number,
        setName: row.setName,
        rarity: row.rarity,
        quantity: row.quantity,
        mainPhotoUrl: row.mainPhotoUrl,
        setReleaseDate: row.setReleaseDate,
        skuId: row.skuId,
        orderQuantity: row.orderQuantity,
        ...(productId === undefined ? {} : { productId }),
        attributes,
        metadata:
          colorGroup.length === 0
            ? []
            : [{ label: "Color", values: colorGroup }],
        bin: pullListBin(facts, grouping),
        pulledQuantity: 0,
        remainingQuantity: row.orderQuantity,
        pulled: false,
        canTrackPullProgress: false,
      };
    });
    const allocationsBySku = new Map(
      pullSheetRows.map((row) => [row.skuId, row.orderAllocations] as const),
    );
    const metadataIssue = combinePullListMetadataIssues(
      productIds.issue,
      metadata.issue,
    );
    return {
      rows: baseRows,
      allocationsBySku,
      ...(metadataIssue === undefined ? {} : { metadataIssue }),
    };
  }

  async setPullListRowPulled(
    skuId: string,
    pulled: boolean,
    signal?: AbortSignal,
  ): Promise<ManagedPullListRow> {
    const normalizedSkuId = requiredText(skuId, "SKU", 128);
    if (typeof pulled !== "boolean") {
      throw new ApplicationError(
        "CONFIGURATION_ERROR",
        "Pulled must be true or false.",
      );
    }
    await this.getMasterPullList(signal === undefined ? {} : { signal });
    return this.withPullListProgressOperation(async () => {
      const cached = this.pullListCache;
      const currentRow = cached?.value.rows.find(
        (row) => row.skuId === normalizedSkuId,
      );
      const allocations = cached?.allocationsBySku.get(normalizedSkuId);
      if (cached === undefined || currentRow === undefined) {
        throw new ApplicationError(
          "CONFIGURATION_ERROR",
          "The selected card is not in the current master pull list.",
        );
      }
      if (!trackableAllocations(currentRow.orderQuantity, allocations)) {
        throw new ApplicationError(
          "PROVIDER_ERROR",
          "TCGplayer did not identify the order allocation for this card, so pull progress cannot be changed safely.",
        );
      }
      const current = await this.loadReconciledPullListProgress(
        cached.allocationsBySku,
      );
      const next = setSkuPullProgress(
        current,
        normalizedSkuId,
        allocations,
        pulled,
        this.now().toISOString(),
      );
      await this.pullListProgressStore.save(next);
      const value = applyPullListProgress(
        cached.value,
        cached.allocationsBySku,
        next,
      );
      this.pullListCache = { ...cached, value };
      const updated = value.rows.find((row) => row.skuId === normalizedSkuId);
      if (updated === undefined) {
        throw new ApplicationError(
          "PERSISTENCE_ERROR",
          "The updated card disappeared from pull-list progress.",
        );
      }
      return updated;
    });
  }

  private async loadReconciledPullListProgress(
    allocationsBySku: ReadonlyMap<string, readonly PullSheetOrderAllocation[]>,
  ): Promise<PullListProgressState> {
    const current = await this.pullListProgressStore.load();
    const reconciled = reconcilePullListProgress(current, allocationsBySku);
    if (reconciled.changed) {
      await this.pullListProgressStore.save(reconciled.state);
    }
    return reconciled.state;
  }

  private withPullListProgressOperation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const result = this.pullListProgressOperation.then(operation);
    this.pullListProgressOperation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async loadPullListProductIds(
    rows: readonly PullSheetRow[],
    orderNumbers: readonly string[],
    signal?: AbortSignal,
  ): Promise<{
    readonly bySku: ReadonlyMap<string, number>;
    readonly issue?: string;
  }> {
    const bySku = new Map<string, number>();
    const unresolvedSkuIds = new Set<string>();
    for (const row of rows) {
      const productId = parseProductIdFromPhotoUrl(row.mainPhotoUrl);
      if (productId === undefined) {
        unresolvedSkuIds.add(row.skuId);
      } else {
        bySku.set(row.skuId, productId);
      }
    }
    if (unresolvedSkuIds.size === 0) return { bySku };
    try {
      for (const orderNumber of orderNumbers) {
        signal?.throwIfAborted();
        const cacheKey = orderNumber.toLocaleLowerCase();
        const cached = this.detailCache.get(cacheKey);
        const now = this.now();
        const order =
          cached !== undefined && cached.expiresAt > now.getTime()
            ? cached.value
            : toManagedOrderDetail(
                await this.client.getOrder(
                  orderNumber,
                  signal === undefined ? undefined : { signal },
                ),
                now.toISOString(),
              );
        if (order.orderNumber !== orderNumber) {
          throw new ApplicationError(
            "PROVIDER_ERROR",
            "TCGplayer returned product metadata for a different order.",
          );
        }
        if (cached === undefined || cached.expiresAt <= now.getTime()) {
          this.detailCache.set(cacheKey, {
            expiresAt: now.getTime() + this.cacheMilliseconds,
            value: order,
          });
        }
        for (const product of order.products) {
          if (!unresolvedSkuIds.has(product.skuId)) continue;
          const productId = parseProductId(product.productId);
          if (productId === undefined) continue;
          bySku.set(product.skuId, productId);
          unresolvedSkuIds.delete(product.skuId);
        }
        if (unresolvedSkuIds.size === 0) break;
      }
      return { bySku };
    } catch (cause) {
      signal?.throwIfAborted();
      void cause;
      return {
        bySku,
        issue: "Optional card metadata could not be matched to every product.",
      };
    }
  }

  private async loadPullListMetadata(
    productIds: readonly number[],
    signal?: AbortSignal,
  ): Promise<{
    readonly attributes: ReadonlyMap<
      number,
      Readonly<Record<string, readonly string[]>>
    >;
    readonly issue?: string;
  }> {
    const attributes = new Map<
      number,
      Readonly<Record<string, readonly string[]>>
    >();
    try {
      for (let offset = 0; offset < productIds.length; offset += 24) {
        signal?.throwIfAborted();
        const batch = productIds.slice(offset, offset + 24);
        const result = await this.client.searchMarketplaceProducts(
          { productIds: batch, channelId: 0, offset: 0, limit: batch.length },
          signal === undefined ? undefined : { signal },
        );
        const requested = new Set(batch);
        for (const product of result.products) {
          if (!requested.has(product.productId)) continue;
          attributes.set(product.productId, {
            ...(product.attributes ?? {}),
            ...(product.colors === undefined ? {} : { color: product.colors }),
            ...(product.cardTypes === undefined
              ? {}
              : { cardType: product.cardTypes }),
          });
        }
      }
      return { attributes };
    } catch (cause) {
      signal?.throwIfAborted();
      void cause;
      return {
        attributes,
        issue: "Optional card metadata could not be loaded.",
      };
    }
  }

  async preparePirateShip(
    orderNumber: string,
    signal?: AbortSignal,
  ): Promise<PirateShipPreparation> {
    const normalized = requiredText(orderNumber, "Order number", 128);
    const now = this.now();
    const cached = this.pirateShipCache.get(normalized);
    if (cached !== undefined && cached.expiresAt > now.getTime()) {
      return cached.value;
    }
    const address = (
      await this.getOrder(normalized, signal === undefined ? {} : { signal })
    ).shippingAddress;
    const regionAndPostal = [address.territory, address.postalCode]
      .filter((part) => part.trim())
      .join(" ");
    const locality = [address.city, regionAndPostal]
      .filter((part) => part.trim())
      .join(", ");
    const value = {
      url: "https://ship.pirateship.com/ship/single" as const,
      pasteAddress: [
        address.recipientName,
        address.addressOne,
        address.addressTwo,
        locality,
        address.country,
      ]
        .filter((line): line is string =>
          typeof line === "string" ? Boolean(line.trim()) : false,
        )
        .map((line) => line.trim())
        .join("\n"),
    };
    this.pirateShipCache.set(normalized, {
      expiresAt: now.getTime() + this.cacheMilliseconds,
      value,
    });
    return value;
  }

  async getRefundOptions(
    options: { readonly force?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<SellerOrderRefundOptions> {
    this.currentSellerKey();
    const now = this.now();
    if (
      options.force !== true &&
      this.refundOptionsCache !== undefined &&
      this.refundOptionsCache.expiresAt > now.getTime()
    ) {
      return this.refundOptionsCache.value;
    }
    const value = await this.client.getOrderRefundOptions(
      options.signal === undefined ? undefined : { signal: options.signal },
    );
    this.refundOptionsCache = {
      expiresAt: now.getTime() + 300_000,
      value,
    };
    return value;
  }

  async print(
    orderNumber: string,
    actionType: ManualPrintActionType,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.executePrint === undefined) {
      throw new ApplicationError(
        "CONFIGURATION_ERROR",
        "Order printing is unavailable.",
      );
    }
    await this.executePrint(
      requiredText(orderNumber, "Order number", 128),
      actionType,
      signal,
    );
  }

  async addTracking(
    orderNumber: string,
    trackingNumber: string,
    signal?: AbortSignal,
  ): Promise<AddTrackingResult> {
    const sellerKey = this.currentSellerKey();
    const normalizedOrder = requiredText(orderNumber, "Order number", 128);
    const normalizedTracking = requiredText(
      trackingNumber,
      "Tracking number",
      256,
    );
    this.clearOrderCaches(true);
    const requestOptions = signal === undefined ? undefined : { signal };
    const { carrier } = await this.client.detectCarrier(
      normalizedTracking,
      requestOptions,
    );
    const result = await this.client.addOrderTracking(
      {
        sellerKey,
        orderNumber: normalizedOrder,
        carrier,
        trackingNumber: normalizedTracking,
      },
      requestOptions,
    );
    return { ...result, carrier };
  }

  async markShipped(
    orderNumber: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly orderNumber: string;
    readonly outcome: "applied" | "already-applied";
  }> {
    const sellerKey = this.currentSellerKey();
    const normalized = requiredText(orderNumber, "Order number", 128);
    const confirmed = await this.getOrder(normalized, {
      force: true,
      ...(signal === undefined ? {} : { signal }),
    });
    if (
      requiresShipmentTracking(confirmed.transaction.grossAmount) &&
      confirmed.trackingNumbers.length === 0
    ) {
      throw new ApplicationError(
        "TRACKING_REQUIRED",
        "Orders totaling $50 or more require a tracking number before they can be marked shipped.",
      );
    }
    this.clearOrderCaches(true);
    try {
      const result = await this.client.markOrdersShipped(
        { sellerKey, orderNumbers: [normalized] },
        signal === undefined ? undefined : { signal },
      );
      const failure = result.errors.find(
        (error) => error.orderNumber === normalized,
      );
      if (failure !== undefined) {
        throw new ApplicationError(
          "PROVIDER_ERROR",
          failure.message ?? "TCGplayer did not mark the order shipped.",
        );
      }
      const outcome = result.alreadyShippedOrderNumbers.includes(normalized)
        ? "already-applied"
        : result.updatedOrderNumbers.includes(normalized)
          ? "applied"
          : undefined;
      if (outcome === undefined) {
        throw new ApplicationError(
          "PROVIDER_ERROR",
          "TCGplayer returned an unrecognized shipment result.",
        );
      }
      this.shippedOrdersPendingPullListReconciliation.add(normalized);
      await this.removeOrderFromPullListCache(normalized);
      this.onShipmentAccepted?.(normalized);
      this.notifyShipmentAttempt({
        orderNumber: normalized,
        outcome,
        occurredAt: this.now().toISOString(),
      });
      return { orderNumber: normalized, outcome };
    } catch (error) {
      this.notifyShipmentAttempt({
        orderNumber: normalized,
        outcome: "failed",
        errorCode: safeErrorCode(error),
        occurredAt: this.now().toISOString(),
      });
      throw error;
    }
  }

  private notifyShipmentAttempt(
    attempt: Parameters<
      NonNullable<OrderManagementServiceOptions["onShipmentAttempt"]>
    >[0],
  ): void {
    try {
      void Promise.resolve(this.onShipmentAttempt?.(attempt)).catch(
        () => undefined,
      );
    } catch {
      // Notification failures cannot change the fulfillment mutation result.
    }
  }

  async refundOrder(
    orderNumber: string,
    input: ManagedOrderRefundInput,
    signal?: AbortSignal,
  ): Promise<OrderRefundMutationResult> {
    const sellerKey = this.currentSellerKey();
    const normalized = requiredText(orderNumber, "Order number", 128);
    const refundKey = normalized.toLowerCase();
    if (this.refundingOrders.has(refundKey)) {
      throw new ApplicationError(
        "REVIEW_REQUIRED",
        "A refund for this order is already being submitted.",
      );
    }
    this.refundingOrders.add(refundKey);
    this.clearOrderCaches(true);
    try {
      const requestOptions = signal === undefined ? undefined : { signal };
      if (input.type === "full") {
        return await this.client.refundOrderFull(
          {
            sellerKey,
            orderNumber: normalized,
            origin: input.origin,
            reason: input.reason,
            reasonText: input.reasonText,
          },
          requestOptions,
        );
      }
      return await this.client.refundOrderPartial(
        {
          sellerKey,
          orderNumber: normalized,
          origin: input.origin,
          reason: input.reason,
          reasonText: input.reasonText,
          shippingRefundAmount: input.shippingRefundAmount,
          products: input.products,
        },
        requestOptions,
      );
    } finally {
      this.refundingOrders.delete(refundKey);
    }
  }

  private currentSellerKey(): string {
    const sellerKey = requiredText(
      resolveSellerKey(this.sellerKey),
      "Seller key",
      256,
    );
    if (
      this.cachedSellerKey !== undefined &&
      this.cachedSellerKey.toLowerCase() !== sellerKey.toLowerCase()
    ) {
      this.clearOrderCaches();
      this.shippedOrdersPendingPullListReconciliation.clear();
      this.refundOptionsCache = undefined;
    }
    this.cachedSellerKey = sellerKey;
    return sellerKey;
  }

  private clearOrderCaches(preservePullList = false): void {
    this.cache.clear();
    this.detailCache.clear();
    if (!preservePullList) this.pullListCache = undefined;
    this.pirateShipCache.clear();
  }
}

function parseProductIdFromPhotoUrl(value: string): number | undefined {
  try {
    const url = new URL(value);
    if (url.hostname.toLocaleLowerCase() !== "product-images.tcgplayer.com") {
      return undefined;
    }
    const match = /\/([1-9]\d{0,15})\.(?:jpe?g|png|webp)$/iu.exec(url.pathname);
    if (match?.[1] === undefined) return undefined;
    const productId = Number(match[1]);
    return Number.isSafeInteger(productId) ? productId : undefined;
  } catch {
    return undefined;
  }
}

function parseProductId(value: string): number | undefined {
  if (!/^[1-9]\d{0,15}$/u.test(value)) return undefined;
  const productId = Number(value);
  return Number.isSafeInteger(productId) ? productId : undefined;
}

function sameStringSet(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  if (actual.length !== expected.length) return false;
  const actualValues = new Set(actual);
  return (
    actualValues.size === actual.length &&
    expected.every((value) => actualValues.has(value))
  );
}

function projectPullListRow(
  row: ManagedPullListRow,
  settings: PullListGroupingSettings,
): ManagedPullListRow {
  const colorGroup = pullListColorGroup(row.attributes, settings);
  return {
    ...row,
    metadata:
      colorGroup.length === 0 ? [] : [{ label: "Color", values: colorGroup }],
    bin: pullListBin(row, settings),
  };
}

function projectMasterPullList(
  list: ManagedMasterPullList,
  settings: PullListGroupingSettings,
): ManagedMasterPullList {
  return {
    ...list,
    rows: list.rows.map((row) => projectPullListRow(row, settings)),
  };
}

function samePullSheetProduct(
  left: Pick<
    PullSheetRow,
    | "productLine"
    | "productName"
    | "condition"
    | "number"
    | "setName"
    | "rarity"
    | "mainPhotoUrl"
    | "setReleaseDate"
  >,
  right: Pick<
    PullSheetRow,
    | "productLine"
    | "productName"
    | "condition"
    | "number"
    | "setName"
    | "rarity"
    | "mainPhotoUrl"
    | "setReleaseDate"
  >,
): boolean {
  return (
    left.productLine === right.productLine &&
    left.productName === right.productName &&
    left.condition === right.condition &&
    left.number === right.number &&
    left.setName === right.setName &&
    left.rarity === right.rarity &&
    left.mainPhotoUrl === right.mainPhotoUrl &&
    left.setReleaseDate === right.setReleaseDate
  );
}

function mergeManagedPullListRows(
  existingRows: readonly ManagedPullListRow[],
  newRows: readonly ManagedPullListRow[],
): readonly ManagedPullListRow[] {
  const rows = new Map(existingRows.map((row) => [row.skuId, row] as const));
  for (const row of newRows) {
    const existing = rows.get(row.skuId);
    if (existing === undefined) {
      rows.set(row.skuId, row);
      continue;
    }
    if (!samePullSheetProduct(existing, row)) {
      throw new ApplicationError(
        "PROVIDER_ERROR",
        "The pull sheet returned conflicting details for one cached SKU.",
      );
    }
    const hasNewAttributes = Object.keys(row.attributes).length > 0;
    rows.set(row.skuId, {
      ...existing,
      ...row,
      orderQuantity: existing.orderQuantity + row.orderQuantity,
      attributes: hasNewAttributes ? row.attributes : existing.attributes,
      metadata: hasNewAttributes ? row.metadata : existing.metadata,
      bin: hasNewAttributes ? row.bin : existing.bin,
      pulledQuantity: 0,
      remainingQuantity: existing.orderQuantity + row.orderQuantity,
      pulled: false,
      canTrackPullProgress: false,
    });
  }
  return [...rows.values()];
}

function retainCachedPullListOrders(
  cached: CachedPullList,
  allowedOrderNumbers: ReadonlySet<string>,
  fetchedAt: string,
): CachedPullList {
  const retainedOrderNumbers = new Set(
    [...cached.orderNumbers].filter((orderNumber) =>
      allowedOrderNumbers.has(orderNumber),
    ),
  );
  const allocationsBySku = new Map<
    string,
    readonly PullSheetOrderAllocation[]
  >();
  for (const [skuId, allocations] of cached.allocationsBySku) {
    if (allocations.length === 0) {
      if (retainedOrderNumbers.size > 0) allocationsBySku.set(skuId, []);
      continue;
    }
    const retained = allocations.filter((allocation) =>
      retainedOrderNumbers.has(allocation.orderNumber),
    );
    if (retained.length > 0) allocationsBySku.set(skuId, retained);
  }
  const rows = cached.value.rows.flatMap((row) => {
    const allocations = allocationsBySku.get(row.skuId);
    if (allocations === undefined) return [];
    if (allocations.length === 0) {
      return [
        {
          ...row,
          pulledQuantity: 0,
          remainingQuantity: row.orderQuantity,
          pulled: false,
          canTrackPullProgress: false,
        },
      ];
    }
    const orderQuantity = allocations.reduce(
      (total, allocation) => total + allocation.quantity,
      0,
    );
    return [
      {
        ...row,
        orderQuantity,
        pulledQuantity: 0,
        remainingQuantity: orderQuantity,
        pulled: false,
        canTrackPullProgress: false,
      },
    ];
  });
  const totalQuantity = rows.reduce(
    (total, row) => total + row.orderQuantity,
    0,
  );
  return {
    ...cached,
    orderNumbers: new Set(retainedOrderNumbers),
    allocationsBySku,
    value: {
      ...cached.value,
      orderCount: retainedOrderNumbers.size,
      rows,
      totalQuantity,
      pulledQuantity: 0,
      remainingQuantity: totalQuantity,
      fetchedAt,
    },
  };
}

function mergePullListAllocationMaps(
  existing: ReadonlyMap<string, readonly PullSheetOrderAllocation[]>,
  additions: ReadonlyMap<string, readonly PullSheetOrderAllocation[]>,
): ReadonlyMap<string, readonly PullSheetOrderAllocation[]> {
  const merged = new Map(existing);
  for (const [skuId, allocations] of additions) {
    const current = merged.get(skuId);
    if (current === undefined) {
      merged.set(skuId, allocations);
      continue;
    }
    const currentOrders = new Set(
      current.map((allocation) => allocation.orderNumber),
    );
    if (
      allocations.some((allocation) =>
        currentOrders.has(allocation.orderNumber),
      )
    ) {
      throw new ApplicationError(
        "PROVIDER_ERROR",
        "The pull sheet repeated an order already held in the active pull list.",
      );
    }
    merged.set(skuId, [...current, ...allocations]);
  }
  return merged;
}

function combinePullListMetadataIssues(
  ...issues: readonly (string | undefined)[]
): string | undefined {
  const distinct = [
    ...new Set(issues.filter((issue): issue is string => issue !== undefined)),
  ];
  return distinct.length === 0 ? undefined : distinct.join(" ");
}

function mergeOrderAllocations(
  left: readonly PullSheetOrderAllocation[],
  right: readonly PullSheetOrderAllocation[],
): readonly PullSheetOrderAllocation[] {
  const quantities = new Map<string, number>();
  for (const allocation of [...left, ...right]) {
    quantities.set(
      allocation.orderNumber,
      (quantities.get(allocation.orderNumber) ?? 0) + allocation.quantity,
    );
  }
  return [...quantities].map(([orderNumber, quantity]) => ({
    orderNumber,
    quantity,
  }));
}

function trackableAllocations(
  orderQuantity: number,
  allocations: readonly PullSheetOrderAllocation[] | undefined,
): allocations is readonly PullSheetOrderAllocation[] {
  return (
    allocations !== undefined &&
    allocations.length > 0 &&
    allocations.reduce(
      (total, allocation) => total + allocation.quantity,
      0,
    ) === orderQuantity
  );
}

function reconcilePullListProgress(
  state: PullListProgressState,
  allocationsBySku: ReadonlyMap<string, readonly PullSheetOrderAllocation[]>,
): { readonly state: PullListProgressState; readonly changed: boolean } {
  const currentLines = new Map<string, Map<string, number>>();
  for (const [skuId, allocations] of allocationsBySku) {
    for (const allocation of allocations) {
      const orderLines =
        currentLines.get(allocation.orderNumber) ?? new Map<string, number>();
      orderLines.set(skuId, (orderLines.get(skuId) ?? 0) + allocation.quantity);
      currentLines.set(allocation.orderNumber, orderLines);
    }
  }

  let changed = false;
  const orders: (readonly [
    string,
    Readonly<Record<string, { quantity: number; pulledAt: string }>>,
  ])[] = [];
  for (const [orderNumber, storedLines] of Object.entries(state.orders)) {
    const allowedLines = currentLines.get(orderNumber);
    if (allowedLines === undefined) {
      changed = true;
      continue;
    }
    const lines: (readonly [string, { quantity: number; pulledAt: string }])[] =
      [];
    for (const [skuId, progress] of Object.entries(storedLines)) {
      const maximum = allowedLines.get(skuId);
      if (maximum === undefined) {
        changed = true;
        continue;
      }
      const quantity = Math.min(progress.quantity, maximum);
      if (quantity !== progress.quantity) changed = true;
      lines.push([skuId, { quantity, pulledAt: progress.pulledAt }]);
    }
    if (lines.length === 0) {
      changed = true;
      continue;
    }
    orders.push([orderNumber, Object.fromEntries(lines)]);
  }
  return {
    state: { version: 1, orders: Object.fromEntries(orders) },
    changed,
  };
}

function applyPullListProgress(
  list: ManagedMasterPullList,
  allocationsBySku: ReadonlyMap<string, readonly PullSheetOrderAllocation[]>,
  progress: PullListProgressState,
): ManagedMasterPullList {
  const rows = list.rows.map((row) => {
    const allocations = allocationsBySku.get(row.skuId);
    const canTrackPullProgress = trackableAllocations(
      row.orderQuantity,
      allocations,
    );
    const pulledQuantity = canTrackPullProgress
      ? allocations.reduce((total, allocation) => {
          const stored =
            progress.orders[allocation.orderNumber]?.[row.skuId]?.quantity ?? 0;
          return total + Math.min(stored, allocation.quantity);
        }, 0)
      : 0;
    const remainingQuantity = row.orderQuantity - pulledQuantity;
    return {
      ...row,
      pulledQuantity,
      remainingQuantity,
      pulled: canTrackPullProgress && remainingQuantity === 0,
      canTrackPullProgress,
    };
  });
  const pulledQuantity = rows.reduce(
    (total, row) => total + row.pulledQuantity,
    0,
  );
  return {
    ...list,
    rows,
    pulledQuantity,
    remainingQuantity: list.totalQuantity - pulledQuantity,
  };
}

function setSkuPullProgress(
  state: PullListProgressState,
  skuId: string,
  allocations: readonly PullSheetOrderAllocation[],
  pulled: boolean,
  pulledAt: string,
): PullListProgressState {
  const orders = new Map<string, Map<string, PulledOrderLineProgress>>(
    Object.entries(state.orders).map(
      ([orderNumber, lines]) =>
        [
          orderNumber,
          new Map<string, PulledOrderLineProgress>(Object.entries(lines)),
        ] as const,
    ),
  );
  for (const allocation of allocations) {
    const lines =
      orders.get(allocation.orderNumber) ??
      new Map<string, PulledOrderLineProgress>();
    if (pulled) {
      lines.set(skuId, { quantity: allocation.quantity, pulledAt });
      orders.set(allocation.orderNumber, lines);
    } else {
      lines.delete(skuId);
      if (lines.size === 0) orders.delete(allocation.orderNumber);
    }
  }
  return {
    version: 1,
    orders: Object.fromEntries(
      [...orders].map(([orderNumber, lines]) => [
        orderNumber,
        Object.fromEntries(lines),
      ]),
    ),
  };
}

function requiredText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximum ||
    containsControlCharacter(normalized)
  ) {
    throw new ApplicationError("CONFIGURATION_ERROR", `${label} is invalid.`);
  }
  return normalized;
}

function toManagedOrderDetail(
  order: SellerOrderDetail,
  fetchedAt: string,
): ManagedOrderDetail {
  return {
    createdAt: order.createdAt,
    status: order.status,
    statusCode: order.statusCode,
    orderChannel: order.orderChannel,
    orderFulfillment: order.orderFulfillment,
    orderNumber: order.orderNumber,
    sellerName: order.sellerName,
    buyerName: order.buyerName,
    paymentType: order.paymentType,
    pickupStatus: order.pickupStatus,
    shippingType: order.shippingType,
    estimatedDeliveryDate: order.estimatedDeliveryDate,
    transaction: order.transaction,
    shippingAddress: order.shippingAddress,
    products: order.products,
    refunds: order.refunds,
    refundStatus: order.refundStatus,
    refundCapabilities: order.refundCapabilities,
    trackingNumbers: order.trackingNumbers,
    canMarkShipped: order.statusCode === SellerOrderStatus.ReadyToShip,
    fetchedAt,
  };
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ApplicationError(
      "CONFIGURATION_ERROR",
      `${label} must be between ${String(minimum)} and ${String(maximum)}.`,
    );
  }
  return value;
}
