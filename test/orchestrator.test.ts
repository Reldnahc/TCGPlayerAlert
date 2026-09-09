import { describe, expect, it } from "vitest";
import {
  ApplicationError,
  ConnectionHealthService,
  environmentSecretAccess,
  FulfillmentWorkflow,
  emptyLocalInventoryState,
  LocalInventoryService,
  MarketplaceConnectionRegistry,
  MarketplaceReadyOrderSource,
  OrderDocumentService,
  OrderQueryService,
  ProviderAdapterRegistry,
  type RuleConfig,
  type LocalInventoryState,
} from "../src/index.js";
import { orderRefKey } from "../src/marketplaces/identity.js";
import {
  appConfig,
  FakeAction,
  MemoryStateStore,
  silentLogger,
} from "./fixtures.js";
import { marketplaceOrderDetail } from "./marketplace-ui-fixtures.js";
import {
  syntheticFactory,
  syntheticNormalizedOrder,
} from "./synthetic-marketplace.js";

const NOW = new Date("2026-01-02T03:04:05.000Z");
const defaultRule: RuleConfig = {
  id: "default",
  enabled: true,
  when: { all: [] },
  actions: ["label", "packing-slip"],
};

function workflowFixture(
  connectionIds = ["first-main"],
  localInventory?: Pick<LocalInventoryService, "deductSale">,
) {
  const pages = Object.fromEntries(
    connectionIds.map((connectionId) => [connectionId, { orders: [] }]),
  ) as Record<
    string,
    { orders: ReturnType<typeof syntheticNormalizedOrder>[] }
  >;
  const factories = connectionIds.map((connectionId) => {
    const providerId = connectionId.replace(/-main$/u, "-provider");
    const baseOrder = marketplaceOrderDetail({
      connectionId,
      remoteId: "DUPLICATE",
    });
    const order = {
      ...baseOrder,
      lines: baseOrder.lines.map((line) => ({
        ...line,
        catalogIdentities: [
          {
            namespace: "tcgplayer.sku",
            value: "456",
            precision: "exact-variant" as const,
          },
        ],
      })),
    };
    return syntheticFactory(providerId, providerId, {
      pages: new Proxy(
        {},
        {
          get: (_target, property) =>
            property === "first" ? pages[connectionId] : undefined,
        },
      ),
      detail: order,
    });
  });
  const registry = new MarketplaceConnectionRegistry({
    adapters: new ProviderAdapterRegistry(
      factories.map((entry) => entry.factory),
    ),
    connections: Object.fromEntries(
      connectionIds.map((connectionId, index) => [
        connectionId,
        {
          providerId: factories[index]?.factory.providerId ?? "missing",
          enabled: true,
          label: connectionId,
          settings: {},
        },
      ]),
    ),
    secrets: environmentSecretAccess({}),
    now: () => NOW,
  });
  const orders = new OrderQueryService({
    registry,
    health: new ConnectionHealthService(registry, { now: () => NOW }),
    paging: () => ({ pageSize: 100, maximumPages: 10 }),
    now: () => NOW,
  });
  const readyOrders = new MarketplaceReadyOrderSource({
    registry,
    orders,
    concurrency: () => 2,
    now: () => NOW,
  });
  const stateStore = new MemoryStateStore();
  const label = new FakeAction("label", false);
  const packingSlip = new FakeAction("packing-slip", true);
  const workflow = new FulfillmentWorkflow({
    config: appConfig({ rules: [defaultRule] }),
    registry,
    readyOrders,
    stateStore,
    actions: { label, "packing-slip": packingSlip },
    documents: new OrderDocumentService(registry),
    ...(localInventory === undefined ? {} : { localInventory }),
    logger: silentLogger,
    now: () => NOW,
    createId: () => "synthetic-correlation",
  });
  return {
    workflow,
    pages,
    factories,
    stateStore,
    label,
    packingSlip,
  };
}

function memoryLocalInventory(): LocalInventoryService {
  let state: LocalInventoryState = emptyLocalInventoryState();
  return new LocalInventoryService(
    {
      load: () => Promise.resolve(structuredClone(state)),
      save: (candidate) => {
        state = structuredClone(candidate);
        return Promise.resolve();
      },
    },
    {
      now: () => NOW,
      id: () => "00000000-0000-4000-8000-000000000001",
    },
  );
}

function addReady(
  fixture: ReturnType<typeof workflowFixture>,
  connectionId: string,
  remoteId = "DUPLICATE",
) {
  const page = fixture.pages[connectionId];
  if (page === undefined) throw new Error("Missing synthetic page.");
  page.orders = [syntheticNormalizedOrder({ connectionId, remoteId })];
}

