import type {
  SellerOrderSearchSummary,
  TcgplayerSellerClient,
} from "tcgplayer-private-api";
import { ApplicationError } from "./errors.js";

export type OrderListScope = "all" | "ready-to-ship";
export type ManualPrintActionType =
  "print-address-label" | "print-packing-slip";

export interface ManagedOrderSummary {
  readonly orderNumber: string;
  readonly buyerName: string;
  readonly orderDate: string;
  readonly status: string;
  readonly shippingType: string;
  readonly productAmount: number;
  readonly shippingAmount: number;
  readonly totalAmount: number;
}

export interface ManagedOrderList {
  readonly orders: readonly ManagedOrderSummary[];
  readonly fetchedAt: string;
}

export interface AddTrackingResult {
  readonly orderNumber: string;
  readonly carrier: string;
  readonly outcome: "applied" | "already-applied";
}

export interface PirateShipPreparation {
  readonly url: "https://ship.pirateship.com/ship/single";
  readonly pasteAddress: string;
}

type OrderManagementClient = Pick<
  TcgplayerSellerClient,
  | "searchOrders"
  | "confirmOrder"
  | "getPackingSlip"
  | "detectCarrier"
  | "addOrderTracking"
  | "markOrdersShipped"
>;

export interface OrderManagementServiceOptions {
  readonly client: OrderManagementClient;
  readonly sellerKey: string;
  readonly pageSize: number;
  readonly maximumPages: number;
  readonly timezoneOffsetMinutes: number;
  readonly cacheMilliseconds?: number;
  readonly now?: () => Date;
  readonly executePrint?: (
    orderNumber: string,
    actionType: ManualPrintActionType,
    signal?: AbortSignal,
  ) => Promise<void>;
}

interface CachedOrders {
  readonly expiresAt: number;
  readonly value: ManagedOrderList;
}

interface CachedPirateShipPreparation {
  readonly expiresAt: number;
  readonly value: PirateShipPreparation;
}

export class OrderManagementService {
  private readonly client: OrderManagementClient;
  private readonly sellerKey: string;
  private readonly pageSize: number;
  private readonly maximumPages: number;
  private readonly timezoneOffsetMinutes: number;
  private readonly cacheMilliseconds: number;
  private readonly now: () => Date;
  private readonly executePrint?: OrderManagementServiceOptions["executePrint"];
  private readonly cache = new Map<OrderListScope, CachedOrders>();
  private readonly pirateShipCache = new Map<
    string,
    CachedPirateShipPreparation
  >();

  constructor(options: OrderManagementServiceOptions) {
    this.client = options.client;
    this.sellerKey = requiredText(options.sellerKey, "Seller key", 256);
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
    this.cacheMilliseconds = boundedInteger(
      options.cacheMilliseconds ?? 30_000,
      0,
      3_600_000,
      "Cache duration",
    );
    this.now = options.now ?? (() => new Date());
    this.executePrint = options.executePrint;
  }

  async listOrders(
    scope: OrderListScope,
    options: { readonly force?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<ManagedOrderList> {
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
          sellerKey: this.sellerKey,
          searchRange: "LastThreeMonths",
          ...(scope === "ready-to-ship"
            ? { statuses: ["ReadyToShip" as const] }
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
    const confirmed = await this.client.confirmOrder(
      { sellerKey: this.sellerKey, orderNumber: normalized },
      signal === undefined ? undefined : { signal },
    );
    if (confirmed.order.orderNumber !== normalized) {
      throw new ApplicationError(
        "PROVIDER_ERROR",
        "The confirmed order did not match the requested order.",
      );
    }
    const address = confirmed.order.shippingAddress;
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
    const normalizedOrder = requiredText(orderNumber, "Order number", 128);
    const normalizedTracking = requiredText(
      trackingNumber,
      "Tracking number",
      256,
    );
    this.cache.clear();
    this.pirateShipCache.clear();
    const requestOptions = signal === undefined ? undefined : { signal };
    const { carrier } = await this.client.detectCarrier(
      normalizedTracking,
      requestOptions,
    );
    const result = await this.client.addOrderTracking(
      {
        sellerKey: this.sellerKey,
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
    const normalized = requiredText(orderNumber, "Order number", 128);
    this.cache.clear();
    this.pirateShipCache.clear();
    const result = await this.client.markOrdersShipped(
      { sellerKey: this.sellerKey, orderNumbers: [normalized] },
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
    return { orderNumber: normalized, outcome };
  }
}

function toManagedOrder(order: SellerOrderSearchSummary): ManagedOrderSummary {
  return {
    orderNumber: order.orderNumber,
    buyerName: order.buyerName,
    orderDate: order.orderDate,
    status: order.orderStatus,
    shippingType: order.shippingType,
    productAmount: order.productAmount,
    shippingAmount: order.shippingAmount,
    totalAmount: order.totalAmount,
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
