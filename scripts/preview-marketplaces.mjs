import {
  ConnectionHealthService,
  MarketplaceConnectionRegistry,
  MarketplaceReadyOrderSource,
  OrderQueryService,
  ProviderAdapterRegistry,
  normalizeTcgplayerOrderDetail,
  normalizeTcgplayerOrderSummary,
} from "../dist/index.js";

export const previewConnectionId = "tcgplayer-main";

export function previewOrder(order) {
  return normalizeTcgplayerOrderSummary(
    {
      ...order,
      orderStatus: order.status,
      orderStatusCode: order.statusCode,
      orderChannel: "Marketplace",
      orderFulfillment: "Seller",
      buyerPaid: true,
    },
    previewConnectionId,
  );
}

// Every transport in this preview is synthetic; never create a live seller client.
export async function previewMarketplaces(options) {
  const connection = {
    descriptor: {
      connectionId: previewConnectionId,
      providerId: "tcgplayer",
      providerLabel: "TCGplayer",
      connectionLabel: "Preview shop",
    },
    health: { checkHealth: async () => ({ state: "connected" }) },
    facets: {
      orderPages: {
        readOrderPage: async ({ scope }) => ({
          orders: (await options.orderService.listOrders(scope)).orders.map(
            previewOrder,
          ),
        }),
      },
      orderDetails: {
        getOrder: async (ref) =>
          normalizeTcgplayerOrderDetail(
            await options.orderService.getOrder(ref.remoteId),
            previewConnectionId,
          ),
      },
      fulfillment: {
        addTracking: async ({ ref }) => ({ ref, outcome: "applied" }),
        markShipped: async ({ ref }) => ({ ref, outcome: "applied" }),
      },
      catalogSearch: { kind: "catalog-search" },
      repricing: { kind: "repricing" },
      payments: { kind: "payments" },
      messages: { kind: "messages" },
      feedback: { kind: "feedback" },
    },
  };
  const registry = new MarketplaceConnectionRegistry({
    adapters: new ProviderAdapterRegistry([
      {
        providerId: "tcgplayer",
        providerLabel: "TCGplayer",
        supportedFacets: [
          "order-pages",
          "order-details",
          "fulfillment",
          "catalog-search",
          "repricing",
          "payments",
          "messages",
          "feedback",
        ],
        create: () => connection,
      },
    ]),
    connections: {
      [previewConnectionId]: {
        providerId: "tcgplayer",
        label: "Preview shop",
        enabled: true,
        settings: {},
      },
    },
    secrets: { get: () => undefined },
  });
  const health = new ConnectionHealthService(registry);
  const orders = new OrderQueryService({
    registry,
    health,
    paging: () => ({ pageSize: 100, maximumPages: 10 }),
  });
  const readyOrders = new MarketplaceReadyOrderSource({
    registry,
    orders,
    concurrency: () => 1,
  });
  await readyOrders.refresh();
  return {
    registry,
    health,
    orders,
    readyOrders,
    workflow: { run: () => readyOrders.refresh() },
    pullList: {
      getMasterPullList: async () => {
        const list = await options.orderService.getMasterPullList();
        return {
          ...list,
          issues: [],
          rows: list.rows.map((row) => ({ ...row, rowKey: row.skuId })),
        };
      },
      setRowPulled: async (key, pulled) => ({
        ...(await options.orderService.setPullListRowPulled(key, pulled)),
        rowKey: key,
      }),
    },
    inventory: {
      listAll: async () => ({
        connections: [],
        issues: [],
        completedAt: new Date().toISOString(),
      }),
    },
  };
}
