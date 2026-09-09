import {
  parseOrderPage,
  type AggregateResult,
  type OrderScope,
  type OrderSummary,
  type ProviderIssue,
} from "./contracts.js";
import type { ConnectionHealthService } from "./health.js";
import { MarketplaceValidationError, orderRefKey } from "./identity.js";
import type { MarketplaceConnectionRegistry } from "./registry.js";

const DEFAULT_QUERY_TTL_MILLISECONDS = 30_000;

export interface OrderPagingSettings {
  readonly pageSize: number;
  readonly maximumPages: number;
}

export function parseOrderPagingSettings(value: unknown): OrderPagingSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OrderQueryContractError("INVALID_ORDER_PAGING_SETTINGS");
  }
  const settings = value as Record<string, unknown>;
  return validatePaging({
    pageSize: Number(settings.pageSize),
    maximumPages: Number(settings.maximumPages),
  });
}

interface CachedOrders {
  readonly orders: readonly OrderSummary[];
  readonly expiresAt: number;
}

class ConnectionUnavailableForQueryError extends Error {
  constructor(
    readonly issueCode: string,
    readonly retryable: boolean,
  ) {
    super("The marketplace connection is unavailable for order queries.");
    this.name = "ConnectionUnavailableForQueryError";
  }
}

class OrderQueryContractError extends Error {
  constructor(readonly issueCode: string) {
    super(issueCode);
    this.name = "OrderQueryContractError";
  }
}

export class AggregateOrderQueryError extends Error {
  readonly code: "NO_ORDER_CONNECTIONS" | "ALL_ORDER_CONNECTIONS_FAILED";
  readonly issues: readonly ProviderIssue[];

  constructor(
    code: AggregateOrderQueryError["code"],
    issues: readonly ProviderIssue[],
  ) {
    super(
      code === "NO_ORDER_CONNECTIONS"
        ? "No enabled marketplace connection supplies order pages."
        : "Every eligible marketplace order connection failed.",
    );
    this.name = "AggregateOrderQueryError";
    this.code = code;
    this.issues = issues;
  }
}

export class OrderQueryService {
  private readonly cache = new Map<string, CachedOrders>();
  private readonly now: () => Date;
  private readonly ttlMilliseconds: number;

  constructor(
    private readonly options: {
      readonly registry: MarketplaceConnectionRegistry;
      readonly health: ConnectionHealthService;
      readonly paging: (connectionId: string) => OrderPagingSettings;
      readonly projectOrder?: (order: OrderSummary) => OrderSummary;
      readonly now?: () => Date;
      readonly ttlMilliseconds?: number;
    },
  ) {
    this.now = options.now ?? (() => new Date());
    this.ttlMilliseconds =
      options.ttlMilliseconds ?? DEFAULT_QUERY_TTL_MILLISECONDS;
    if (
      !Number.isSafeInteger(this.ttlMilliseconds) ||
      this.ttlMilliseconds < 1
    ) {
      throw new MarketplaceValidationError(
        "The order cache duration is invalid.",
      );
    }
  }

