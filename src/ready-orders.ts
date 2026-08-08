import {
  SellerOrderStatus,
  type SellerOrderSearchSummary,
  type TcgplayerSellerClient,
} from "tcgplayer-private-api";
import { ApplicationError } from "./errors.js";
import {
  resolveSellerKey,
  type SellerKeySource,
} from "./seller-credentials.js";

export interface ManagedOrderSummary {
  readonly orderNumber: string;
  readonly buyerName: string;
  readonly orderDate: string;
  readonly status: string;
  readonly statusCode: SellerOrderSearchSummary["orderStatusCode"];
  readonly canMarkShipped: boolean;
  readonly shippingType: string;
  readonly productAmount: number;
  readonly shippingAmount: number;
  readonly totalAmount: number;
}

export interface ManagedOrderList {
  readonly orders: readonly ManagedOrderSummary[];
  readonly fetchedAt: string;
}

type ReadyOrderClient = Pick<TcgplayerSellerClient, "searchOrders">;

export interface TcgplayerReadyOrderSourceOptions {
  readonly client: ReadyOrderClient;
  readonly sellerKey: SellerKeySource;
  readonly pageSize: number;
  readonly maximumPages: number;
  readonly now?: () => Date;
}

export interface ReadyOrderSource {
  snapshot(): ManagedOrderList | undefined;
  refresh(signal?: AbortSignal): Promise<ManagedOrderList>;
  remove(orderNumber: string): void;
}

/**
 * Holds the current authoritative ready-to-ship response in memory. The
 * fulfillment workflow refreshes it; dashboard reads consume that same
 * snapshot without issuing a second seller search.
 */
export class TcgplayerReadyOrderSource implements ReadyOrderSource {
  private readonly client: ReadyOrderClient;
  private readonly sellerKey: SellerKeySource;
  private readonly pageSize: number;
  private readonly maximumPages: number;
  private readonly now: () => Date;
  private currentSnapshot: ManagedOrderList | undefined;
  private activeRefresh: Promise<ManagedOrderList> | undefined;
  private readonly shipmentRemovalsPendingConfirmation = new Set<string>();

  constructor(options: TcgplayerReadyOrderSourceOptions) {
    this.client = options.client;
    this.sellerKey = options.sellerKey;
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
    this.now = options.now ?? (() => new Date());
  }

  snapshot(): ManagedOrderList | undefined {
    return this.currentSnapshot;
  }

  refresh(signal?: AbortSignal): Promise<ManagedOrderList> {
    if (this.activeRefresh !== undefined) return this.activeRefresh;
    const refresh = this.fetchAll(signal);
    this.activeRefresh = refresh;
    const clear = () => {
      if (this.activeRefresh === refresh) this.activeRefresh = undefined;
    };
    void refresh.then(clear, clear);
    return refresh;
  }

  remove(orderNumber: string): void {
    this.shipmentRemovalsPendingConfirmation.add(orderNumber);
    if (this.currentSnapshot === undefined) return;
    const orders = this.currentSnapshot.orders.filter(
      (order) => order.orderNumber !== orderNumber,
    );
    if (orders.length === this.currentSnapshot.orders.length) return;
    this.currentSnapshot = { ...this.currentSnapshot, orders };
  }

  private async fetchAll(signal?: AbortSignal): Promise<ManagedOrderList> {
    const sellerKey = requiredText(
      resolveSellerKey(this.sellerKey),
      "Seller key",
      256,
    );
    const fetchedAt = this.now().toISOString();
    const orders = new Map<string, ManagedOrderSummary>();
    let offset = 0;
    for (let page = 0; page < this.maximumPages; page += 1) {
      const response = await this.client.searchOrders(
        {
          sellerKey,
          statuses: [SellerOrderStatus.ReadyToShip],
          sort: [{ field: "orderDate", direction: "descending" }],
          offset,
          limit: this.pageSize,
        },
        signal === undefined ? undefined : { signal },
      );
      for (const order of response.orders) {
        if (order.orderStatusCode !== SellerOrderStatus.ReadyToShip) {
          throw new ApplicationError(
            "PROVIDER_ERROR",
            "TCGplayer returned a non-ready order in the ready-to-ship queue.",
          );
        }
        orders.set(order.orderNumber, toManagedOrder(order));
      }
      offset += response.orders.length;
      if (offset >= response.totalOrders) {
        for (const orderNumber of this.shipmentRemovalsPendingConfirmation) {
          if (orders.has(orderNumber)) orders.delete(orderNumber);
          else this.shipmentRemovalsPendingConfirmation.delete(orderNumber);
        }
        const snapshot = { orders: [...orders.values()], fetchedAt };
        this.currentSnapshot = snapshot;
        return snapshot;
      }
      if (response.orders.length === 0) {
        throw new ApplicationError(
          "PROVIDER_ERROR",
          "TCGplayer pagination ended before the reported order total.",
          { retryable: true },
        );
      }
    }
    throw new ApplicationError(
      "PROVIDER_ERROR",
      "TCGplayer order discovery exceeded the configured page limit.",
    );
  }
}

export function toManagedOrder(
  order: SellerOrderSearchSummary,
): ManagedOrderSummary {
  return {
    orderNumber: order.orderNumber,
    buyerName: order.buyerName,
    orderDate: order.orderDate,
    status: order.orderStatus,
    statusCode: order.orderStatusCode,
    canMarkShipped: order.orderStatusCode === SellerOrderStatus.ReadyToShip,
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
