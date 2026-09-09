import { describe, expect, it } from "vitest";
import { ConnectionHealthService } from "../src/marketplaces/health.js";
import {
  AggregateOrderQueryError,
  OrderQueryService,
} from "../src/marketplaces/order-query.js";
import {
  MarketplaceConnectionRegistry,
  ProviderAdapterRegistry,
  environmentSecretAccess,
  type ProviderAdapterFactory,
} from "../src/marketplaces/registry.js";
import {
  syntheticFactory,
  syntheticNormalizedOrder,
} from "./synthetic-marketplace.js";

const fixedNow = new Date("2026-08-31T12:34:56.789Z");

describe("generic marketplace order query", () => {
  it("walks pages sequentially and preserves duplicate display labels across connections", async () => {
    const sharedLabel = "SHARED-DISPLAY-100";
    const first = syntheticFactory("first-provider", "First Provider", {
      pages: {
        first: {
          orders: [
            syntheticNormalizedOrder({
              connectionId: "first-main",
              remoteId: "remote-a",
              displayOrderNumber: sharedLabel,
              createdAt: "2026-08-30T12:00:00.000Z",
            }),
          ],
          nextCursor: "second-page",
        },
        "second-page": {
          orders: [
            syntheticNormalizedOrder({
              connectionId: "first-main",
              remoteId: "remote-b",
              createdAt: "2026-08-29T12:00:00.000Z",
            }),
          ],
        },
      },
    });
    const second = syntheticFactory("second-provider", "Second Provider", {
      pages: {
        first: {
          orders: [
            syntheticNormalizedOrder({
              connectionId: "second-main",
              remoteId: "remote-a",
              displayOrderNumber: sharedLabel,
              createdAt: "2026-08-31T12:00:00.000Z",
            }),
          ],
        },
      },
    });
    const query = queryService([first.factory, second.factory]);

    const result = await query.listOrders("all");

    expect(result.data).toHaveLength(3);
    expect(
      result.data.filter((order) => order.displayOrderNumber === sharedLabel),
    ).toHaveLength(2);
    expect(result.data.map((order) => order.ref.connectionId)).toEqual([
      "second-main",
      "first-main",
      "first-main",
    ]);
    expect(
      first.observation.orderQueries.map((request) => request.cursor),
    ).toEqual([undefined, "second-page"]);
    expect(first.observation.orderQueries[0]?.since).toBe(
      "2026-05-31T12:34:56.789Z",
    );
  });

  it("does not add a lookback to ready queries and caches complete results", async () => {
    const failure = { enabled: false };
    const provider = syntheticFactory("cache-provider", "Cache Provider", {
      orderFailure: failure,
      pages: { first: { orders: [] } },
    });
    const query = queryService([provider.factory]);

    await query.listOrders("ready-to-ship");
    await query.listOrders("ready-to-ship");
    expect(provider.observation.orderQueries).toHaveLength(1);
    expect(provider.observation.orderQueries[0]?.since).toBeUndefined();

    failure.enabled = true;
    await expect(
      query.listOrders("ready-to-ship", { force: true }),
    ).rejects.toMatchObject({ code: "ALL_ORDER_CONNECTIONS_FAILED" });
    failure.enabled = false;
    await query.listOrders("ready-to-ship");
    expect(provider.observation.orderQueries).toHaveLength(2);
  });

  it("returns successful data with a safe issue when another connection fails", async () => {
    const healthy = syntheticFactory("healthy-provider", "Healthy Provider", {
      pages: {
        first: {
          orders: [
            syntheticNormalizedOrder({
              connectionId: "healthy-main",
              remoteId: "healthy-order",
            }),
          ],
        },
      },
    });
    const failing = syntheticFactory("failing-provider", "Failing Provider", {
      failOrders: true,
    });
    const query = queryService([healthy.factory, failing.factory]);

    const result = await query.listOrders("all");

    expect(result.data).toHaveLength(1);
    expect(result.issues).toEqual([
      {
        connectionId: "failing-main",
        operation: "list-orders",
        code: "ORDER_QUERY_FAILED",
        retryable: true,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("private order detail");
  });

  it("fails the aggregate safely when all eligible connections fail", async () => {
    const failing = syntheticFactory("failing-provider", "Failing Provider", {
      failOrders: true,
    });
    const query = queryService([failing.factory]);

    await expect(query.listOrders("all")).rejects.toMatchObject({
      code: "ALL_ORDER_CONNECTIONS_FAILED",
      issues: [{ connectionId: "failing-main", code: "ORDER_QUERY_FAILED" }],
    });
  });

  it.each([
    {
      name: "mismatched connection",
      pages: {
        first: {
          orders: [
            syntheticNormalizedOrder({
              connectionId: "wrong-main",
              remoteId: "remote-a",
            }),
          ],
        },
      },
      code: "INVALID_PROVIDER_RESPONSE",
      maximumPages: 10,
    },
    {
      name: "duplicate qualified order",
      pages: {
        first: {
          orders: [
            syntheticNormalizedOrder({
              connectionId: "broken-main",
              remoteId: "remote-a",
            }),
          ],
          nextCursor: "next",
        },
        next: {
          orders: [
            syntheticNormalizedOrder({
              connectionId: "broken-main",
              remoteId: "remote-a",
            }),
          ],
        },
      },
      code: "DUPLICATE_PROVIDER_ORDER",
      maximumPages: 10,
    },
    {
      name: "empty continuation page",
      pages: { first: { orders: [], nextCursor: "next" } },
      code: "EMPTY_PROVIDER_PAGE_WITH_CURSOR",
      maximumPages: 10,
    },
    {
      name: "repeated cursor",
      pages: {
        first: {
          orders: [
            syntheticNormalizedOrder({
              connectionId: "broken-main",
              remoteId: "remote-a",
            }),
          ],
          nextCursor: "same",
        },
        same: {
          orders: [
            syntheticNormalizedOrder({
              connectionId: "broken-main",
              remoteId: "remote-b",
            }),
          ],
          nextCursor: "same",
        },
      },
      code: "REPEATED_PROVIDER_CURSOR",
      maximumPages: 10,
    },
    {
      name: "page limit",
      pages: {
        first: {
          orders: [
            syntheticNormalizedOrder({
              connectionId: "broken-main",
              remoteId: "remote-a",
            }),
          ],
          nextCursor: "next",
        },
      },
      code: "PROVIDER_PAGE_LIMIT_EXCEEDED",
      maximumPages: 1,
    },
  ])("rejects $name", async ({ pages, code, maximumPages }) => {
    const broken = syntheticFactory("broken-provider", "Broken Provider", {
      pages,
    });
    const query = queryService([broken.factory], maximumPages);

    await expect(query.listConnection("broken-main", "all")).rejects.toThrow(
      code,
    );
  });

  it("reports no eligible order connection distinctly", async () => {
    const registry = new MarketplaceConnectionRegistry({
      adapters: new ProviderAdapterRegistry([]),
      connections: {},
      secrets: environmentSecretAccess({}),
    });
    const query = new OrderQueryService({
      registry,
      health: new ConnectionHealthService(registry),
      paging: () => ({ pageSize: 100, maximumPages: 10 }),
    });

    await expect(query.listOrders("all")).rejects.toBeInstanceOf(
      AggregateOrderQueryError,
    );
    await expect(query.listOrders("all")).rejects.toMatchObject({
      code: "NO_ORDER_CONNECTIONS",
      issues: [],
    });
  });

  it("does not call order pages when connection health requires authentication", async () => {
    const provider = syntheticFactory("auth-provider", "Auth Provider", {
      health: {
        state: "authentication-required",
        issueCode: "AUTHENTICATION_REQUIRED",
        retryable: false,
      },
    });
    const query = queryService([provider.factory]);

    await expect(query.listOrders("all")).rejects.toMatchObject({
      code: "ALL_ORDER_CONNECTIONS_FAILED",
      issues: [
        {
          connectionId: "auth-main",
          operation: "health",
          code: "AUTHENTICATION_REQUIRED",
          retryable: false,
        },
      ],
    });
    expect(provider.observation.orderQueries).toHaveLength(0);
  });
});

function queryService(
  factories: readonly ProviderAdapterFactory[],
  maximumPages = 10,
): OrderQueryService {
  const adapters = new ProviderAdapterRegistry(factories);
  const connections = Object.fromEntries(
    factories.map((factory) => [
      `${factory.providerId.replace("-provider", "")}-main`,
      {
        providerId: factory.providerId,
        enabled: true,
        label: `${factory.providerLabel} store`,
        settings: {},
      },
    ]),
  );
  const registry = new MarketplaceConnectionRegistry({
    adapters,
    connections,
    secrets: environmentSecretAccess({}),
    now: () => fixedNow,
  });
  return new OrderQueryService({
    registry,
    health: new ConnectionHealthService(registry, { now: () => fixedNow }),
    paging: () => ({ pageSize: 2, maximumPages }),
    now: () => fixedNow,
  });
}
