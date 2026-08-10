import {
  createTcgplayerSellerClient,
  type TcgplayerSellerClient,
  type TcgplayerSellerClientOptions,
} from "tcgplayer-private-api";
import type {
  DiscoveredOrder,
  FulfillmentDocument,
  FulfillmentOrder,
  OrderProvider,
} from "./domain.js";
import { ApplicationError } from "./errors.js";
import {
  resolveSellerKey,
  type SellerKeySource,
} from "./seller-credentials.js";
import {
  TcgplayerReadyOrderSource,
  type ReadyOrderSource,
} from "./ready-orders.js";

export interface TcgplayerProviderOptions {
  readonly client?: TcgplayerSellerClient;
  readonly authCookie?: string;
  readonly session?: TcgplayerSellerClientOptions["session"];
  readonly onAuthenticationRequired?: TcgplayerSellerClientOptions["onAuthenticationRequired"];
  readonly sellerKey: SellerKeySource;
  readonly pageSize: number;
  readonly maximumPages: number;
  readonly timezoneOffsetMinutes: number;
  readonly fetch?: TcgplayerSellerClientOptions["fetch"];
  readonly requestDelayMs?: number;
  readonly readyOrders?: ReadyOrderSource;
}

export class TcgplayerOrderProvider implements OrderProvider {
  readonly id = "tcgplayer";
  private readonly client;
  private readonly readyOrders: ReadyOrderSource;

  constructor(private readonly options: TcgplayerProviderOptions) {
    const session =
      options.session ??
      (options.authCookie === undefined
        ? undefined
        : { authCookie: options.authCookie });
    if (options.client !== undefined) {
      this.client = options.client;
    } else if (session === undefined) {
      throw new ApplicationError(
        "CONFIGURATION_ERROR",
        "A TCGplayer seller session is required.",
      );
    } else {
      this.client = createTcgplayerSellerClient({
        session,
        ...(options.onAuthenticationRequired === undefined
          ? {}
          : { onAuthenticationRequired: options.onAuthenticationRequired }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.requestDelayMs === undefined
          ? {}
          : { requestDelayMs: options.requestDelayMs }),
      });
    }
    this.readyOrders =
      options.readyOrders ??
      new TcgplayerReadyOrderSource({
        client: this.client,
        sellerKey: options.sellerKey,
        pageSize: options.pageSize,
        maximumPages: options.maximumPages,
      });
  }

  async discoverReadyToShip(
    signal?: AbortSignal,
  ): Promise<readonly DiscoveredOrder[]> {
    const snapshot = await this.readyOrders.refresh(signal);
    return [...snapshot.orders]
      .sort((left, right) => left.orderDate.localeCompare(right.orderDate))
      .map((order) => ({ id: order.orderNumber, status: order.status }));
  }

  async confirmOrder(
    orderId: string,
    signal?: AbortSignal,
  ): Promise<FulfillmentOrder> {
    const confirmed = await this.client.confirmOrder(
      {
        sellerKey: resolveSellerKey(this.options.sellerKey),
        orderNumber: orderId,
      },
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
