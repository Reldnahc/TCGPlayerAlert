import { afterEach, describe, expect, it } from "vitest";
import {
  startConfigurationUi,
  type ConfigurationUiServer,
  type ConfigurationService,
} from "../../src/config-ui.js";
import type { OrderDetail } from "../../src/marketplaces/contracts.js";
import { ConnectionHealthService } from "../../src/marketplaces/health.js";
import { MarketplaceOrderActionService } from "../../src/marketplaces/order-actions.js";
import { OrderQueryService } from "../../src/marketplaces/order-query.js";
import { MarketplaceReadyOrderSource } from "../../src/marketplaces/ready-orders.js";
import { MarketplaceInventoryService } from "../../src/marketplaces/inventory.js";
import type { MarketplaceOrderRuntime } from "../../src/marketplaces/order-runtime.js";
import type { InventoryAdditionService } from "../../src/inventory-additions.js";
import {
  emptyLocalInventoryState,
  LocalInventoryService,
  type LocalInventoryState,
} from "../../src/local-inventory.js";
import { FulfillmentWorkflow } from "../../src/orchestrator.js";
import { emptyState, type ApplicationState } from "../../src/state.js";
import {
  OrderDocumentService,
  OrderPrintService,
} from "../../src/fulfillment/documents.js";
import { MasterPullListService } from "../../src/fulfillment/pull-list.js";
import {
  emptyQualifiedPullListProgressState,
  type QualifiedPullListProgressState,
} from "../../src/fulfillment/pull-list-progress.js";
import type { PrintJob } from "../../src/printing.js";
import {
  MarketplaceConnectionRegistry,
  ProviderAdapterRegistry,
  environmentSecretAccess,
} from "../../src/marketplaces/registry.js";
import { appConfig } from "../fixtures.js";
import {
  syntheticFactory,
  syntheticNormalizedOrder,
  type SyntheticFactoryObservation,
} from "../synthetic-marketplace.js";

let server: ConfigurationUiServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function detail(connectionId: string, remoteId: string): OrderDetail {
  return {
    ...syntheticNormalizedOrder({ connectionId, remoteId }),
    shippingAddress: {
      recipientName: "Synthetic Recipient",
      addressOne: "123 Example Street",
      city: "Example City",
      territory: "IL",
      country: "US",
      postalCode: "00000",
    },
    lines: [
      {
        lineKey: "synthetic-line",
        description: "Synthetic item",
        quantity: 1,
        unitPrice: { currency: "USD", minorUnits: 100 },
        lineTotal: { currency: "USD", minorUnits: 100 },
        attributes: { condition: "Synthetic" },
        catalogIdentities: [
          {
            namespace: "synthetic.sku",
            value: "synthetic-sku",
            precision: "exact-variant",
          },
        ],
      },
    ],
    trackingNumbers: [],
  };
}

