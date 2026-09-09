import { describe, expect, it, vi } from "vitest";
import {
  ManaPoolApiError,
  type SellerOrderDetail,
  type SellerOrderSummary,
} from "manapool-seller-api";
import { ConnectionHealthService } from "../../src/marketplaces/health.js";
import {
  MarketplaceConnectionRegistry,
  ProviderAdapterRegistry,
} from "../../src/marketplaces/registry.js";
import {
  createManaPoolAdapterFactory,
  type ManaPoolAdapterClient,
} from "../../src/providers/manapool/factory.js";
import {
  manaPoolLifecycle,
  normalizeManaPoolOrderDetail,
} from "../../src/providers/manapool/normalization.js";

const CONNECTION_ID = "manapool-main";
const ORDER_ID = "018f4c5a-6b7c-7d8e-8f90-123456789abc";
const NOW = new Date("2026-08-25T12:00:00.000Z");

const summary: SellerOrderSummary = {
  id: ORDER_ID,
  createdAt: "2026-08-24T12:00:00.000Z",
  label: "MP-100",
  totalCents: 1424,
  shippingMethod: "ground_advantage",
  latestFulfillmentStatus: null,
};

function orderDetail(order: SellerOrderSummary = summary): SellerOrderDetail {
  return {
    ...order,
    buyerId: "synthetic-buyer-id",
    shippingAddress: {
      name: "Synthetic Buyer",
      line1: "123 Example Street",
      line2: "Unit 4",
      line3: null,
      city: "Example City",
      state: "IL",
      postalCode: "00000",
      country: "US",
    },
    payment: {
      subtotalCents: 1200,
      shippingCents: 224,
      totalCents: 1424,
      feeCents: 100,
      netCents: 1324,
    },
    fulfillments: [],
    items: [
      {
        tcgplayerSku: 123,
        productId: "synthetic-product-id",
        productType: "mtg_single",
        product: {
          type: "mtg_single",
          id: "synthetic-product-id",
          tcgplayerSku: 123,
          single: {
            scryfallId: "synthetic-scryfall-id",
            mtgjsonId: "synthetic-mtgjson-id",
            tcgplayerId: 456,
            name: "Synthetic Card",
            set: "TST",
            number: "1",
            languageId: "en",
            conditionId: "near_mint",
            finishId: "nonfoil",
          },
          sealed: null,
        },
        quantity: 2,
        priceCents: 600,
        customExternalId: null,
      },
    ],
  };
}

function fakeClient(): ManaPoolAdapterClient {
  return {
    getAccount: vi.fn(() =>
      Promise.resolve({
        username: "synthetic-seller",
        email: "seller@example.test",
        verified: true,
        singlesLive: true,
        sealedLive: true,
        payoutsEnabled: true,
      }),
    ),
    listSellerOrders: vi.fn(() =>
      Promise.resolve({
        orders: [summary],
        pagination: { limit: 100, nextCursor: null },
      }),
    ),
    getSellerOrder: vi.fn(() => Promise.resolve(orderDetail())),
    updateSellerOrderFulfillment: vi.fn(() =>
      Promise.resolve({
        status: "shipped" as const,
        trackingCompany: null,
        trackingNumber: null,
        trackingUrl: null,
        inTransitAt: null,
        estimatedDeliveryAt: null,
        deliveredAt: null,
      }),
    ),
  };
}

function registry(
  client: ManaPoolAdapterClient,
  credentialsPresent = true,
): MarketplaceConnectionRegistry {
  return new MarketplaceConnectionRegistry({
    adapters: new ProviderAdapterRegistry([
      createManaPoolAdapterFactory({
        client,
        credentialsPresent: () => credentialsPresent,
      }),
    ]),
    connections: {
      [CONNECTION_ID]: {
        providerId: "manapool",
        enabled: true,
        label: "ManaPool store",
        settings: {
          emailEnv: "MANAPOOL_EMAIL",
          accessTokenEnv: "MANAPOOL_ACCESS_TOKEN",
          pageSize: 100,
          maximumPages: 100,
          detailConcurrency: 5,
        },
      },
    },
    secrets: { get: () => undefined },
    now: () => NOW,
  });
}

