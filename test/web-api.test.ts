// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  messagesPageDecoder,
  orderListDecoder,
  paymentsPageDecoder,
} from "../src/web/api-contracts.js";
import { requestJson, UiApiError, uiApi } from "../src/web/api.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockResponse(response: Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(response)),
  );
}

async function capturedError(operation: Promise<unknown>): Promise<UiApiError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(UiApiError);
    return error as UiApiError;
  }
  throw new Error("Expected the request to fail.");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser API response validation", () => {
  it("rejects an invalid nested order without exposing response values", async () => {
    mockResponse(
      jsonResponse({
        orders: [
          {
            orderNumber: "PRIVATE-ORDER-NUMBER",
            buyerName: "Private Buyer",
            orderDate: null,
            status: "Ready to Ship",
            statusCode: "ReadyToShip",
            canMarkShipped: true,
            shippingType: "Standard",
            productAmount: 1,
            shippingAmount: 1.49,
            totalAmount: 2.49,
          },
        ],
        fetchedAt: "2026-08-10T12:00:00.000Z",
      }),
    );

    const error = await capturedError(
      requestJson("/test/orders", orderListDecoder),
    );

    expect(error.code).toBe("INVALID_RESPONSE");
    expect(error.message).toContain("response.orders[0].orderDate");
    expect(error.message).not.toContain("PRIVATE-ORDER-NUMBER");
    expect(error.message).not.toContain("Private Buyer");
  });

  it("accepts absent legacy payment dates but rejects impossible dates", async () => {
    const payment = {
      estimatedArrivalDate: null,
      initiatedDate: null,
      ordersCount: 1,
      totalSales: 4,
      totalFees: 1,
      refundedOrders: 0,
      refundedFees: 0,
      adjustments: 0,
      amount: 3,
    };
    mockResponse(
      jsonResponse({
        experience: "legacy",
        page: 1,
        totalPages: 1,
        upcomingPayments: [payment],
        pastPayments: [],
        fetchedAt: "2026-08-10T12:00:00.000Z",
      }),
    );

    await expect(
      requestJson("/test/payments", paymentsPageDecoder),
    ).resolves.toMatchObject({ experience: "legacy" });

    mockResponse(
      jsonResponse({
        experience: "legacy",
        page: 1,
        totalPages: 1,
        upcomingPayments: [{ ...payment, estimatedArrivalDate: "2026-02-31" }],
        pastPayments: [],
        fetchedAt: "2026-08-10T12:00:00.000Z",
      }),
    );
    const error = await capturedError(
      requestJson("/test/payments", paymentsPageDecoder),
    );

    expect(error.message).toContain(
      "response.upcomingPayments[0].estimatedArrivalDate",
    );
  });

  it("rejects malformed message fields at the browser boundary", async () => {
    mockResponse(
      jsonResponse({
        page: 1,
        pageSize: 25,
        totalPages: 1,
        totalThreads: 1,
        unreadCount: 1,
        threads: [
          {
            threadId: 2,
            unreadMessageCount: 1,
            totalMessageCount: 1,
            senderDisplayName: "Buyer",
            receiverDisplayName: "Seller",
            subject: "Question",
            orderType: 123,
            orderNumber: "ORDER",
            orderStatus: "Ready to Ship",
            createdAt: "2026-08-10T12:00:00.000Z",
            deleted: false,
          },
        ],
        portalUrl: "https://sellerportal.tcgplayer.com/messages",
        fetchedAt: "2026-08-10T12:00:00.000Z",
      }),
    );

    const error = await capturedError(
      requestJson("/test/messages", messagesPageDecoder),
    );

    expect(error.code).toBe("INVALID_RESPONSE");
    expect(error.message).toContain("response.threads[0].orderType");
  });

  it("turns malformed JSON into a controlled API error", async () => {
    mockResponse(
      new Response("{not-json", {
        headers: { "content-type": "application/json" },
      }),
    );

    const error = await capturedError(
      requestJson("/test/orders", orderListDecoder),
    );

    expect(error).toMatchObject({
      code: "INVALID_RESPONSE",
      message: "The server returned malformed JSON.",
    });
  });

  it("does not trust malformed error metadata", async () => {
    mockResponse(
      jsonResponse(
        {
          code: { malicious: true },
          issues: "not-an-array",
          message: 123,
        },
        502,
      ),
    );

    const error = await capturedError(
      requestJson("/test/orders", orderListDecoder),
    );

    expect(error.code).toBeUndefined();
    expect(error.message).toBe("Request failed (502).");
  });

  it("validates a streamed repricing completion before returning it", async () => {
    mockResponse(
      new Response(
        `${JSON.stringify({ type: "complete", preview: { id: 123 } })}\n`,
        { headers: { "content-type": "application/x-ndjson" } },
      ),
    );

    const error = await capturedError(
      uiApi.repricingPreview(
        {
          minimumPrice: 0.25,
          conditionPolicy: "same",
          priceBasis: "delivered",
          adjustmentCents: 0,
          allowPriceIncreases: true,
          ranges: [],
        },
        false,
        vi.fn(),
      ),
    );

    expect(error.code).toBe("INVALID_RESPONSE");
    expect(error.message).toContain("response.id");
  });
});