function marketplaceRuntime(
  options: {
    readonly failFirst?: boolean;
    readonly failSecond?: boolean;
    readonly firstMutable?: boolean;
    readonly submittedPrintJobs?: PrintJob[];
    readonly secondHealth?: "connected" | "authentication-required";
    readonly failPullSources?: boolean;
    readonly inventory?: boolean;
    readonly catalogSearch?: boolean;
    readonly firstObservations?: SyntheticFactoryObservation[];
  } = {},
): MarketplaceOrderRuntime {
  const firstOrder = syntheticNormalizedOrder({
    connectionId: "first-main",
    remoteId: "shared-label",
  });
  const secondOrder = syntheticNormalizedOrder({
    connectionId: "second-main",
    remoteId: "shared-label",
  });
  const first = syntheticFactory("first-provider", "First Provider", {
    mutable: options.firstMutable ?? true,
    detail: detail("first-main", "shared-label"),
    ...(options.failFirst === undefined
      ? {}
      : { failOrders: options.failFirst }),
    pages: { first: { orders: [firstOrder] } },
    ...(options.failPullSources === true
      ? { pullLines: new Error("private first pull failure") }
      : {}),
    ...(options.inventory === true
      ? {
          inventoryPages: {
            first: {
              items: [
                {
                  inventoryKey: "shared-key",
                  displayName: "First inventory",
                  quantity: 1,
                  price: { currency: "USD", minorUnits: 100 },
                  catalogIdentities: [
                    {
                      namespace: "shared.sku",
                      value: "42",
                      precision: "exact-variant" as const,
                    },
                  ],
                  attributes: {},
                  quantityMutation: "absolute" as const,
                  priceMutable: true,
                },
              ],
            },
          },
          inventoryMutation: "applied" as const,
        }
      : {}),
    ...(options.catalogSearch === true ? { catalogSearch: true } : {}),
  });
  options.firstObservations?.push(first.observation);
  const second = syntheticFactory("second-provider", "Second Provider", {
    mutable: true,
    detail: detail("second-main", "shared-label"),
    ...(options.failSecond === undefined
      ? {}
      : { failOrders: options.failSecond }),
    health:
      options.secondHealth === "authentication-required"
        ? {
            state: "authentication-required",
            issueCode: "AUTHENTICATION_REQUIRED",
            retryable: false,
          }
        : { state: "connected" },
    pages: { first: { orders: [secondOrder] } },
    ...(options.failPullSources === true
      ? { pullLines: new Error("private second pull failure") }
      : {}),
    ...(options.inventory === true
      ? {
          inventoryPages: {
            first: {
              items: [
                {
                  inventoryKey: "shared-key",
                  displayName: "Second inventory",
                  quantity: 2,
                  price: { currency: "USD", minorUnits: 200 },
                  catalogIdentities: [
                    {
                      namespace: "shared.sku",
                      value: "42",
                      precision: "exact-variant" as const,
                    },
                  ],
                  attributes: {},
                  quantityMutation: "absolute" as const,
                  priceMutable: true,
                },
              ],
            },
          },
          inventoryMutation: "applied" as const,
        }
      : {}),
  });
  const registry = new MarketplaceConnectionRegistry({
    adapters: new ProviderAdapterRegistry([first.factory, second.factory]),
    connections: {
      "first-main": {
        providerId: "first-provider",
        enabled: true,
        label: "First store",
        settings: { fixture: "http" },
      },
      "second-main": {
        providerId: "second-provider",
        enabled: true,
        label: "Second store",
        settings: { fixture: "http" },
      },
      "second-disabled": {
        providerId: "second-provider",
        enabled: false,
        label: "Disabled store",
        settings: {},
      },
    },
    secrets: environmentSecretAccess({}),
    now: () => new Date("2026-08-25T12:00:00.000Z"),
  });
  const health = new ConnectionHealthService(registry, {
    now: () => new Date("2026-08-25T12:00:00.000Z"),
  });
  const orders = new OrderQueryService({
    registry,
    health,
    paging: () => ({ pageSize: 100, maximumPages: 2 }),
    now: () => new Date("2026-08-25T12:00:00.000Z"),
  });
  const documents = new OrderDocumentService(registry);
  const readyOrders = new MarketplaceReadyOrderSource({
    registry,
    orders,
    concurrency: () => 2,
    now: () => new Date("2026-08-25T12:00:00.000Z"),
  });
  const inventory = new MarketplaceInventoryService({
    registry,
    health,
    paging: () => ({ pageSize: 100, maximumPages: 10 }),
    concurrency: () => 2,
    now: () => new Date("2026-08-25T12:00:00.000Z"),
  });
  let workflowState: ApplicationState = emptyState();
  const workflow = new FulfillmentWorkflow({
    config: appConfig(),
    registry,
    readyOrders,
    stateStore: {
      load: () => Promise.resolve(structuredClone(workflowState)),
      save: (state) => {
        workflowState = structuredClone(state);
        return Promise.resolve();
      },
    },
    actions: {},
    documents,
    logger: { info: () => undefined, error: () => undefined },
    now: () => new Date("2026-08-25T12:00:00.000Z"),
  });
  let pullProgress: QualifiedPullListProgressState =
    emptyQualifiedPullListProgressState();
  const pullList = new MasterPullListService({
    registry,
    orders,
    progress: {
      load: () => Promise.resolve(structuredClone(pullProgress)),
      save: (state) => {
        pullProgress = structuredClone(state);
        return Promise.resolve();
      },
    },
    grouping: () =>
      Promise.resolve({
        groupLands: true,
        groupMulticolored: true,
        binning: { enabled: false, fallback: "", rules: [] },
      }),
    now: () => new Date("2026-08-25T12:00:00.000Z"),
  });
  return {
    registry,
    health,
    orders,
    actions: new MarketplaceOrderActionService({
      registry,
      health,
      queries: orders,
      onOrderRemoved: (ref) => pullList.removeOrder(ref),
    }),
    documents,
    printing: new OrderPrintService({
      documents,
      configuration: () =>
        Promise.resolve(
          appConfig({
            printers: {
              synthetic: {
                adapter: "windows-native-label",
                printerName: "Synthetic printer",
                timeoutSeconds: 10,
              },
            },
            actions: {
              label: {
                type: "print-address-label",
                enabled: false,
                printer: "synthetic",
                page: {
                  widthMm: 89,
                  heightMm: 28,
                  marginMm: 3,
                  fontSize: 12,
                },
                lines: [
                  "{recipientName}",
                  "{addressOne}",
                  "{city}, {territory} {postalCode}",
                ],
              },
              slip: {
                type: "print-packing-slip",
                enabled: false,
                printer: "synthetic",
              },
            },
          }),
        ),
      createPrinter: () => ({
        acceptedMediaTypes: new Set([
          "application/pdf",
          "application/vnd.tcgplayer-alert.address-label+json",
        ]),
        submit(job) {
          options.submittedPrintJobs?.push(job);
          return Promise.resolve();
        },
      }),
    }),
    pullList,
    readyOrders,
    workflow,
    inventory,
  };
}

