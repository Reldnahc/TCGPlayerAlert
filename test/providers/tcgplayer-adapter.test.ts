import { describe, expect, it, vi } from "vitest";
import {
  SellerOrderStatus,
  type SellerOrderDetail,
  type SellerOrderSearchSummary,
} from "tcgplayer-private-api";
import { ConnectionHealthService } from "../../src/marketplaces/health.js";
import {
  MarketplaceConnectionRegistry,
  ProviderAdapterRegistry,
} from "../../src/marketplaces/registry.js";
import type { SellerCredentialAccess } from "../../src/seller-credentials.js";
import {
  createTcgplayerAdapterFactory,
  parseTcgplayerAdapterSettings,
  type TcgplayerAdapterClient,
} from "../../src/providers/tcgplayer/factory.js";
import { tcgplayerLifecycle } from "../../src/providers/tcgplayer/normalization.js";
import { createMarketplaceConnectionRegistry } from "../../src/runtime.js";
import { appConfig } from "../fixtures.js";

const CONNECTION_ID = "tcgplayer-main";
const NOW = new Date("2026-08-25T12:00:00.000Z");

const summary: SellerOrderSearchSummary = {
  orderNumber: "synthetic-order-1",
  orderDate: "2026-08-24T10:00:00.000Z",
  orderChannel: "Marketplace",
  orderStatus: "Ready to Ship",
  orderStatusCode: SellerOrderStatus.ReadyToShip,
  buyerName: "Synthetic Buyer",
  shippingType: "Standard",
  productAmount: 12,
  shippingAmount: 1.49,
  totalAmount: 13.49,
  buyerPaid: true,
  orderFulfillment: "Seller",
};

const detail: SellerOrderDetail = {
  createdAt: summary.orderDate,
  status: summary.orderStatus,
  statusCode: summary.orderStatusCode,
  orderChannel: summary.orderChannel,
  orderFulfillment: summary.orderFulfillment,
  orderNumber: summary.orderNumber,
  sellerName: "Synthetic Seller",
  buyerName: summary.buyerName,
  paymentType: "CreditCard",
  pickupStatus: "",
  shippingType: summary.shippingType,
  estimatedDeliveryDate: "2026-08-30T12:00:00.000Z",
  transaction: {
    productAmount: 12,
    shippingAmount: 1.49,
    grossAmount: 14.32,
    feeAmount: 1,
    netAmount: 13.32,
    directFeeAmount: 0,
    taxes: [{ code: "STATE", amount: 0.83 }],
  },
  shippingAddress: {
    recipientName: "Synthetic Buyer",
    addressOne: "123 Example Street",
    addressTwo: "Apt 4",
    city: "Example City",
    territory: "IL",
    country: "US",
    postalCode: "00000",
  },
  products: [
    {
      name: "Synthetic Card",
      unitPrice: 6,
      extendedPrice: 12,
      quantity: 2,
      url: "https://example.test/products/123",
      productId: "123",
      skuId: "456",
      listoId: "provider-line-1",
    },
  ],
  refunds: [],
  refundStatus: "None",
  refundCapabilities: { full: true, partial: true },
  trackingNumbers: [
    {
      createdAt: "2026-08-25T10:00:00.000Z",
      carrier: "USPS",
      trackingNumber: "SYNTHETIC-TRACKING",
      status: "In Transit",
    },
  ],
  allowedActions: ["AddTracking", "MarkShipped", "FullRefund", "PartialRefund"],
};

