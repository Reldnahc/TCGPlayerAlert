import { describe, expect, it } from "vitest";
import {
  ConnectionHealthService,
  MarketplaceConnectionRegistry,
  OrderQueryService,
  ProviderAdapterRegistry,
  environmentSecretAccess,
  parseOrderDetail,
  parseOrderPage,
  type ProviderAdapterFactory,
} from "../../src/index.js";

// Copy this file to test/providers/<providerId>-contract.test.ts. Replace the
// synthetic factory and fixtures; keep all data invented and non-sensitive.
const connectionId = "example-main";

function createFactory(): ProviderAdapterFactory {
  throw new Error("Replace with createExampleAdapterFactory(syntheticClient).");
}

describe.skip("example provider adapter contract", () => {
  it("declares the same identity and facets that it creates", () => {
    const factory = createFactory();
    const registry = new MarketplaceConnectionRegistry({
      adapters: new ProviderAdapterRegistry([factory]),
      connections: {
        [connectionId]: {
          providerId: factory.providerId,
          enabled: true,
          label: "Sanitized example account",
          settings: {
            credentialEnv: "EXAMPLE_TEST_CREDENTIAL",
            pageSize: 25,
            maximumPages: 2,
          },
        },
      },
      secrets: environmentSecretAccess({
        EXAMPLE_TEST_CREDENTIAL: "synthetic-not-a-real-secret",
      }),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const connection = registry.require(connectionId);

    expect(connection.descriptor).toMatchObject({
      connectionId,
      providerId: factory.providerId,
      connectionLabel: "Sanitized example account",
    });
    expect(Object.keys(connection.facets).sort()).toEqual(
      // Map property names to MarketplaceFacetId values when a name differs.
      expect.any(Array),
    );
  });

  it("returns validated normalized pages and details with qualified refs", async () => {
    const registry = contractRegistry(createFactory());
    const pageReader = registry.facet(connectionId, "orderPages");
    const detailReader = registry.facet(connectionId, "orderDetails");

    const page = parseOrderPage(
      await pageReader.readOrderPage({ scope: "all", pageSize: 25 }),
    );
    expect(page.orders[0]?.ref.connectionId).toBe(connectionId);
    expect(Number.isSafeInteger(page.orders[0]?.totals.total.minorUnits)).toBe(
      true,
    );

    const remoteId = page.orders[0]?.ref.remoteId;
    if (remoteId === undefined)
      throw new Error("Add a synthetic order fixture.");
    const detail = parseOrderDetail(
      await detailReader.getOrder({ connectionId, remoteId }),
    );
    expect(detail.ref).toEqual({ connectionId, remoteId });
    expect(new Set(detail.lines.map((line) => line.lineKey)).size).toBe(
      detail.lines.length,
    );
  });

  it("works through generic health and query services", async () => {
    const registry = contractRegistry(createFactory());
    const health = new ConnectionHealthService(registry, {
      ttlMilliseconds: 1,
    });
    const queries = new OrderQueryService({
      registry,
      health,
      paging: () => ({ pageSize: 25, maximumPages: 2 }),
    });

    const connectionHealth = await health.check(connectionId, { force: true });
    expect(["connected", "degraded"]).toContain(connectionHealth.state);
    const orders = await queries.listConnection(connectionId, "all");
    expect(Array.isArray(orders)).toBe(true);
  });

  it("sanitizes missing credentials, transport failures, and uncertain mutations", () => {
    // Add assertions for not-configured health, safe ProviderIssue codes, abort
    // propagation, repeated cursors, wrong-connection data, and review-required
    // mutation outcomes. Never assert against a real SDK response or secret.
    expect(true).toBe(true);
  });
});

function contractRegistry(
  factory: ProviderAdapterFactory,
): MarketplaceConnectionRegistry {
  return new MarketplaceConnectionRegistry({
    adapters: new ProviderAdapterRegistry([factory]),
    connections: {
      [connectionId]: {
        providerId: factory.providerId,
        enabled: true,
        label: "Sanitized example account",
        settings: {
          credentialEnv: "EXAMPLE_TEST_CREDENTIAL",
          pageSize: 25,
          maximumPages: 2,
        },
      },
    },
    secrets: environmentSecretAccess({
      EXAMPLE_TEST_CREDENTIAL: "synthetic-not-a-real-secret",
    }),
  });
}