describe("ManaPool provider adapter", () => {
  it.each([
    [null, "ready-to-ship"],
    ["error", "ready-to-ship"],
    ["processing", "ready-to-ship"],
    ["shipped", "shipped"],
    ["delivered", "delivered"],
    ["refunded", "refunded"],
    ["replaced", "unknown"],
  ] as const)("maps %s into the %s lifecycle", (status, lifecycle) => {
    expect(manaPoolLifecycle(status)).toBe(lifecycle);
  });

  it("performs a cached read-only account health probe and sanitizes authentication failure", async () => {
    const client = fakeClient();
    const connectionRegistry = registry(client);
    const health = new ConnectionHealthService(connectionRegistry, {
      now: () => NOW,
    });

    await expect(health.check(CONNECTION_ID)).resolves.toEqual({
      state: "connected",
      checkedAt: NOW.toISOString(),
    });
    await health.check(CONNECTION_ID);
    expect(client.getAccount).toHaveBeenCalledOnce();
    expect(client.listSellerOrders).not.toHaveBeenCalled();

    vi.mocked(client.getAccount).mockRejectedValueOnce(
      new ManaPoolApiError(
        "AUTHENTICATION_REQUIRED",
        "synthetic private provider detail",
      ),
    );
    await expect(health.check(CONNECTION_ID, { force: true })).resolves.toEqual(
      {
        state: "authentication-required",
        checkedAt: NOW.toISOString(),
        issueCode: "AUTHENTICATION_REQUIRED",
        retryable: false,
      },
    );
  });

  it("translates one page, fetches bounded detail, and preserves the provider cursor opaquely", async () => {
    const client = fakeClient();
    vi.mocked(client.listSellerOrders).mockResolvedValueOnce({
      orders: [summary],
      pagination: { limit: 1, nextCursor: "opaque/+cursor" },
    });
    const pages = registry(client).facet(CONNECTION_ID, "orderPages");

    const page = await pages.readOrderPage({
      scope: "all",
      since: "2026-05-25T12:00:00.000Z",
      pageSize: 1,
    });

    expect(client.listSellerOrders).toHaveBeenCalledWith(
      {
        since: "2026-05-25T12:00:00.000Z",
        limit: 1,
      },
      undefined,
    );
    expect(page.nextCursor).toBe("manapool-cursor-v1:opaque%2F%2Bcursor");
    expect(page.orders[0]).toMatchObject({
      ref: { connectionId: CONNECTION_ID, remoteId: ORDER_ID },
      displayOrderNumber: "MP-100",
      lifecycle: "ready-to-ship",
      totals: {
        subtotal: { currency: "USD", minorUnits: 1200 },
        shipping: { currency: "USD", minorUnits: 224 },
        total: { currency: "USD", minorUnits: 1424 },
      },
      actions: {
        "mark-shipped": { state: "available" },
        "packing-slip": { state: "available" },
      },
    });

    vi.mocked(client.listSellerOrders).mockResolvedValueOnce({
      orders: [],
      pagination: { limit: 1, nextCursor: null },
    });
    await pages.readOrderPage({
      scope: "ready-to-ship",
      cursor: page.nextCursor ?? "",
      pageSize: 1,
    });
    expect(client.listSellerOrders).toHaveBeenLastCalledWith(
      {
        needsShipping: true,
        limit: 1,
        cursor: "opaque/+cursor",
      },
      undefined,
    );
  });

  it("normalizes stable exact identities, cents, address, and duplicate equivalent lines", () => {
    const base = orderDetail();
    const normalized = normalizeManaPoolOrderDetail(
      { ...base, items: [...base.items, ...base.items] },
      CONNECTION_ID,
    );

    expect(normalized.lines).toHaveLength(1);
    expect(normalized.lines[0]).toMatchObject({
      quantity: 4,
      unitPrice: { currency: "USD", minorUnits: 600 },
      lineTotal: { currency: "USD", minorUnits: 2400 },
      attributes: {
        language: "en",
        condition: "near_mint",
        finish: "nonfoil",
      },
    });
    expect(normalized.lines[0]?.catalogIdentities).toEqual(
      expect.arrayContaining([
        {
          namespace: "manapool.product",
          value: "synthetic-product-id",
          precision: "exact-variant",
        },
        {
          namespace: "tcgplayer.sku",
          value: "123",
          precision: "exact-variant",
        },
      ]),
    );
    expect(normalized.shippingAddress.addressTwo).toBe("Unit 4");
  });

  it("canonicalizes ManaPool timestamps with microseconds and UTC offsets", async () => {
    const providerTimestamp = "2026-09-03T01:48:50.268546+00:00";
    const providerSummary = { ...summary, createdAt: providerTimestamp };
    const client = fakeClient();
    vi.mocked(client.listSellerOrders).mockResolvedValueOnce({
      orders: [providerSummary],
      pagination: { limit: 100, nextCursor: null },
    });
    vi.mocked(client.getSellerOrder).mockResolvedValue(
      orderDetail(providerSummary),
    );

    const page = await registry(client)
      .facet(CONNECTION_ID, "orderPages")
      .readOrderPage({ scope: "ready-to-ship", pageSize: 100 });
    const detail = normalizeManaPoolOrderDetail(
      orderDetail(providerSummary),
      CONNECTION_ID,
    );

    expect(page.orders[0]?.createdAt).toBe("2026-09-03T01:48:50.268Z");
    expect(detail.createdAt).toBe("2026-09-03T01:48:50.268Z");
  });

  it("routes tracking and shipment mutations to the exact qualified remote ID", async () => {
    const client = fakeClient();
    const fulfillment = registry(client).facet(CONNECTION_ID, "fulfillment");
    const ref = { connectionId: CONNECTION_ID, remoteId: ORDER_ID };

    await expect(
      fulfillment.addTracking({ ref, trackingNumber: " SYNTHETIC-9400 " }),
    ).resolves.toEqual({ ref, outcome: "applied" });
    await expect(fulfillment.markShipped({ ref })).resolves.toEqual({
      ref,
      outcome: "applied",
    });
    expect(client.updateSellerOrderFulfillment).toHaveBeenNthCalledWith(
      1,
      {
        orderId: ORDER_ID,
        status: "processing",
        trackingNumber: "SYNTHETIC-9400",
      },
      undefined,
    );
    expect(client.updateSellerOrderFulfillment).toHaveBeenNthCalledWith(
      2,
      { orderId: ORDER_ID, status: "shipped" },
      undefined,
    );
  });

  it("does not construct or call a client when configured secrets are absent", async () => {
    const client = fakeClient();
    const connectionRegistry = registry(client, false);
    await expect(
      new ConnectionHealthService(connectionRegistry, {
        now: () => NOW,
      }).check(CONNECTION_ID),
    ).resolves.toEqual({
      state: "not-configured",
      checkedAt: NOW.toISOString(),
      issueCode: "NOT_CONFIGURED",
      retryable: false,
    });
    expect(client.getAccount).not.toHaveBeenCalled();
  });

  it("fails closed for foreign refs, mismatched detail, and malformed provider cursors", async () => {
    const client = fakeClient();
    const connectionRegistry = registry(client);
    await expect(
      connectionRegistry.facet(CONNECTION_ID, "orderDetails").getOrder({
        connectionId: "other-main",
        remoteId: ORDER_ID,
      }),
    ).rejects.toThrow("another marketplace connection");

    vi.mocked(client.getSellerOrder).mockResolvedValueOnce(
      orderDetail({ ...summary, id: "wrong-order" }),
    );
    await expect(
      connectionRegistry.facet(CONNECTION_ID, "orderDetails").getOrder({
        connectionId: CONNECTION_ID,
        remoteId: ORDER_ID,
      }),
    ).rejects.toThrow("wrong order");

    await expect(
      connectionRegistry.facet(CONNECTION_ID, "orderPages").readOrderPage({
        scope: "all",
        cursor: "raw-provider-cursor",
        pageSize: 100,
      }),
    ).rejects.toThrow("cursor");
  });
});
