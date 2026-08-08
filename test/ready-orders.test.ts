import { describe, expect, it, vi } from "vitest";
import { TcgplayerReadyOrderSource } from "../src/ready-orders.js";

const order = {
  orderNumber: "synthetic-order-1",
  orderDate: "2026-08-07T11:00:00.000Z",
  orderChannel: "Marketplace",
  orderStatus: "Ready to Ship",
  orderStatusCode: "ReadyToShip" as const,
  buyerName: "Synthetic Buyer",
  shippingType: "Standard",
  productAmount: 10,
  shippingAmount: 1.49,
  totalAmount: 11.49,
  buyerPaid: true,
  orderFulfillment: "Seller",
};

describe("ready-order source", () => {
  it("keeps a confirmed shipment out while TCGplayer converges", async () => {
    const searchOrders = vi.fn(() =>
      Promise.resolve({ totalOrders: 1, orders: [order] }),
    );
    const source = new TcgplayerReadyOrderSource({
      client: { searchOrders },
      sellerKey: "synthetic-seller",
      pageSize: 100,
      maximumPages: 5,
      now: () => new Date("2026-08-07T12:00:00.000Z"),
    });

    await expect(source.refresh()).resolves.toMatchObject({
      orders: [expect.objectContaining({ orderNumber: order.orderNumber })],
    });
    source.remove(order.orderNumber);
    expect(source.snapshot()?.orders).toEqual([]);

    await expect(source.refresh()).resolves.toMatchObject({ orders: [] });
    expect(searchOrders).toHaveBeenCalledTimes(2);
  });
});