  async listOrders(
    scope: OrderScope,
    options: { readonly force?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<AggregateResult<readonly OrderSummary[]>> {
    const eligible = this.options.registry
      .list()
      .filter((connection) => connection.facets.orderPages !== undefined);
    if (eligible.length === 0) {
      throw new AggregateOrderQueryError("NO_ORDER_CONNECTIONS", []);
    }
    const results = await Promise.all(
      eligible.map(async (connection) => {
        const connectionId = connection.descriptor.connectionId;
        try {
          const orders = await this.listConnection(
            connectionId,
            scope,
            options,
          );
          return { connectionId, orders } as const;
        } catch (error) {
          options.signal?.throwIfAborted();
          return {
            connectionId,
            issue: orderQueryIssue(connectionId, error),
          } as const;
        }
      }),
    );
    const successes = results.flatMap((result) =>
      "orders" in result ? [result.orders] : [],
    );
    const issues = results.flatMap((result) =>
      "issue" in result ? [result.issue] : [],
    );
    if (successes.length === 0) {
      throw new AggregateOrderQueryError(
        "ALL_ORDER_CONNECTIONS_FAILED",
        issues,
      );
    }
    const orders = successes
      .flat()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return { data: orders, issues, completedAt: this.now().toISOString() };
  }

  async listConnection(
    connectionId: string,
    scope: OrderScope,
    options: { readonly force?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<readonly OrderSummary[]> {
    const cacheKey = `${connectionId}\u0000${scope}`;
    const cached = this.cache.get(cacheKey);
    if (
      options.force !== true &&
      cached !== undefined &&
      cached.expiresAt > this.now().getTime()
    ) {
      return cached.orders;
    }
    const health = await this.options.health.check(connectionId, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (health.state !== "connected" && health.state !== "degraded") {
      throw new ConnectionUnavailableForQueryError(
        health.issueCode ?? healthIssueCode(health.state),
        health.retryable ?? false,
      );
    }
    const reader = this.options.registry.facet(connectionId, "orderPages");
    const paging = validatePaging(this.options.paging(connectionId));
    const orders: OrderSummary[] = [];
    const refs = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (
      let pageNumber = 1;
      pageNumber <= paging.maximumPages;
      pageNumber += 1
    ) {
      const page = parseOrderPage(
        await reader.readOrderPage(
          {
            scope,
            ...(scope === "all"
              ? { since: threeMonthLookback(this.now()) }
              : {}),
            ...(cursor === undefined ? {} : { cursor }),
            pageSize: paging.pageSize,
          },
          options.signal,
        ),
      );
      for (const order of page.orders) {
        if (order.ref.connectionId !== connectionId) {
          throw new OrderQueryContractError("INVALID_PROVIDER_RESPONSE");
        }
        const key = orderRefKey(order.ref);
        if (refs.has(key)) {
          throw new OrderQueryContractError("DUPLICATE_PROVIDER_ORDER");
        }
        refs.add(key);
        orders.push(this.presentOrder(order));
      }
      if (page.nextCursor === undefined) {
        this.cache.set(cacheKey, {
          orders,
          expiresAt: this.now().getTime() + this.ttlMilliseconds,
        });
        return orders;
      }
      if (page.orders.length === 0) {
        throw new OrderQueryContractError("EMPTY_PROVIDER_PAGE_WITH_CURSOR");
      }
      if (cursors.has(page.nextCursor)) {
        throw new OrderQueryContractError("REPEATED_PROVIDER_CURSOR");
      }
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new OrderQueryContractError("PROVIDER_PAGE_LIMIT_EXCEEDED");
  }

  invalidate(connectionId?: string): void {
    if (connectionId === undefined) {
      this.cache.clear();
      return;
    }
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${connectionId}\u0000`)) this.cache.delete(key);
    }
  }

  presentOrder(order: OrderSummary): OrderSummary {
    const [presented] = parseOrderPage({
      orders: [this.options.projectOrder?.(order) ?? order],
    }).orders;
    if (presented === undefined) {
      throw new OrderQueryContractError("INVALID_ORDER_PROJECTION");
    }
    return presented;
  }
}

function validatePaging(value: OrderPagingSettings): OrderPagingSettings {
  if (
    !Number.isSafeInteger(value.pageSize) ||
    value.pageSize < 1 ||
    value.pageSize > 500 ||
    !Number.isSafeInteger(value.maximumPages) ||
    value.maximumPages < 1 ||
    value.maximumPages > 1_000
  ) {
    throw new OrderQueryContractError("INVALID_ORDER_PAGING_SETTINGS");
  }
  return value;
}

function threeMonthLookback(now: Date): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() - 3;
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const lastDay = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0),
  ).getUTCDate();
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(now.getUTCDate(), lastDay),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  ).toISOString();
}

export function orderQueryIssue(
  connectionId: string,
  error: unknown,
): ProviderIssue {
  if (error instanceof ConnectionUnavailableForQueryError) {
    return {
      connectionId,
      operation: "health",
      code: error.issueCode,
      retryable: error.retryable,
    };
  }
  const code =
    error instanceof OrderQueryContractError
      ? error.issueCode
      : "ORDER_QUERY_FAILED";
  return {
    connectionId,
    operation: "list-orders",
    code,
    retryable: code === "HEALTH_CHECK_FAILED" || code === "ORDER_QUERY_FAILED",
  };
}

function healthIssueCode(state: string): string {
  return `HEALTH_${state.toUpperCase().replaceAll("-", "_")}`;
}
