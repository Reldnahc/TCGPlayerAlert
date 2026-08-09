import { describe, expect, it, vi } from "vitest";
import type { ConfirmedSellerOrder } from "tcgplayer-private-api";
import { OrderManagementService } from "../src/order-management.js";

const firstOrder = {
  orderNumber: "synthetic-order-1",
  orderDate: "2026-08-01T12:00:00.000Z",
  orderChannel: "Marketplace",
  orderStatus: "Ready to Ship",
  orderStatusCode: "ReadyToShip" as const,
  buyerName: "Synthetic Buyer",
  shippingType: "Standard",
  productAmount: 12,
  shippingAmount: 1.49,
  totalAmount: 13.49,
  buyerPaid: true,
  orderFulfillment: "Seller",
};

const secondOrder = {
  ...firstOrder,
  orderNumber: "synthetic-order-2",
  orderStatus: "Shipped - In Transit",
  orderStatusCode: "Shipped" as const,
  buyerName: "Example Customer",
};

const pullSheetRow = {
  productLine: "Magic: The Gathering",
  productName: "Synthetic Card",
  condition: "Near Mint",
  number: "42",
  setName: "Synthetic Set",
  rarity: "Rare",
  quantity: 10,
  mainPhotoUrl: "https://product-images.tcgplayer.com/fit-in/200x279/123.jpg",
  setReleaseDate: "2026-01-01",
  skuId: "456",
  orderQuantity: 2,
};

function client() {
  return {
    searchOrders: vi.fn(),
    confirmOrder: vi.fn((): Promise<ConfirmedSellerOrder> =>
      Promise.resolve({
        summary: firstOrder,
        order: {
          createdAt: firstOrder.orderDate,
          status: firstOrder.orderStatus,
          statusCode: firstOrder.orderStatusCode,
          orderChannel: firstOrder.orderChannel,
          orderFulfillment: firstOrder.orderFulfillment,
          orderNumber: firstOrder.orderNumber,
          sellerName: "Synthetic Seller",
          buyerName: firstOrder.buyerName,
          paymentType: "CreditCard",
          pickupStatus: "",
          shippingType: firstOrder.shippingType,
          estimatedDeliveryDate: "2026-08-08T12:00:00.000Z",
          transaction: {
            productAmount: firstOrder.productAmount,
            shippingAmount: firstOrder.shippingAmount,
            grossAmount: firstOrder.totalAmount,
            feeAmount: 1,
            netAmount: 12.49,
            directFeeAmount: 0,
            taxes: [],
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
              url: "https://www.example.test/product/123",
              productId: "123",
              skuId: "456",
            },
          ],
          refunds: [],
          refundStatus: "None",
          refundCapabilities: { full: true, partial: true },
          trackingNumbers: [],
          allowedActions: [
            "AddTracking",
            "MarkShipped",
            "FullRefund",
            "PartialRefund",
          ],
        },
      }),
    ),
    getPackingSlip: vi.fn(() =>
      Promise.resolve({
        bytes: new Uint8Array([37, 80, 68, 70]),
        contentType: "application/pdf" as const,
        fileName: "packing-slip.pdf",
        orderNumbers: [firstOrder.orderNumber],
      }),
    ),
    exportPullSheet: vi.fn(
      (input: { readonly orderNumbers: readonly string[] }) =>
        Promise.resolve({
          text: "synthetic pull sheet",
          contentType: "text/csv" as const,
          fileName: "pull-sheet.csv" as const,
          orderNumbers: input.orderNumbers,
          rows: [pullSheetRow],
        }),
    ),
    searchMarketplaceProducts: vi.fn(() =>
      Promise.resolve({
        totalProducts: 1,
        products: [
          {
            productId: 123,
            productName: "Synthetic Card",
            productLineName: "Magic: The Gathering",
            setName: "Synthetic Set",
            rarityName: "Rare",
            colors: ["Blue"],
            marketPrice: 6,
            totalListings: 1,
            listings: [],
          },
        ],
      }),
    ),
    detectCarrier: vi.fn(() => Promise.resolve({ carrier: "USPS" })),
    addOrderTracking: vi.fn(() =>
      Promise.resolve({
        orderNumber: firstOrder.orderNumber,
        outcome: "applied" as const,
      }),
    ),
    markOrdersShipped: vi.fn(() =>
      Promise.resolve({
        updatedOrderNumbers: [firstOrder.orderNumber],
        alreadyShippedOrderNumbers: [],
        errors: [],
      }),
    ),
    getOrderRefundOptions: vi.fn(() =>
      Promise.resolve({
        origins: [{ name: "Seller initiated", value: "SellerInitiated" }],
        reasons: [
          { name: "Inventory issue", value: "Product - Inventory Issue" },
        ],
      }),
    ),
    refundOrderFull: vi.fn(() =>
      Promise.resolve({
        orderNumber: firstOrder.orderNumber,
        refundType: "full" as const,
        outcome: "submitted" as const,
      }),
    ),
    refundOrderPartial: vi.fn(() =>
      Promise.resolve({
        orderNumber: firstOrder.orderNumber,
        refundType: "partial" as const,
        outcome: "submitted" as const,
      }),
    ),
  };
}