function fakeClient(): TcgplayerAdapterClient {
  return {
    searchOrders: vi.fn(() =>
      Promise.resolve({ totalOrders: 1, orders: [summary] }),
    ),
    getOrder: vi.fn(() => Promise.resolve(detail)),
    detectCarrier: vi.fn(() => Promise.resolve({ carrier: "USPS" })),
    addOrderTracking: vi.fn(
      (input: Parameters<TcgplayerAdapterClient["addOrderTracking"]>[0]) =>
        Promise.resolve({
          orderNumber: input.orderNumber,
          outcome: "applied" as const,
        }),
    ),
    shipOrderWithoutTracking: vi.fn(
      (
        input: Parameters<
          TcgplayerAdapterClient["shipOrderWithoutTracking"]
        >[0],
      ) =>
        Promise.resolve({
          orderNumber: input.orderNumber,
          outcome: "already-applied" as const,
        }),
    ),
    getPackingSlip: vi.fn(
      (input: Parameters<TcgplayerAdapterClient["getPackingSlip"]>[0]) =>
        Promise.resolve({
          bytes: new Uint8Array([37, 80, 68, 70]),
          contentType: "application/pdf" as const,
          fileName: "packing-slip.pdf",
          orderNumbers: [input.orderNumber],
        }),
    ),
    exportPullSheet: vi.fn(
      (input: Parameters<TcgplayerAdapterClient["exportPullSheet"]>[0]) =>
        Promise.resolve({
          text: "synthetic",
          contentType: "text/csv" as const,
          fileName: "pull-sheet.csv" as const,
          orderNumbers: input.orderNumbers,
          rows: [
            {
              productLine: "Magic: The Gathering",
              productName: "Synthetic Card",
              condition: "Near Mint",
              number: "42",
              setName: "Synthetic Set",
              rarity: "Rare",
              quantity: 10,
              mainPhotoUrl: "https://product-images.tcgplayer.com/123.jpg",
              setReleaseDate: "2026-01-01",
              skuId: "456",
              orderQuantity: 2,
              orderAllocations: [
                { orderNumber: input.orderNumbers[0] ?? "", quantity: 2 },
              ],
            },
          ],
        }),
    ),
    searchMarketplaceProducts: vi.fn(() =>
      Promise.resolve({ totalProducts: 0, products: [] }),
    ),
  };
}

function credentials(connected = true): SellerCredentialAccess {
  return {
    session: () => ({ authCookie: "synthetic-cookie" }),
    sellerKey: () => "synthetic-seller-key",
    onAuthenticationRequired: () => undefined,
    isConnected: () => connected,
  };
}

function registry(
  client: TcgplayerAdapterClient,
  connected = true,
): MarketplaceConnectionRegistry {
  return new MarketplaceConnectionRegistry({
    adapters: new ProviderAdapterRegistry([
      createTcgplayerAdapterFactory({
        client,
        credentials: credentials(connected),
        timezoneOffsetMinutes: 300,
      }),
    ]),
    connections: {
      [CONNECTION_ID]: {
        providerId: "tcgplayer",
        enabled: true,
        label: "Primary seller",
        settings: {
          authCookieEnv: "TCGPLAYER_AUTH_COOKIE",
          sellerKeyEnv: "TCGPLAYER_SELLER_KEY",
          pageSize: 100,
          maximumPages: 100,
        },
      },
    },
    secrets: { get: () => undefined },
    now: () => NOW,
  });
}

