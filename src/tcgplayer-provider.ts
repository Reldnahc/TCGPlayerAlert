import {
  createTcgplayerSellerClient,
  type TcgplayerSellerClientOptions,
} from "tcgplayer-private-api";
import type {
  DiscoveredOrder,
  FulfillmentDocument,
  FulfillmentOrder,
  OrderProvider,
} from "./domain.js";
import { ApplicationError } from "./errors.js";

export interface TcgplayerProviderOptions {
  readonly authCookie: string;
  readonly sellerKey: string;
  readonly pageSize: number;
  readonly maximumPages: number;
  readonly timezoneOffsetMinutes: number;
  readonly fetch?: TcgplayerSellerClientOptions["fetch"];
  readonly requestDelayMs?: number;
}

export class TcgplayerOrderProvider implements OrderProvider {
  readonly id = "tcgplayer";
  private readonly client;

  constructor(private readonly options: TcgplayerProviderOptions) {
    this.client = createTcgplayerSellerClient({
      session: { authCookie: options.authCookie },
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.requestDelayMs === undefined
        ? {}
        : { requestDelayMs: options.requestDelayMs }),
    });
  }

  async discoverReadyToShip(
    signal?: AbortSignal,
  ): Promise<readonly DiscoveredOrder[]> {
    const discovered = new Map<string, DiscoveredOrder>();
    let offset = 0;
    for (let page = 0; page < this.options.maximumPages; page += 1) {
      const response = await this.client.searchOrders(
        {
          sellerKey: this.options.sellerKey,
          statuses: ["ReadyToShip"],
          offset,
          limit: this.options.pageSize,
          sort: [{ field: "orderDate", direction: "ascending" }],
        },
        signal === undefined ? undefined : { signal },
      );
      for (const order of response.orders) {
        discovered.set(order.orderNumber, {
          id: order.orderNumber,
          status: order.orderStatus,
        });
      }
      offset += response.orders.length;
      if (offset >= response.totalOrders) return [...discovered.values()];
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

  async confirmOrder(
    orderId: string,
    signal?: AbortSignal,
  ): Promise<FulfillmentOrder> {
    const confirmed = await this.client.confirmOrder(
      { sellerKey: this.options.sellerKey, orderNumber: orderId },
      signal === undefined ? undefined : { signal },
    );
    const { order, summary } = confirmed;
    return {
      provider: this.id,
      id: order.orderNumber,
      placedAt: order.createdAt,
      status: order.status,
      channel: order.orderChannel,
      fulfillment: order.orderFulfillment,
      shippingType: order.shippingType,
      totalAmount: summary.totalAmount,
      buyerPaid: summary.buyerPaid,
      shippingAddress: order.shippingAddress,
      items: order.products.map((product) => ({
        name: product.name,
        quantity: product.quantity,
        unitPrice: product.unitPrice,
      })),
    };
  }

  async getPackingSlip(
    orderId: string,
    signal?: AbortSignal,
  ): Promise<FulfillmentDocument> {
    const document = await this.client.getPackingSlip(
      {
        orderNumber: orderId,
        timezoneOffsetMinutes: this.options.timezoneOffsetMinutes,
      },
      signal === undefined ? undefined : { signal },
    );
    if (
      document.orderNumbers.length !== 1 ||
      document.orderNumbers[0] !== orderId
    ) {
      throw new ApplicationError(
        "PROVIDER_ERROR",
        "The packing-slip result did not identify the confirmed order.",
      );
    }
    return {
      kind: "packing-slip",
      mediaType: "application/pdf",
      fileName: document.fileName,
      bytes: document.bytes,
    };
  }
}
