import { describe, expect, it } from "vitest";
import { TcgplayerOrderProvider } from "../src/index.js";

const firstOrder = "00000000000000000";
const secondOrder = "00000000000000001";

function summary(orderNumber: string) {
  return {
    orderNumber,
    orderDate: "2026-01-02T03:04:05.000Z",
    orderChannel: "Marketplace",
    orderStatus: "ReadyToShip",
    buyerName: "Example Buyer",
    shippingType: "Standard",
    productAmount: 12.5,
    shippingAmount: 1.25,
    totalAmount: 13.75,
    buyerPaid: true,
    orderFulfillment: "Seller",
  };
}

function detail(orderNumber: string) {
  return {
    createdAt: "2026-01-02T03:04:05.000Z",
    status: "ReadyToShip",
    orderChannel: "Marketplace",
    orderFulfillment: "Seller",
    orderNumber,
    sellerName: "Example Seller",
    buyerName: "Example Buyer",
    paymentType: "Marketplace",
    pickupStatus: "NotApplicable",
    shippingType: "Standard",
    estimatedDeliveryDate: "2026-01-09T00:00:00.000Z",
    transaction: {
      productAmount: 12.5,
      shippingAmount: 1.25,
      grossAmount: 13.75,
      feeAmount: 1.5,
      netAmount: 12.25,
      directFeeAmount: 0,
      taxes: [],
    },
    shippingAddress: {
      recipientName: "Example Buyer",
      addressOne: "123 Example Street",
      city: "Example City",
      territory: "IL",
      country: "US",
      postalCode: "00000",
    },
    products: [
      {
        name: "Example Card",
        unitPrice: 12.5,
        extendedPrice: 12.5,
        quantity: 1,
        url: "https://example.invalid/card",
        productId: "100000",
        skuId: "200000",
      },
    ],
    refundStatus: "None",
    trackingNumbers: [],
    allowedActions: ["View"],
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

describe("TCGplayer application adapter", () => {
  it("pages through the complete ready-to-ship queue", async () => {
    const bodies: unknown[] = [];
    const responses = [
      jsonResponse({ totalOrders: 2, orders: [summary(firstOrder)] }),
      jsonResponse({ totalOrders: 2, orders: [summary(secondOrder)] }),
    ];
    const provider = new TcgplayerOrderProvider({
      authCookie: "synthetic-cookie",
      sellerKey: "synthetic-seller",
      pageSize: 1,
      maximumPages: 5,
      timezoneOffsetMinutes: 360,
      requestDelayMs: 0,
      fetch: (_input, init) => {
        if (typeof init?.body !== "string") {
          throw new Error("Synthetic request body must be JSON text.");
        }
        bodies.push(JSON.parse(init.body) as unknown);
        const response = responses.shift();
        if (response === undefined) throw new Error("No response queued");
        return Promise.resolve(response);
      },
    });

    await expect(provider.discoverReadyToShip()).resolves.toEqual([
      { id: firstOrder, status: "ReadyToShip" },
      { id: secondOrder, status: "ReadyToShip" },
    ]);
    expect(bodies).toMatchObject([
      { from: 0, size: 1 },
      { from: 1, size: 1 },
    ]);
  });

  it("normalizes a confirmed private order into the domain", async () => {
    const responses = [
      jsonResponse({ totalOrders: 1, orders: [summary(firstOrder)] }),
      jsonResponse(detail(firstOrder)),
    ];
    const provider = new TcgplayerOrderProvider({
      authCookie: "synthetic-cookie",
      sellerKey: "synthetic-seller",
      pageSize: 100,
      maximumPages: 5,
      timezoneOffsetMinutes: 360,
      requestDelayMs: 0,
      fetch: () => {
        const response = responses.shift();
        if (response === undefined) throw new Error("No response queued");
        return Promise.resolve(response);
      },
    });

    const order = await provider.confirmOrder(firstOrder);

    expect(order).toMatchObject({
      provider: "tcgplayer",
      id: firstOrder,
      totalAmount: 13.75,
      shippingAddress: { city: "Example City" },
      items: [{ name: "Example Card", quantity: 1 }],
    });
    expect(order).not.toHaveProperty("sellerName");
  });

  it("returns only a validated packing-slip document for the requested order", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
    const provider = new TcgplayerOrderProvider({
      authCookie: "synthetic-cookie",
      sellerKey: "synthetic-seller",
      pageSize: 100,
      maximumPages: 5,
      timezoneOffsetMinutes: 360,
      requestDelayMs: 0,
      fetch: () =>
        Promise.resolve(
          new Response(pdf, {
            headers: { "content-type": "application/pdf" },
          }),
        ),
    });

    await expect(provider.getPackingSlip(firstOrder)).resolves.toMatchObject({
      kind: "packing-slip",
      mediaType: "application/pdf",
      fileName: "packing-slip.pdf",
      bytes: pdf,
    });
  });
});
