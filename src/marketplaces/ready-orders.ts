import {
  MarketplaceValidationError,
  orderRefKey,
  parseProviderOrderRef,
} from "./identity.js";
import { AggregateOrderQueryError, orderQueryIssue } from "./order-query.js";
import type { OrderQueryService } from "./order-query.js";
import type { MarketplaceConnectionRegistry } from "./registry.js";
import type {
  QualifiedReadyOrderSnapshot,
  QualifiedReadyOrderSource,
} from "../shipment-scanner.js";

export class MarketplaceReadyOrderSource implements QualifiedReadyOrderSource {
  private current: QualifiedReadyOrderSnapshot | undefined;

  constructor(
    private readonly options: {
      readonly registry: MarketplaceConnectionRegistry;
      readonly orders: OrderQueryService;
      readonly concurrency: () => number | Promise<number>;
      readonly now?: () => Date;
    },
  ) {}

  snapshot(): QualifiedReadyOrderSnapshot | undefined {
    return this.current === undefined
      ? undefined
      : structuredClone(this.current);
  }

  async refresh(signal?: AbortSignal): Promise<QualifiedReadyOrderSnapshot> {
    const eligible = this.options.registry
      .list()
      .filter((connection) => connection.facets.orderPages !== undefined);
    if (eligible.length === 0) {
      throw new AggregateOrderQueryError("NO_ORDER_CONNECTIONS", []);
    }
    const concurrency = await this.options.concurrency();
    if (
      !Number.isSafeInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 8
    ) {
      throw new MarketplaceValidationError(
        "Synchronization concurrency must be an integer from 1 through 8.",
      );
    }
    const results = await mapConcurrent(
      eligible,
      concurrency,
      async (connection) => {
        const connectionId = connection.descriptor.connectionId;
        try {
          const orders = await this.options.orders.listConnection(
            connectionId,
            "ready-to-ship",
            { force: true, ...(signal === undefined ? {} : { signal }) },
          );
          return { connectionId, orders } as const;
        } catch (error) {
          signal?.throwIfAborted();
          return {
            connectionId,
            issue: orderQueryIssue(connectionId, error),
          } as const;
        }
      },
    );
    const successful = results.filter(
      (
        result,
      ): result is Extract<(typeof results)[number], { orders: unknown }> =>
        "orders" in result,
    );
    const issues = results.flatMap((result) =>
      "issue" in result ? [result.issue] : [],
    );
    if (successful.length === 0) {
      throw new AggregateOrderQueryError(
        "ALL_ORDER_CONNECTIONS_FAILED",
        issues,
      );
    }
    const snapshot: QualifiedReadyOrderSnapshot = {
      orders: successful
        .flatMap((result) => result.orders)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      successfulConnectionIds: successful
        .map((result) => result.connectionId)
        .sort(),
      issues,
      fetchedAt: (this.options.now ?? (() => new Date()))().toISOString(),
    };
    this.current = snapshot;
    return structuredClone(snapshot);
  }

  remove(value: Parameters<typeof parseProviderOrderRef>[0]): void {
    const ref = parseProviderOrderRef(value);
    if (this.current === undefined) return;
    const key = orderRefKey(ref);
    this.current = {
      ...this.current,
      orders: this.current.orders.filter(
        (order) => orderRefKey(order.ref) !== key,
      ),
    };
  }
}

async function mapConcurrent<T, U>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<U>,
): Promise<readonly U[]> {
  const results = new Array<U>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(values.length, concurrency) }, async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        const value = values[index];
        if (value !== undefined) results[index] = await operation(value);
      }
    }),
  );
  return results;
}