function service(
  fakeClient: ReturnType<typeof client>,
  options: {
    readonly liveMode?: () => Promise<boolean>;
    readonly pageSize?: number;
    readonly maximumPages?: number;
    readonly executePrint?: (
      orderNumber: string,
      actionType: "print-address-label" | "print-packing-slip",
    ) => Promise<void>;
    readonly onShipmentAccepted?: (orderNumber: string) => void;
  } = {},
) {
  return new OrderManagementService({
    client: fakeClient,
    sellerKey: "synthetic-seller",
    pageSize: 1,
    maximumPages: 10,
    timezoneOffsetMinutes: 300,
    now: () => new Date("2026-08-04T12:00:00.000Z"),
    ...options,
  });
}

describe("order management", () => {
  it("pages, normalizes, sorts, and briefly caches order lists", async () => {
    const fakeClient = client();
    fakeClient.searchOrders
      .mockResolvedValueOnce({ totalOrders: 2, orders: [firstOrder] })
      .mockResolvedValueOnce({ totalOrders: 2, orders: [secondOrder] });
    const orders = service(fakeClient);

    const first = await orders.listOrders("all");
    const cached = await orders.listOrders("all");

    expect(first).toEqual({
      fetchedAt: "2026-08-04T12:00:00.000Z",
      orders: [
        {
          orderNumber: firstOrder.orderNumber,
          buyerName: firstOrder.buyerName,
          orderDate: firstOrder.orderDate,
          status: firstOrder.orderStatus,
          statusCode: "ReadyToShip",
          canMarkShipped: true,
          shippingType: firstOrder.shippingType,
          productAmount: 12,
          shippingAmount: 1.49,
          totalAmount: 13.49,
        },
        expect.objectContaining({
          orderNumber: secondOrder.orderNumber,
          status: "Shipped - In Transit",
          statusCode: "Shipped",
          canMarkShipped: false,
        }),
      ],
    });
    expect(cached).toBe(first);
    expect(fakeClient.searchOrders).toHaveBeenCalledTimes(2);
    expect(fakeClient.searchOrders.mock.calls[0]?.[0]).toMatchObject({
      searchRange: "LastThreeMonths",
      sort: [{ field: "orderDate", direction: "descending" }],
      offset: 0,
      limit: 1,
    });
  });

  it("requests only ready-to-ship orders for the dashboard", async () => {
    const fakeClient = client();
    fakeClient.searchOrders.mockResolvedValue({
      totalOrders: 1,
      orders: [firstOrder],
    });

    await service(fakeClient).listOrders("ready-to-ship");

    expect(fakeClient.searchOrders).toHaveBeenCalledWith(
      expect.objectContaining({ statuses: ["ReadyToShip"] }),
      undefined,
    );
  });

  it("returns a seller-confirmed order detail and briefly caches it", async () => {
    const fakeClient = client();
    const orders = service(fakeClient);

    const first = await orders.getOrder(firstOrder.orderNumber);
    const cached = await orders.getOrder(firstOrder.orderNumber);
    const refreshed = await orders.getOrder(firstOrder.orderNumber, {
      force: true,
    });

    expect(first).toMatchObject({
      orderNumber: firstOrder.orderNumber,
      status: "Ready to Ship",
      statusCode: "ReadyToShip",
      canMarkShipped: true,
      fetchedAt: "2026-08-04T12:00:00.000Z",
      shippingAddress: { addressOne: "123 Example Street" },
    });
    expect(first).not.toHaveProperty("allowedActions");
    expect(cached).toBe(first);
    expect(refreshed).not.toBe(first);
    expect(fakeClient.confirmOrder).toHaveBeenCalledTimes(2);
  });

  it("builds and caches a master pull list that combines ready-order SKUs", async () => {
    const fakeClient = client();
    const anotherReadyOrder = {
      ...firstOrder,
      orderNumber: "synthetic-order-2",
      buyerName: "Example Customer",
    };
    fakeClient.searchOrders.mockResolvedValue({
      totalOrders: 2,
      orders: [firstOrder, anotherReadyOrder],
    });
    fakeClient.exportPullSheet.mockResolvedValue({
      text: "synthetic pull sheet",
      contentType: "text/csv",
      fileName: "pull-sheet.csv",
      orderNumbers: [firstOrder.orderNumber, anotherReadyOrder.orderNumber],
      rows: [pullSheetRow, { ...pullSheetRow, orderQuantity: 1 }],
    });
    const orders = service(fakeClient);

    const first = await orders.getMasterPullList();
    const cached = await orders.getMasterPullList();

    expect(first).toEqual({
      orderCount: 2,
      totalQuantity: 3,
      fetchedAt: "2026-08-04T12:00:00.000Z",
      rows: [
        expect.objectContaining({
          productId: 123,
          productName: "Synthetic Card",
          orderQuantity: 3,
          metadata: [{ label: "Color", values: ["Blue"] }],
        }),
      ],
    });
    expect(cached).toBe(first);
    expect(fakeClient.searchOrders).toHaveBeenCalledOnce();
    expect(fakeClient.confirmOrder).not.toHaveBeenCalled();
    expect(fakeClient.exportPullSheet).toHaveBeenCalledOnce();
    expect(fakeClient.exportPullSheet).toHaveBeenCalledWith(
      {
        orderNumbers: [firstOrder.orderNumber, anotherReadyOrder.orderNumber],
        timezoneOffsetMinutes: 300,
      },
      undefined,
    );
    expect(fakeClient.searchMarketplaceProducts).toHaveBeenCalledWith(
      { productIds: [123], channelId: 0, offset: 0, limit: 1 },
      undefined,
    );
  });

  it("keeps master pull-sheet exports within the 500-order request limit", async () => {
    const fakeClient = client();
    const readyOrders = Array.from({ length: 501 }, (_, index) => ({
      ...firstOrder,
      orderNumber: `synthetic-order-${String(index + 1)}`,
    }));
    fakeClient.searchOrders
      .mockResolvedValueOnce({
        totalOrders: readyOrders.length,
        orders: readyOrders.slice(0, 500),
      })
      .mockResolvedValueOnce({
        totalOrders: readyOrders.length,
        orders: readyOrders.slice(500),
      });

    const result = await service(fakeClient, {
      pageSize: 500,
      maximumPages: 2,
    }).getMasterPullList();

    expect(result.orderCount).toBe(501);
    expect(fakeClient.exportPullSheet).toHaveBeenCalledTimes(2);
    expect(
      fakeClient.exportPullSheet.mock.calls[0]?.[0].orderNumbers,
    ).toHaveLength(500);
    expect(
      fakeClient.exportPullSheet.mock.calls[1]?.[0].orderNumbers,
    ).toHaveLength(1);
  });

  it("does not export unexpected non-ready orders returned by the ready search", async () => {
    const fakeClient = client();
    fakeClient.searchOrders.mockResolvedValue({
      totalOrders: 1,
      orders: [secondOrder],
    });

    await expect(service(fakeClient).getMasterPullList()).resolves.toEqual({
      orderCount: 0,
      rows: [],
      totalQuantity: 0,
      fetchedAt: "2026-08-04T12:00:00.000Z",
    });
    expect(fakeClient.exportPullSheet).not.toHaveBeenCalled();
    expect(fakeClient.searchMarketplaceProducts).not.toHaveBeenCalled();
  });

  it("updates the shared ready-order source after shipment is accepted", async () => {
    const fakeClient = client();
    const onShipmentAccepted = vi.fn();
    const orders = service(fakeClient, { onShipmentAccepted });

    await orders.markShipped(firstOrder.orderNumber);
    expect(onShipmentAccepted).toHaveBeenCalledWith(firstOrder.orderNumber);
  });

  it("downloads packing slips and performs explicit fulfillment actions", async () => {
    const fakeClient = client();
    const executePrint = vi.fn(() => Promise.resolve());
    const orders = service(fakeClient, { executePrint });

    await expect(
      orders.getPackingSlip(firstOrder.orderNumber),
    ).resolves.toEqual({
      fileName: "packing-slip.pdf",
      bytes: new Uint8Array([37, 80, 68, 70]),
    });
    await orders.print(firstOrder.orderNumber, "print-address-label");
    await expect(
      orders.addTracking(firstOrder.orderNumber, "synthetic-tracking"),
    ).resolves.toEqual({
      orderNumber: firstOrder.orderNumber,
      carrier: "USPS",
      outcome: "applied",
    });
    await expect(orders.markShipped(firstOrder.orderNumber)).resolves.toEqual({
      orderNumber: firstOrder.orderNumber,
      outcome: "applied",
    });

    expect(executePrint).toHaveBeenCalledWith(
      firstOrder.orderNumber,
      "print-address-label",
      undefined,
    );
    expect(fakeClient.addOrderTracking).toHaveBeenCalledWith(
      {
        sellerKey: "synthetic-seller",
        orderNumber: firstOrder.orderNumber,
        carrier: "USPS",
        trackingNumber: "synthetic-tracking",
      },
      undefined,
    );
  });

  it("caches refund options and forwards an explicit confirmed refund request", async () => {
    const fakeClient = client();
    const orders = service(fakeClient);

    const options = await orders.getRefundOptions();
    const cached = await orders.getRefundOptions();
    const result = await orders.refundOrder(firstOrder.orderNumber, {
      type: "partial",
      origin: "SellerInitiated",
      reason: "Product - Inventory Issue",
      reasonText: "Synthetic refund explanation",
      shippingRefundAmount: 0.49,
      products: [{ skuId: "synthetic-sku", refundAmount: 2 }],
    });

    expect(cached).toBe(options);
    expect(fakeClient.getOrderRefundOptions).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      refundType: "partial",
      outcome: "submitted",
    });
    expect(fakeClient.refundOrderPartial).toHaveBeenCalledWith(
      {
        sellerKey: "synthetic-seller",
        orderNumber: firstOrder.orderNumber,
        origin: "SellerInitiated",
        reason: "Product - Inventory Issue",
        reasonText: "Synthetic refund explanation",
        shippingRefundAmount: 0.49,
        products: [{ skuId: "synthetic-sku", refundAmount: 2 }],
      },
      undefined,
    );
  });

  it("serializes refund submissions for the same order", async () => {
    const fakeClient = client();
    let resolveRefund!: (value: {
      readonly orderNumber: string;
      readonly refundType: "full";
      readonly outcome: "submitted";
    }) => void;
    fakeClient.refundOrderFull.mockImplementation(
      () =>
        new Promise((resolvePromise) => {
          resolveRefund = resolvePromise;
        }),
    );
    const orders = service(fakeClient);
    const input = {
      type: "full" as const,
      origin: "SellerInitiated",
      reason: "Product - Inventory Issue",
      reasonText: "Synthetic refund explanation",
    };

    const first = orders.refundOrder(firstOrder.orderNumber, input);

    await expect(
      orders.refundOrder(firstOrder.orderNumber, input),
    ).rejects.toMatchObject({
      code: "REVIEW_REQUIRED",
      message: "A refund for this order is already being submitted.",
    });
    expect(fakeClient.refundOrderFull).toHaveBeenCalledOnce();

    resolveRefund({
      orderNumber: firstOrder.orderNumber,
      refundType: "full",
      outcome: "submitted",
    });
    await expect(first).resolves.toMatchObject({ outcome: "submitted" });
  });

  it("formats a seller-confirmed address for Pirate Ship without putting it in a URL", async () => {
    const fakeClient = client();
    const orders = service(fakeClient);

    const prepared = await orders.preparePirateShip(firstOrder.orderNumber);
    const cached = await orders.preparePirateShip(firstOrder.orderNumber);

    expect(prepared).toEqual({
      url: "https://ship.pirateship.com/ship/single",
      pasteAddress:
        "Synthetic Buyer\n123 Example Street\nApt 4\nExample City, IL 00000\nUS",
    });
    expect(prepared.url).not.toContain("Synthetic");
    expect(cached).toBe(prepared);
    expect(fakeClient.confirmOrder).toHaveBeenCalledOnce();
    expect(fakeClient.confirmOrder).toHaveBeenCalledWith(
      {
        sellerKey: "synthetic-seller",
        orderNumber: firstOrder.orderNumber,
      },
      undefined,
    );
  });

  it("invalidates cached orders before an ambiguous mutation", async () => {
    const fakeClient = client();
    fakeClient.searchOrders.mockResolvedValue({
      totalOrders: 1,
      orders: [firstOrder],
    });
    fakeClient.addOrderTracking.mockRejectedValue(
      new Error("Synthetic ambiguous result"),
    );
    const orders = service(fakeClient);
    await orders.listOrders("ready-to-ship");
    await orders.getOrder(firstOrder.orderNumber);

    await expect(
      orders.addTracking(firstOrder.orderNumber, "synthetic-tracking"),
    ).rejects.toThrow("Synthetic ambiguous result");
    await orders.listOrders("ready-to-ship");
    await orders.getOrder(firstOrder.orderNumber);

    expect(fakeClient.searchOrders).toHaveBeenCalledTimes(2);
    expect(fakeClient.confirmOrder).toHaveBeenCalledTimes(2);
  });

  it("never substitutes a local status after a shipment mutation", async () => {
    const fakeClient = client();
    fakeClient.searchOrders.mockResolvedValue({
      totalOrders: 1,
      orders: [firstOrder],
    });
    const orders = service(fakeClient);

    await expect(orders.listOrders("ready-to-ship")).resolves.toMatchObject({
      orders: [
        expect.objectContaining({ orderNumber: firstOrder.orderNumber }),
      ],
    });
    await orders.markShipped(firstOrder.orderNumber);

    await expect(orders.listOrders("all")).resolves.toMatchObject({
      orders: [
        expect.objectContaining({
          orderNumber: firstOrder.orderNumber,
          status: "Ready to Ship",
          statusCode: "ReadyToShip",
          canMarkShipped: true,
        }),
      ],
    });
    expect(fakeClient.searchOrders).toHaveBeenCalledTimes(2);
  });
});
