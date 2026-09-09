import {
  SellerOrderStatus,
  type TcgplayerSellerClient,
} from "tcgplayer-private-api";
import {
  parseOrderPage,
  type OrderDetail,
  type OrderDetailReader,
  type OrderPage,
  type OrderPageQuery,
  type OrderPageReader,
} from "../../marketplaces/contracts.js";
import {
  MarketplaceValidationError,
  parseConnectionId,
  parseProviderOrderRef,
} from "../../marketplaces/identity.js";
import {
  assertTcgplayerOrderConnection,
  normalizeTcgplayerOrderDetail,
  normalizeTcgplayerOrderSummary,
} from "./normalization.js";

type PageClient = Pick<TcgplayerSellerClient, "searchOrders">;
type DetailClient = Pick<TcgplayerSellerClient, "getOrder">;

const CURSOR_PREFIX = "tcgplayer-offset-v1:";

export class TcgplayerOrderPageReader implements OrderPageReader {
  private readonly connectionId: string;

  constructor(
    private readonly client: PageClient,
    connectionId: string,
    private readonly sellerKey: () => string,
  ) {
    this.connectionId = parseConnectionId(connectionId);
  }

  async readOrderPage(
    query: OrderPageQuery,
    signal?: AbortSignal,
  ): Promise<OrderPage> {
    const offset = parseCursor(query.cursor);
    if (
      !Number.isSafeInteger(query.pageSize) ||
      query.pageSize < 1 ||
      query.pageSize > 500
    ) {
      throw new MarketplaceValidationError(
        "The provider page size is invalid.",
      );
    }
    if (
      query.since !== undefined &&
      !Number.isFinite(Date.parse(query.since))
    ) {
      throw new MarketplaceValidationError("The provider lookback is invalid.");
    }
    const result = await this.client.searchOrders(
      {
        sellerKey: requiredSellerKey(this.sellerKey()),
        ...(query.scope === "ready-to-ship"
          ? { statuses: [SellerOrderStatus.ReadyToShip] }
          : { searchRange: "LastThreeMonths" as const }),
        sort: [{ field: "orderDate", direction: "descending" }],
        offset,
        limit: query.pageSize,
      },
      signal === undefined ? undefined : { signal },
    );
    if (
      !Number.isSafeInteger(result.totalOrders) ||
      result.totalOrders < 0 ||
      result.orders.length > query.pageSize
    ) {
      throw new MarketplaceValidationError(
        "TCGplayer returned invalid order pagination metadata.",
      );
    }
    if (
      query.scope === "ready-to-ship" &&
      result.orders.some(
        (order) => order.orderStatusCode !== SellerOrderStatus.ReadyToShip,
      )
    ) {
      throw new MarketplaceValidationError(
        "TCGplayer returned an order outside the requested scope.",
      );
    }
    const nextOffset = offset + result.orders.length;
    return parseOrderPage({
      orders: result.orders.map((order) =>
        normalizeTcgplayerOrderSummary(order, this.connectionId),
      ),
      ...(nextOffset < result.totalOrders
        ? { nextCursor: `${CURSOR_PREFIX}${String(nextOffset)}` }
        : {}),
    });
  }
}

export class TcgplayerOrderDetailReader implements OrderDetailReader {
  private readonly connectionId: string;

  constructor(
    private readonly client: DetailClient,
    connectionId: string,
  ) {
    this.connectionId = parseConnectionId(connectionId);
  }

  async getOrder(
    rawRef: Parameters<OrderDetailReader["getOrder"]>[0],
    signal?: AbortSignal,
  ): Promise<OrderDetail> {
    const ref = parseProviderOrderRef(rawRef);
    assertTcgplayerOrderConnection(this.connectionId, ref.connectionId);
    const order = await this.client.getOrder(
      ref.remoteId,
      signal === undefined ? undefined : { signal },
    );
    if (order.orderNumber !== ref.remoteId) {
      throw new MarketplaceValidationError(
        "TCGplayer returned detail for the wrong order.",
      );
    }
    return normalizeTcgplayerOrderDetail(order, this.connectionId);
  }
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!cursor.startsWith(CURSOR_PREFIX)) {
    throw new MarketplaceValidationError(
      "The provider order cursor is invalid.",
    );
  }
  const value = cursor.slice(CURSOR_PREFIX.length);
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new MarketplaceValidationError(
      "The provider order cursor is invalid.",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new MarketplaceValidationError(
      "The provider order cursor is invalid.",
    );
  }
  return parsed;
}

function requiredSellerKey(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 256 ||
    /\p{Cc}/u.test(normalized)
  ) {
    throw new MarketplaceValidationError(
      "The seller credential is unavailable.",
    );
  }
  return normalized;
}
