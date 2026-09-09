import type { ManaPoolSellerClient } from "manapool-seller-api";
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
  assertManaPoolConnection,
  normalizeManaPoolOrderDetail,
  normalizeManaPoolOrderSummary,
} from "./normalization.js";

type OrderClient = Pick<
  ManaPoolSellerClient,
  "listSellerOrders" | "getSellerOrder"
>;

const CURSOR_PREFIX = "manapool-cursor-v1:";

export class ManaPoolOrderPageReader implements OrderPageReader {
  private readonly connectionId: string;

  constructor(
    private readonly client: OrderClient,
    connectionId: string,
    private readonly detailConcurrency: number,
  ) {
    this.connectionId = parseConnectionId(connectionId);
    if (
      !Number.isSafeInteger(detailConcurrency) ||
      detailConcurrency < 1 ||
      detailConcurrency > 20
    ) {
      throw new MarketplaceValidationError(
        "The ManaPool detail concurrency is invalid.",
      );
    }
  }

  async readOrderPage(
    query: OrderPageQuery,
    signal?: AbortSignal,
  ): Promise<OrderPage> {
    if (
      !Number.isSafeInteger(query.pageSize) ||
      query.pageSize < 1 ||
      query.pageSize > 500
    ) {
      throw new MarketplaceValidationError(
        "The provider page size is invalid.",
      );
    }
    const cursor = decodeCursor(query.cursor);
    const response = await this.client.listSellerOrders(
      {
        ...(query.scope === "ready-to-ship" ? { needsShipping: true } : {}),
        ...(query.scope === "all" && query.since !== undefined
          ? { since: query.since }
          : {}),
        limit: query.pageSize,
        ...(cursor === undefined ? {} : { cursor }),
      },
      signal === undefined ? undefined : { signal },
    );
    if (response.orders.length > query.pageSize) {
      throw new MarketplaceValidationError(
        "ManaPool returned too many orders for one page.",
      );
    }
    const details = await mapConcurrent(
      response.orders,
      this.detailConcurrency,
      (summary) =>
        this.client.getSellerOrder(
          summary.id,
          signal === undefined ? undefined : { signal },
        ),
    );
    return parseOrderPage({
      orders: response.orders.map((summary, index) => {
        const detail = details[index];
        if (detail === undefined) {
          throw new MarketplaceValidationError(
            "ManaPool order detail paging became inconsistent.",
          );
        }
        return normalizeManaPoolOrderSummary(
          summary,
          detail,
          this.connectionId,
        );
      }),
      ...(response.pagination.nextCursor === null
        ? {}
        : { nextCursor: encodeCursor(response.pagination.nextCursor) }),
    });
  }
}

export class ManaPoolOrderDetailReader implements OrderDetailReader {
  private readonly connectionId: string;

  constructor(
    private readonly client: Pick<ManaPoolSellerClient, "getSellerOrder">,
    connectionId: string,
  ) {
    this.connectionId = parseConnectionId(connectionId);
  }

  async getOrder(
    rawRef: Parameters<OrderDetailReader["getOrder"]>[0],
    signal?: AbortSignal,
  ): Promise<OrderDetail> {
    const ref = parseProviderOrderRef(rawRef);
    assertManaPoolConnection(this.connectionId, ref.connectionId);
    const detail = await this.client.getSellerOrder(
      ref.remoteId,
      signal === undefined ? undefined : { signal },
    );
    if (detail.id !== ref.remoteId) {
      throw new MarketplaceValidationError(
        "ManaPool returned detail for the wrong order.",
      );
    }
    return normalizeManaPoolOrderDetail(detail, this.connectionId);
  }
}

function encodeCursor(value: string): string {
  if (
    value.length === 0 ||
    Array.from(value).length > 384 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new MarketplaceValidationError(
      "ManaPool returned an invalid pagination cursor.",
    );
  }
  return `${CURSOR_PREFIX}${encodeURIComponent(value)}`;
}

function decodeCursor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!value.startsWith(CURSOR_PREFIX)) {
    throw new MarketplaceValidationError(
      "The provider order cursor is invalid.",
    );
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value.slice(CURSOR_PREFIX.length));
  } catch {
    throw new MarketplaceValidationError(
      "The provider order cursor is invalid.",
    );
  }
  if (encodeCursor(decoded) !== value) {
    throw new MarketplaceValidationError(
      "The provider order cursor is invalid.",
    );
  }
  return decoded;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  transform: (value: T) => Promise<R>,
): Promise<readonly R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await transform(value);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker),
  );
  return results;
}