describe("provider-neutral fulfillment workflow", () => {
  it("establishes independent first-run baselines without confirming or acting", async () => {
    const fixture = workflowFixture(["first-main", "second-main"]);
    addReady(fixture, "first-main");
    addReady(fixture, "second-main");

    const result = await fixture.workflow.run("manual");

    expect(result).toMatchObject({
      outcome: "succeeded",
      baselineEstablished: true,
      discoveredCount: 2,
      processedCount: 0,
    });
    expect(fixture.label.calls).toBe(0);
    expect(fixture.stateStore.state.baselines).toEqual({
      "first-main": NOW.toISOString(),
      "second-main": NOW.toISOString(),
    });
    expect(
      fixture.stateStore.state.orders["first-main/DUPLICATE"]?.workflowStatus,
    ).toBe("baseline");
    expect(
      fixture.stateStore.state.orders["second-main/DUPLICATE"]?.workflowStatus,
    ).toBe("baseline");
  });

  it("prints each qualified order once with collision-safe idempotency keys", async () => {
    const fixture = workflowFixture(["first-main", "second-main"]);
    await fixture.workflow.run("manual");
    addReady(fixture, "first-main");
    addReady(fixture, "second-main");

    await fixture.workflow.run("scheduled");
    await fixture.workflow.run("manual");

    expect(fixture.label.calls).toBe(2);
    expect(fixture.packingSlip.calls).toBe(2);
    expect(new Set(fixture.label.idempotencyKeys)).toEqual(
      new Set(["first-main/DUPLICATE:label", "second-main/DUPLICATE:label"]),
    );
    expect(JSON.stringify(fixture.stateStore.state)).not.toContain(
      "Synthetic Buyer",
    );
  });

  it("does not deduct baseline orders and deducts each later confirmed sale exactly once", async () => {
    const localInventory = memoryLocalInventory();
    await localInventory.add({
      displayName: "Synthetic Card",
      quantity: 5,
      catalogIdentities: [
        {
          namespace: "tcgplayer.sku",
          value: "456",
          precision: "exact-variant",
        },
      ],
      attributes: {},
    });
    const fixture = workflowFixture(["first-main"], localInventory);
    addReady(fixture, "first-main", "BASELINE");

    await fixture.workflow.run("manual");
    expect((await localInventory.snapshot()).items[0]?.onHand).toBe(5);

    addReady(fixture, "first-main", "NEW-SALE");
    await fixture.workflow.run("scheduled");
    await fixture.workflow.run("manual");

    expect((await localInventory.snapshot()).items[0]?.onHand).toBe(3);
    expect(fixture.label.calls).toBe(1);
  });

  it("does not run order actions until a failed local deduction succeeds", async () => {
    let attempts = 0;
    const fixture = workflowFixture(["first-main"], {
      deductSale: () => {
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(
            new Error("synthetic local persistence failure"),
          );
        }
        return Promise.resolve({ outcome: "tracking-disabled" });
      },
    });
    await fixture.workflow.run("manual");
    addReady(fixture, "first-main", "NEW-SALE");

    const failed = await fixture.workflow.run("scheduled");
    expect(failed).toMatchObject({
      outcome: "partial",
      issues: [
        {
          connectionId: "first-main",
          operation: "local-inventory",
          code: "LOCAL_INVENTORY_DEDUCTION_FAILED",
          retryable: true,
        },
      ],
    });
    expect(fixture.label.calls).toBe(0);

    await fixture.workflow.run("manual");
    expect(attempts).toBe(2);
    expect(fixture.label.calls).toBe(1);
  });

  it("quarantines an ambiguous print and never submits it again", async () => {
    const fixture = workflowFixture();
    fixture.label.error = new ApplicationError(
      "PRINT_AMBIGUOUS",
      "Synthetic ambiguous print.",
    );
    await fixture.workflow.run("manual");
    addReady(fixture, "first-main");

    await fixture.workflow.run("scheduled");
    await fixture.workflow.run("manual");

    expect(fixture.label.calls).toBe(1);
    expect(
      fixture.stateStore.state.orders["first-main/DUPLICATE"]?.workflowStatus,
    ).toBe("review-required");
  });

  it("processes an initial connection queue only with explicit backlog opt-in", async () => {
    const fixture = workflowFixture();
    addReady(fixture, "first-main");

    const result = await fixture.workflow.run("manual", {
      processBacklog: true,
    });

    expect(result.baselineEstablished).toBe(false);
    expect(result.processedCount).toBe(1);
    expect(fixture.label.calls).toBe(1);
  });

  it("coalesces overlapping synchronization requests", async () => {
    const fixture = workflowFixture();
    const connection = fixture.workflow.run("scheduled");
    const second = fixture.workflow.run("manual");
    expect(second).toBe(connection);
    await expect(connection).resolves.toMatchObject({ outcome: "succeeded" });
  });

  it("records a partial run without advancing the failed connection baseline", async () => {
    const healthy = syntheticFactory("healthy-provider", "Healthy", {
      pages: {
        first: {
          orders: [
            syntheticNormalizedOrder({
              connectionId: "healthy-main",
              remoteId: "HEALTHY",
            }),
          ],
        },
      },
      detail: marketplaceOrderDetail({
        connectionId: "healthy-main",
        remoteId: "HEALTHY",
      }),
    });
    const failed = syntheticFactory("failed-provider", "Failed", {
      failOrders: true,
    });
    const registry = new MarketplaceConnectionRegistry({
      adapters: new ProviderAdapterRegistry([healthy.factory, failed.factory]),
      connections: {
        "healthy-main": {
          providerId: "healthy-provider",
          enabled: true,
          label: "Healthy",
          settings: {},
        },
        "failed-main": {
          providerId: "failed-provider",
          enabled: true,
          label: "Failed",
          settings: {},
        },
      },
      secrets: environmentSecretAccess({}),
      now: () => NOW,
    });
    const orders = new OrderQueryService({
      registry,
      health: new ConnectionHealthService(registry, { now: () => NOW }),
      paging: () => ({ pageSize: 100, maximumPages: 10 }),
      now: () => NOW,
    });
    const stateStore = new MemoryStateStore();
    const workflow = new FulfillmentWorkflow({
      config: appConfig({ rules: [] }),
      registry,
      readyOrders: new MarketplaceReadyOrderSource({
        registry,
        orders,
        concurrency: () => 2,
        now: () => NOW,
      }),
      stateStore,
      actions: {},
      documents: new OrderDocumentService(registry),
      logger: silentLogger,
      now: () => NOW,
      createId: () => "partial",
    });

    const result = await workflow.run("scheduled");

    expect(result.outcome).toBe("partial");
    expect(result.issues).toEqual([
      expect.objectContaining({ connectionId: "failed-main" }),
    ]);
    expect(stateStore.state.baselines).toEqual({
      "healthy-main": NOW.toISOString(),
    });
    expect(stateStore.state.lastSync?.connections).toMatchObject({
      "healthy-main": { outcome: "succeeded" },
      "failed-main": { outcome: "failed" },
    });
  });

  it("does not accept a partial page or advance its checkpoint when a connection fails mid-pagination", async () => {
    const previousBaseline = "2026-01-01T00:00:00.000Z";
    const healthy = syntheticFactory("healthy-provider", "Healthy", {
      pages: { first: { orders: [] } },
    });
    const failed = syntheticFactory("failed-provider", "Failed", {
      readOrderPage: (query) =>
        query.cursor === undefined
          ? Promise.resolve({
              orders: [
                syntheticNormalizedOrder({
                  connectionId: "failed-main",
                  remoteId: "MUST-NOT-COMMIT",
                }),
              ],
              nextCursor: "second",
            })
          : Promise.reject(new Error("private mid-page failure")),
    });
    const registry = new MarketplaceConnectionRegistry({
      adapters: new ProviderAdapterRegistry([healthy.factory, failed.factory]),
      connections: {
        "healthy-main": {
          providerId: "healthy-provider",
          enabled: true,
          label: "Healthy",
          settings: {},
        },
        "failed-main": {
          providerId: "failed-provider",
          enabled: true,
          label: "Failed",
          settings: {},
        },
      },
      secrets: environmentSecretAccess({}),
      now: () => NOW,
    });
    const orders = new OrderQueryService({
      registry,
      health: new ConnectionHealthService(registry, { now: () => NOW }),
      paging: () => ({ pageSize: 100, maximumPages: 10 }),
      now: () => NOW,
    });
    const stateStore = new MemoryStateStore();
    stateStore.state = {
      version: 2,
      baselines: { "failed-main": previousBaseline },
      orders: {},
    };
    const workflow = new FulfillmentWorkflow({
      config: appConfig({ rules: [] }),
      registry,
      readyOrders: new MarketplaceReadyOrderSource({
        registry,
        orders,
        concurrency: () => 2,
        now: () => NOW,
      }),
      stateStore,
      actions: {},
      documents: new OrderDocumentService(registry),
      logger: silentLogger,
      now: () => NOW,
      createId: () => "mid-page",
    });

    const result = await workflow.run("scheduled");

    expect(result.outcome).toBe("partial");
    expect(failed.observation.orderQueries).toHaveLength(2);
    expect(stateStore.state.baselines).toEqual({
      "failed-main": previousBaseline,
      "healthy-main": NOW.toISOString(),
    });
    expect(
      stateStore.state.orders["failed-main/MUST-NOT-COMMIT"],
    ).toBeUndefined();
    expect(stateStore.state.lastSync?.connections["failed-main"]).toMatchObject(
      {
        outcome: "failed",
        discoveredCount: 0,
        processedCount: 0,
      },
    );
  });

  it("uses canonical encoded keys for remote IDs", async () => {
    const fixture = workflowFixture();
    await fixture.workflow.run("manual");
    addReady(fixture, "first-main", "ORDER/SPACE 1");
    await fixture.workflow.run("scheduled");
    expect(
      fixture.stateStore.state.orders[
        orderRefKey({
          connectionId: "first-main",
          remoteId: "ORDER/SPACE 1",
        })
      ],
    ).toBeDefined();
  });
});