async function start(
  marketplaces: MarketplaceOrderRuntime,
  options: {
    readonly localInventory?: LocalInventoryService;
    readonly inventoryService?: InventoryAdditionService;
  } = {},
): Promise<ConfigurationUiServer> {
  return startConfigurationUi({
    configPath: "unused-synthetic-config.json",
    port: 0,
    marketplaces,
    ...(options.localInventory === undefined
      ? {}
      : { localInventory: options.localInventory }),
    ...(options.inventoryService === undefined
      ? {}
      : { inventoryService: options.inventoryService }),
    service: {
      read: () => Promise.resolve({}),
      save: (value: unknown) => Promise.resolve(value),
      preview: () => Promise.resolve(appConfig()),
    } as unknown as ConfigurationService,
  });
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
      now: () => new Date("2026-08-25T12:00:00.000Z"),
      id: () => "00000000-0000-4000-8000-000000000001",
    },
  );
}

function catalogService(): InventoryAdditionService {
  return {
    getProduct: () =>
      Promise.resolve({
        productId: 123,
        imageUrl: "https://example.invalid/synthetic-card.jpg",
        productName: "Synthetic Card",
        productLineName: "Synthetic Game",
        setName: "Synthetic Set",
        rarityName: "Rare",
        cardNumber: "42",
        marketPrice: 3.5,
        sellerListable: true,
        skus: [
          {
            productConditionId: 456,
            conditionId: 3,
            condition: "Moderately Played",
            printing: "Normal",
            language: "English",
          },
        ],
      }),
  } as unknown as InventoryAdditionService;
}

