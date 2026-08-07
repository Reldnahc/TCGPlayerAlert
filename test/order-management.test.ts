import { describe, expect, it, vi } from "vitest";
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

function client() {
  return {
    searchOrders: vi.fn(),
    confirmOrder: vi.fn(() =>
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
          products: [],
          refundStatus: "None",
          trackingNumbers: [],
          allowedActions: ["AddTracking", "MarkShipped"],
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
  };
}

function service(
  fakeClient: ReturnType<typeof client>,
  options: {
    readonly liveMode?: () => Promise<boolean>;
    readonly executePrint?: (
      orderNumber: string,
      actionType: "print-address-label" | "print-packing-slip",
    ) => Promise<void>;
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

    await expect(
      orders.addTracking(firstOrder.orderNumber, "synthetic-tracking"),
    ).rejects.toThrow("Synthetic ambiguous result");
    await orders.listOrders("ready-to-ship");

    expect(fakeClient.searchOrders).toHaveBeenCalledTimes(2);
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