describe("TCGplayer provider adapter", () => {
  it.each([
    [SellerOrderStatus.Processing, "pending"],
    [SellerOrderStatus.Pulling, "pending"],
    [SellerOrderStatus.Received, "pending"],
    [SellerOrderStatus.ReadyToShip, "ready-to-ship"],
    [SellerOrderStatus.ReadyForPickup, "ready-to-ship"],
    [SellerOrderStatus.Shipped, "shipped"],
    [SellerOrderStatus.Delivered, "delivered"],
    [SellerOrderStatus.PickedUp, "delivered"],
    [SellerOrderStatus.Canceled, "canceled"],
    [SellerOrderStatus.PickupOrderCanceled, "canceled"],
    [SellerOrderStatus.ShippedOrderCanceled, "canceled"],
    [SellerOrderStatus.Unknown, "unknown"],
  ] as const)("maps %s into the %s lifecycle", (status, lifecycle) => {
    expect(tcgplayerLifecycle(status)).toBe(lifecycle);
  });

  it("registers the configured connection with only its declared facets and read-only health", async () => {
    const client = fakeClient();
    const connectionRegistry = registry(client);
    const connection = connectionRegistry.require(CONNECTION_ID);

    expect(connection.descriptor).toEqual({
      connectionId: CONNECTION_ID,
      providerId: "tcgplayer",
      providerLabel: "TCGplayer",
      connectionLabel: "Primary seller",
    });
    expect(Object.keys(connection.facets).sort()).toEqual([
      "catalogMetadata",
      "fulfillment",
      "nativeDocuments",
      "orderDetails",
      "orderPages",
      "pullLines",
    ]);
    expect(client.searchOrders).not.toHaveBeenCalled();
    expect(client.getOrder).not.toHaveBeenCalled();
    await expect(
      new ConnectionHealthService(connectionRegistry, {
        now: () => NOW,
      }).check(CONNECTION_ID),
    ).resolves.toEqual({
      state: "connected",
      checkedAt: NOW.toISOString(),
    });
  });

  it("reports an environment-backed connection without secrets as not configured", async () => {
    const connectionRegistry = new MarketplaceConnectionRegistry({
      adapters: new ProviderAdapterRegistry([
        createTcgplayerAdapterFactory({ timezoneOffsetMinutes: 300 }),
      ]),
      connections: {
        [CONNECTION_ID]: {
          providerId: "tcgplayer",
          enabled: true,
          label: "Primary seller",
          settings: {
            authCookieEnv: "TCGPLAYER_AUTH_COOKIE",
            sellerKeyEnv: "TCGPLAYER_SELLER_KEY",
            pageSize: 100,
            maximumPages: 100,
          },
        },
      },
      secrets: { get: () => undefined },
      now: () => NOW,
    });

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
  });

  it("registers tcgplayer-main from the authoritative application configuration", () => {
    const connectionRegistry = createMarketplaceConnectionRegistry(
      appConfig({ timezoneOffsetMinutes: 300 }),
      {
        TCGPLAYER_AUTH_COOKIE: "synthetic-cookie",
        TCGPLAYER_SELLER_KEY: "synthetic-seller-key",
      },
    );

    expect(connectionRegistry.require(CONNECTION_ID).descriptor).toMatchObject({
      connectionId: CONNECTION_ID,
      providerId: "tcgplayer",
    });
  });

  it("translates one ready-order page, money, actions, and its opaque cursor", async () => {
    const client = fakeClient();
    vi.mocked(client.searchOrders).mockResolvedValueOnce({
      totalOrders: 2,
      orders: [summary],
    });
    const pages = registry(client).facet(CONNECTION_ID, "orderPages");

    const page = await pages.readOrderPage({
      scope: "ready-to-ship",
      pageSize: 1,
    });

    expect(client.searchOrders).toHaveBeenCalledWith(
      expect.objectContaining({
        sellerKey: "synthetic-seller-key",
        statuses: [SellerOrderStatus.ReadyToShip],
        offset: 0,
        limit: 1,
      }),
      undefined,
    );
    expect(page.nextCursor).toBe("tcgplayer-offset-v1:1");
    expect(page.orders[0]).toMatchObject({
      ref: { connectionId: CONNECTION_ID, remoteId: summary.orderNumber },
      lifecycle: "ready-to-ship",
      totals: {
        subtotal: { currency: "USD", minorUnits: 1200 },
        shipping: { currency: "USD", minorUnits: 149 },
        total: { currency: "USD", minorUnits: 1349 },
      },
      actions: {
        "mark-shipped": { state: "available" },
        refund: { state: "unavailable", reason: "provider-unsupported" },
      },
    });

    vi.mocked(client.searchOrders).mockResolvedValueOnce({
      totalOrders: 1,
      orders: [],
    });
    const cursor = page.nextCursor;
    if (cursor === undefined)
      throw new Error("Expected a continuation cursor.");
    await pages.readOrderPage({
      scope: "all",
      since: "2026-05-25T12:00:00.000Z",
      cursor,
      pageSize: 1,
    });
    expect(client.searchOrders).toHaveBeenLastCalledWith(
      expect.objectContaining({
        searchRange: "LastThreeMonths",
        offset: 1,
      }),
      undefined,
    );
  });

  it("normalizes detail into qualified lines, exact SKU identity, address, tax, and entity actions", async () => {
    const orders = registry(fakeClient()).facet(CONNECTION_ID, "orderDetails");

    const order = await orders.getOrder({
      connectionId: CONNECTION_ID,
      remoteId: summary.orderNumber,
    });

    expect(order).toMatchObject({
      ref: { connectionId: CONNECTION_ID, remoteId: summary.orderNumber },
      shippingAddress: detail.shippingAddress,
      totals: {
        tax: { currency: "USD", minorUnits: 83 },
        total: { currency: "USD", minorUnits: 1432 },
      },
      lines: [
        {
          lineKey: "456",
          quantity: 2,
          catalogIdentities: [
            {
              namespace: "tcgplayer.sku",
              value: "456",
              precision: "exact-variant",
            },
            {
              namespace: "tcgplayer.product",
              value: "123",
              precision: "product",
            },
          ],
        },
      ],
      trackingNumbers: ["SYNTHETIC-TRACKING"],
    });
    expect(order.actions["mark-shipped"]).toEqual({ state: "available" });
  });

  it("routes fulfillment mutations by qualified ref and validates returned identity", async () => {
    const client = fakeClient();
    const fulfillment = registry(client).facet(CONNECTION_ID, "fulfillment");
    const ref = { connectionId: CONNECTION_ID, remoteId: summary.orderNumber };

    await expect(
      fulfillment.addTracking({ ref, trackingNumber: " SYNTHETIC-TRACKING " }),
    ).resolves.toEqual({ ref, outcome: "applied" });
    expect(client.detectCarrier).toHaveBeenCalledWith(
      "SYNTHETIC-TRACKING",
      undefined,
    );
    expect(client.addOrderTracking).toHaveBeenCalledWith(
      {
        sellerKey: "synthetic-seller-key",
        orderNumber: summary.orderNumber,
        carrier: "USPS",
        trackingNumber: "SYNTHETIC-TRACKING",
      },
      undefined,
    );
    await expect(fulfillment.markShipped({ ref })).resolves.toEqual({
      ref,
      outcome: "already-applied",
    });
  });

  it("normalizes native packing slips and one exact pull allocation per order", async () => {
    const connectionRegistry = registry(fakeClient());
    const ref = { connectionId: CONNECTION_ID, remoteId: summary.orderNumber };

    const document = await connectionRegistry
      .facet(CONNECTION_ID, "nativeDocuments")
      .getDocument({ ref, kind: "packing-slip" });
    expect(document).toMatchObject({
      ref,
      kind: "packing-slip",
      mediaType: "application/pdf",
      fileName: "packing-slip.pdf",
    });

    const lines = await connectionRegistry
      .facet(CONNECTION_ID, "pullLines")
      .getPullLines([ref]);
    expect(lines).toEqual([
      expect.objectContaining({
        description: "Synthetic Card",
        quantity: 2,
        catalogIdentities: [
          {
            namespace: "tcgplayer.sku",
            value: "456",
            precision: "exact-variant",
          },
          {
            namespace: "tcgplayer.product",
            value: "123",
            precision: "product",
          },
        ],
        allocations: [{ order: ref, lineKey: "456", quantity: 2 }],
      }),
    ]);
  });

  it("recovers the catalog product identity from order detail when the pull-sheet image URL is not usable", async () => {
    const client = fakeClient();
    const secondOrderNumber = "synthetic-order-2";
    const pullSheet = await client.exportPullSheet({
      orderNumbers: [summary.orderNumber],
      timezoneOffsetMinutes: 0,
    });
    vi.mocked(client.exportPullSheet).mockResolvedValue({
      ...pullSheet,
      orderNumbers: [summary.orderNumber, secondOrderNumber],
      rows: pullSheet.rows.map((row) => ({
        ...row,
        productLine: "Magic",
        mainPhotoUrl: "https://cdn.example.test/card-image",
        orderQuantity: 4,
        orderAllocations: [
          { orderNumber: summary.orderNumber, quantity: 2 },
          { orderNumber: secondOrderNumber, quantity: 2 },
        ],
      })),
    });
    vi.mocked(client.getOrder).mockClear();
    const pullLines = registry(client).facet(CONNECTION_ID, "pullLines");
    const refs = [
      { connectionId: CONNECTION_ID, remoteId: summary.orderNumber },
      { connectionId: CONNECTION_ID, remoteId: secondOrderNumber },
    ];
    const lines = await pullLines.getPullLines(refs);
    const cachedLines = await pullLines.getPullLines(refs);

    expect(lines[0]?.catalogIdentities).toContainEqual({
      namespace: "tcgplayer.product",
      value: "123",
      precision: "product",
    });
    expect(cachedLines[0]?.catalogIdentities).toEqual(
      lines[0]?.catalogIdentities,
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]?.attributes.productLine).toBe("Magic: The Gathering");
    expect(client.getOrder).toHaveBeenCalledWith(
      summary.orderNumber,
      undefined,
    );
    expect(client.getOrder).toHaveBeenCalledTimes(1);
  });

  it("batches optional catalog metadata behind the normalized facet", async () => {
    const client = fakeClient();
    vi.mocked(client.searchMarketplaceProducts).mockResolvedValueOnce({
      totalProducts: 1,
      products: [
        {
          productId: 123,
          productName: "Synthetic Card",
          productLineName: "Magic: The Gathering",
          setName: "Synthetic Set",
          rarityName: "Rare",
          colors: ["Blue", "Red"],
          cardTypes: ["Creature"],
          attributes: { power: ["3"], toughness: ["3"] },
          marketPrice: 6,
          totalListings: 1,
          listings: [],
        },
      ],
    });
    const connectionRegistry = registry(client);

    const catalogMetadata = connectionRegistry.facet(
      CONNECTION_ID,
      "catalogMetadata",
    );
    const identities = [
      {
        namespace: "tcgplayer.product",
        value: "123",
        precision: "product" as const,
      },
    ];
    await expect(
      catalogMetadata.readCatalogMetadata(identities),
    ).resolves.toEqual({
      "tcgplayer.product:123": {
        color: ["Blue", "Red"],
        cardType: ["Creature"],
        power: ["3"],
        toughness: ["3"],
      },
    });
    await expect(
      catalogMetadata.readCatalogMetadata(identities),
    ).resolves.toEqual({
      "tcgplayer.product:123": {
        color: ["Blue", "Red"],
        cardType: ["Creature"],
        power: ["3"],
        toughness: ["3"],
      },
    });
    expect(client.searchMarketplaceProducts).toHaveBeenCalledWith(
      { productIds: [123], channelId: 0, offset: 0, limit: 1 },
      undefined,
    );
    expect(client.searchMarketplaceProducts).toHaveBeenCalledTimes(1);
  });

  it("fails closed for foreign refs, malformed cursors, wrong returned IDs, and unknown settings", async () => {
    const client = fakeClient();
    const connectionRegistry = registry(client);
    await expect(
      connectionRegistry.facet(CONNECTION_ID, "orderDetails").getOrder({
        connectionId: "other-main",
        remoteId: summary.orderNumber,
      }),
    ).rejects.toThrow("another marketplace connection");
    await expect(
      connectionRegistry.facet(CONNECTION_ID, "orderPages").readOrderPage({
        scope: "all",
        cursor: "1",
        pageSize: 100,
      }),
    ).rejects.toThrow("cursor");
    vi.mocked(client.getPackingSlip).mockResolvedValueOnce({
      bytes: new Uint8Array([1]),
      contentType: "application/pdf",
      fileName: "packing-slip.pdf",
      orderNumbers: ["wrong-order"],
    });
    await expect(
      connectionRegistry.facet(CONNECTION_ID, "nativeDocuments").getDocument({
        ref: { connectionId: CONNECTION_ID, remoteId: summary.orderNumber },
        kind: "packing-slip",
      }),
    ).rejects.toThrow("invalid packing-slip");
    expect(() =>
      parseTcgplayerAdapterSettings({
        authCookieEnv: "TCGPLAYER_AUTH_COOKIE",
        sellerKeyEnv: "TCGPLAYER_SELLER_KEY",
        pageSize: 100,
        maximumPages: 100,
        providerBranch: true,
      }),
    ).toThrow("unknown fields");
  });
});