describe("generic marketplace HTTP routes", () => {
  it("serves combined inventory and applies a connection-qualified mutation", async () => {
    server = await start(marketplaceRuntime({ inventory: true }));

    const list = await fetch(`${server.url}/api/inventory`);
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      items: [],
      listings: [
        {
          descriptor: { connectionId: "first-main" },
          item: {
            inventoryKey: "shared-key",
            displayName: "First inventory",
          },
        },
        {
          descriptor: { connectionId: "second-main" },
          item: {
            inventoryKey: "shared-key",
            displayName: "Second inventory",
          },
        },
      ],
      issues: [],
    });

    const update = await fetch(
      `${server.url}/api/connections/second-main/inventory/${encodeURIComponent("shared-key")}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: server.url },
        body: JSON.stringify({
          quantity: 7,
          price: { currency: "USD", minorUnits: 250 },
        }),
      },
    );
    expect(update.status).toBe(200);
    await expect(update.json()).resolves.toEqual({
      connectionId: "second-main",
      inventoryKey: "shared-key",
      outcome: "applied",
    });

    const unknown = await fetch(
      `${server.url}/api/inventory?connectionId=missing-main`,
    );
    expect(unknown.status).toBe(404);
  });

  it("adds and edits local stock without mutating either marketplace", async () => {
    const observations: SyntheticFactoryObservation[] = [];
    const localInventory = memoryLocalInventory();
    server = await start(
      marketplaceRuntime({
        inventory: true,
        catalogSearch: true,
        firstObservations: observations,
      }),
      { localInventory, inventoryService: catalogService() },
    );

    const addition = await fetch(
      `${server.url}/api/local-inventory/catalog-items?connectionId=first-main`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: server.url },
        body: JSON.stringify({
          productId: 123,
          productConditionId: 456,
          quantity: 2,
        }),
      },
    );
    expect(addition.status).toBe(201);
    await expect(addition.json()).resolves.toMatchObject({
      item: {
        localInventoryId: "00000000-0000-4000-8000-000000000001",
        displayName: "Synthetic Card",
        onHand: 2,
        catalogIdentities: [
          {
            namespace: "first-provider.sku",
            value: "456",
            precision: "exact-variant",
          },
          {
            namespace: "first-provider.product",
            value: "123",
            precision: "product",
          },
        ],
      },
    });

    const update = await fetch(
      `${server.url}/api/local-inventory/items/00000000-0000-4000-8000-000000000001`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", origin: server.url },
        body: JSON.stringify({ onHand: 7 }),
      },
    );
    expect(update.status).toBe(200);
    await expect(update.json()).resolves.toMatchObject({
      item: { onHand: 7 },
    });
    await expect(localInventory.snapshot()).resolves.toMatchObject({
      items: [{ displayName: "Synthetic Card", onHand: 7 }],
    });
    expect(observations[0]?.inventoryMutations).toEqual([]);
  });

  it("previews and idempotently imports cross-listed stock without summing or provider writes", async () => {
    const observations: SyntheticFactoryObservation[] = [];
    const localInventory = memoryLocalInventory();
    server = await start(
      marketplaceRuntime({
        inventory: true,
        firstObservations: observations,
      }),
      { localInventory },
    );

    const preview = await fetch(
      `${server.url}/api/local-inventory/import-preview`,
    );
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({
      candidates: [
        {
          suggestedOnHand: 2,
          crossListed: true,
          observations: [
            { connectionId: "first-main", quantity: 1 },
            { connectionId: "second-main", quantity: 2 },
          ],
        },
      ],
    });

    for (const expectedCreatedCount of [1, 0]) {
      const imported = await fetch(`${server.url}/api/local-inventory/import`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: server.url },
        body: JSON.stringify({
          confirmation: "IMPORT_MARKETPLACE_STOCK",
        }),
      });
      expect(imported.status).toBe(200);
      await expect(imported.json()).resolves.toMatchObject({
        createdCount: expectedCreatedCount,
      });
    }
    await expect(localInventory.snapshot()).resolves.toMatchObject({
      items: [{ onHand: 2 }],
    });
    expect(observations[0]?.inventoryMutations).toEqual([]);
  });

  it("returns connection descriptors, static facets, and cached health including disabled connections", async () => {
    server = await start(marketplaceRuntime());

    const response = await fetch(`${server.url}/api/marketplace-connections`);
    const body = (await response.json()) as {
      readonly connections: readonly {
        readonly descriptor: { readonly connectionId: string };
        readonly enabled: boolean;
        readonly supportedFacets: readonly string[];
        readonly health: { readonly state: string };
      }[];
    };

    expect(response.status).toBe(200);
    const first = body.connections.find(
      (connection) => connection.descriptor.connectionId === "first-main",
    );
    const disabled = body.connections.find(
      (connection) => connection.descriptor.connectionId === "second-disabled",
    );
    expect(first?.enabled).toBe(true);
    expect(first?.supportedFacets).toEqual([
      "order-pages",
      "order-details",
      "fulfillment",
    ]);
    expect(first?.health.state).toBe("connected");
    expect(disabled).toMatchObject({
      enabled: false,
      health: { state: "disabled" },
    });
  });

  it("returns successful data with a safe issue when one eligible connection fails", async () => {
    server = await start(marketplaceRuntime({ failSecond: true }));

    const response = await fetch(`${server.url}/api/orders`);
    const body = (await response.json()) as {
      readonly data: readonly {
        readonly ref: { readonly connectionId: string };
      }[];
      readonly issues: readonly {
        readonly connectionId: string;
        readonly code: string;
      }[];
    };

    expect(response.status).toBe(200);
    expect(body.data.map((order) => order.ref.connectionId)).toEqual([
      "first-main",
    ]);
    expect(body.issues).toEqual([
      {
        connectionId: "second-main",
        operation: "list-orders",
        code: "ORDER_QUERY_FAILED",
        retryable: true,
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("private order detail");
  });

  it("returns 503 with only safe issues when every eligible connection fails", async () => {
    server = await start(
      marketplaceRuntime({ failFirst: true, failSecond: true }),
    );

    const response = await fetch(`${server.url}/api/orders`);
    const body = (await response.json()) as {
      readonly code: string;
      readonly issues: readonly { readonly connectionId: string }[];
    };

    expect(response.status).toBe(503);
    expect(body.code).toBe("ALL_ORDER_CONNECTIONS_FAILED");
    expect(body.issues.map((issue) => issue.connectionId).sort()).toEqual([
      "first-main",
      "second-main",
    ]);
    expect(JSON.stringify(body)).not.toContain("private order detail");
  });

  it("uses one unchanged aggregate route for duplicate labels from two connections", async () => {
    server = await start(marketplaceRuntime());

    const response = await fetch(`${server.url}/api/orders/ready`);
    const body = (await response.json()) as {
      readonly data: readonly {
        readonly ref: {
          readonly connectionId: string;
          readonly remoteId: string;
        };
        readonly displayOrderNumber: string;
      }[];
    };

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(2);
    expect(
      body.data.map((order) => [
        order.ref.connectionId,
        order.ref.remoteId,
        order.displayOrderNumber,
      ]),
    ).toEqual([
      ["first-main", "shared-label", "shared-label"],
      ["second-main", "shared-label", "shared-label"],
    ]);
  });

  it("serves and updates one combined pull list through the generic runtime", async () => {
    server = await start(marketplaceRuntime());

    const initialResponse = await fetch(`${server.url}/api/orders/pull-list`);
    const initial = (await initialResponse.json()) as {
      readonly orderCount: number;
      readonly totalQuantity: number;
      readonly issues: readonly unknown[];
      readonly rows: readonly {
        readonly rowKey: string;
        readonly orderQuantity: number;
      }[];
    };

    expect(initialResponse.status).toBe(200);
    expect(initial).toMatchObject({
      orderCount: 2,
      totalQuantity: 2,
      issues: [],
    });
    expect(initial.rows).toHaveLength(1);
    expect(initial.rows[0]?.orderQuantity).toBe(2);
    const rowKey = initial.rows[0]?.rowKey;
    if (rowKey === undefined) throw new Error("Pull-list row is missing.");

    const pulledResponse = await fetch(
      `${server.url}/api/orders/pull-list/items/${encodeURIComponent(rowKey)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: server.url,
        },
        body: JSON.stringify({ pulled: true }),
      },
    );
    expect(pulledResponse.status).toBe(200);
    await expect(pulledResponse.json()).resolves.toMatchObject({
      rowKey,
      pulled: true,
      pulledQuantity: 2,
    });

    const shippedResponse = await fetch(
      `${server.url}/api/connections/first-main/orders/shared-label/mark-shipped`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: server.url,
        },
        body: "{}",
      },
    );
    expect(shippedResponse.status).toBe(200);

    const remainingResponse = await fetch(`${server.url}/api/orders/pull-list`);
    await expect(remainingResponse.json()).resolves.toMatchObject({
      orderCount: 1,
      totalQuantity: 1,
      pulledQuantity: 1,
      remainingQuantity: 0,
      rows: [{ rowKey, orderQuantity: 1, pulled: true }],
    });
  });

  it("returns a safe 503 when every ready connection fails to supply pull lines", async () => {
    server = await start(marketplaceRuntime({ failPullSources: true }));

    const response = await fetch(`${server.url}/api/orders/pull-list`);
    const body = (await response.json()) as {
      readonly code: string;
      readonly issues: readonly { readonly connectionId: string }[];
    };

    expect(response.status).toBe(503);
    expect(body.code).toBe("ALL_PULL_CONNECTIONS_FAILED");
    expect(body.issues.map((issue) => issue.connectionId).sort()).toEqual([
      "first-main",
      "second-main",
    ]);
    expect(JSON.stringify(body)).not.toContain("private");
  });

  it("routes detail and mutations only through the qualified connection path", async () => {
    server = await start(marketplaceRuntime());
    const base = `${server.url}/api/connections/second-main/orders/shared-label`;

    const detailResponse = await fetch(base);
    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      ref: { connectionId: "second-main", remoteId: "shared-label" },
      displayOrderNumber: "shared-label",
    });

    const tracking = await fetch(`${base}/tracking`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: server.url,
      },
      body: JSON.stringify({ trackingNumber: "synthetic-tracking" }),
    });
    expect(tracking.status).toBe(200);
    await expect(tracking.json()).resolves.toEqual({
      ref: { connectionId: "second-main", remoteId: "shared-label" },
      outcome: "applied",
    });

    const shipped = await fetch(`${base}/mark-shipped`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: server.url,
      },
      body: "{}",
    });
    expect(shipped.status).toBe(200);
  });

  it("downloads and prints locally derived documents through qualified routes", async () => {
    const submittedPrintJobs: PrintJob[] = [];
    server = await start(marketplaceRuntime({ submittedPrintJobs }));
    const base = `${server.url}/api/connections/first-main/orders/shared-label`;

    const download = await fetch(`${base}/packing-slip`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/pdf");
    expect(download.headers.get("content-disposition")).toContain(
      "packing-slip-shared-label.pdf",
    );
    expect((await download.arrayBuffer()).byteLength).toBeGreaterThan(100);

    for (const actionType of [
      "print-address-label",
      "print-packing-slip",
    ] as const) {
      const response = await fetch(`${base}/print`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: server.url,
        },
        body: JSON.stringify({ actionType }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        printed: true,
        ref: { connectionId: "first-main", remoteId: "shared-label" },
        actionType,
      });
    }

    expect(submittedPrintJobs.map((job) => job.mediaType)).toEqual([
      "application/vnd.tcgplayer-alert.address-label+json",
      "application/pdf",
    ]);
  });

  it("returns direct 404, 409, and 401 results without calling the wrong connection", async () => {
    server = await start(
      marketplaceRuntime({
        firstMutable: false,
        secondHealth: "authentication-required",
      }),
    );

    const unknown = await fetch(
      `${server.url}/api/connections/missing-main/orders/shared-label`,
    );
    expect(unknown.status).toBe(404);

    const unsupported = await fetch(
      `${server.url}/api/connections/first-main/orders/shared-label/tracking`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: server.url,
        },
        body: JSON.stringify({ trackingNumber: "synthetic-tracking" }),
      },
    );
    expect(unsupported.status).toBe(409);

    const authentication = await fetch(
      `${server.url}/api/connections/second-main/orders/shared-label`,
    );
    expect(authentication.status).toBe(401);
    await expect(authentication.json()).resolves.toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
    });
  });
});
