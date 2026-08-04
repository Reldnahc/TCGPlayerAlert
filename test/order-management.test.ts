import { describe, expect, it, vi } from "vitest";
import { OrderManagementService } from "../src/order-management.js";

const firstOrder = {
  orderNumber: "synthetic-order-1",
  orderDate: "2026-08-01T12:00:00.000Z",
  orderChannel: "Marketplace",
  orderStatus: "ReadyToShip",
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
  orderStatus: "Shipped",
  buyerName: "Example Customer",
};

function client() {
  return {
    searchOrders: vi.fn(),
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
          shippingType: firstOrder.shippingType,
          productAmount: 12,
          shippingAmount: 1.49,
          totalAmount: 13.49,
        },
        expect.objectContaining({ orderNumber: secondOrder.orderNumber }),
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

  it("blocks real printing and mutations while dry run is enabled", async () => {
    const fakeClient = client();
    const executePrint = vi.fn(() => Promise.resolve());
    const orders = service(fakeClient, {
      liveMode: () => Promise.resolve(false),
      executePrint,
    });

    await expect(
      orders.print(firstOrder.orderNumber, "print-packing-slip"),
    ).rejects.toThrow("Turn off dry run");
    await expect(
      orders.addTracking(firstOrder.orderNumber, "synthetic-tracking"),
    ).rejects.toThrow("Turn off dry run");
    await expect(orders.markShipped(firstOrder.orderNumber)).rejects.toThrow(
      "Turn off dry run",
    );
    expect(executePrint).not.toHaveBeenCalled();
    expect(fakeClient.addOrderTracking).not.toHaveBeenCalled();
    expect(fakeClient.markOrdersShipped).not.toHaveBeenCalled();
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
});
