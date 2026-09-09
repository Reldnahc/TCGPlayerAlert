import { describe, expect, it } from "vitest";
import {
  ORDER_ACTION_IDS,
  addMoney,
  parseCatalogIdentity,
  parseConnectionDescriptor,
  parseConnectionHealth,
  parseMoney,
  parseOrderDetail,
  parseOrderPage,
  parseOrderSummary,
  parseProviderIssue,
  type ActionAvailability,
  type OrderActionId,
} from "../src/marketplaces/contracts.js";
import { MarketplaceValidationError } from "../src/marketplaces/identity.js";

describe("provider-neutral marketplace contracts", () => {
  it("validates descriptor, health, catalog identity, and safe provider issues", () => {
    expect(
      parseConnectionDescriptor({
        connectionId: "third-store",
        providerId: "third-marketplace",
        providerLabel: "Third Marketplace",
        connectionLabel: "Secondary store",
      }),
    ).toEqual({
      connectionId: "third-store",
      providerId: "third-marketplace",
      providerLabel: "Third Marketplace",
      connectionLabel: "Secondary store",
    });
    expect(
      parseConnectionHealth({
        state: "degraded",
        checkedAt: "2026-08-24T12:00:00.000Z",
        issueCode: "RATE_LIMITED",
        retryable: true,
      }),
    ).toMatchObject({ state: "degraded", retryable: true });
    expect(
      parseCatalogIdentity({
        namespace: "example.sku",
        value: "variant-100",
        precision: "exact-variant",
      }),
    ).toMatchObject({ namespace: "example.sku", precision: "exact-variant" });
    expect(
      parseProviderIssue({
        connectionId: "third-store",
        operation: "list-orders",
        code: "REMOTE_UNAVAILABLE",
        retryable: true,
      }),
    ).toMatchObject({ operation: "list-orders", retryable: true });
  });

  it("validates normalized summaries, details, and pages", () => {
    const summary = normalizedSummary();
    const detail = {
      ...summary,
      shippingAddress: {
        recipientName: "Example Recipient",
        addressOne: "123 Example Street",
        city: "Example City",
        territory: "IL",
        country: "US",
        postalCode: "00000",
      },
      lines: [
        {
          lineKey: "provider-line-100",
          description: "Example Card",
          quantity: 2,
          unitPrice: { currency: "USD", minorUnits: 600 },
          lineTotal: { currency: "USD", minorUnits: 1200 },
          attributes: {
            condition: "Near Mint",
            language: "English",
            finish: "Non-foil",
          },
          catalogIdentities: [
            {
              namespace: "example.sku",
              value: "variant-100",
              precision: "exact-variant",
            },
          ],
        },
      ],
      trackingNumbers: [],
    };

    expect(parseOrderSummary(summary)).toEqual(summary);
    expect(parseOrderDetail(detail)).toEqual(detail);
    expect(
      parseOrderPage({ orders: [summary], nextCursor: "page-two" }),
    ).toEqual({
      orders: [summary],
      nextCursor: "page-two",
    });
  });

  it("uses safe integer minor units and forbids mixed-currency arithmetic", () => {
    expect(parseMoney({ currency: "USD", minorUnits: 125 })).toEqual({
      currency: "USD",
      minorUnits: 125,
    });
    expect(
      addMoney(
        { currency: "USD", minorUnits: 125 },
        { currency: "USD", minorUnits: 75 },
      ),
    ).toEqual({ currency: "USD", minorUnits: 200 });
    expect(() => parseMoney({ currency: "usd", minorUnits: 125 })).toThrow(
      MarketplaceValidationError,
    );
    expect(() => parseMoney({ currency: "USD", minorUnits: 1.5 })).toThrow(
      MarketplaceValidationError,
    );
    expect(() =>
      addMoney(
        { currency: "USD", minorUnits: 1 },
        { currency: "EUR", minorUnits: 1 },
      ),
    ).toThrow(MarketplaceValidationError);
  });

  it("rejects incomplete actions, duplicate line keys, and mixed currencies", () => {
    const summary = normalizedSummary();
    const incompleteActions = { ...summary.actions } as Record<
      string,
      ActionAvailability | undefined
    >;
    Reflect.deleteProperty(incompleteActions, "refund");
    expect(() =>
      parseOrderSummary({ ...summary, actions: incompleteActions }),
    ).toThrow(MarketplaceValidationError);

    const line = {
      lineKey: "line-100",
      description: "Example Card",
      quantity: 1,
      unitPrice: { currency: "USD", minorUnits: 100 },
      lineTotal: { currency: "USD", minorUnits: 100 },
      attributes: {},
      catalogIdentities: [],
    };
    const baseDetail = {
      ...summary,
      shippingAddress: {
        recipientName: "Example Recipient",
        addressOne: "123 Example Street",
        city: "Example City",
        territory: "IL",
        country: "US",
        postalCode: "00000",
      },
      trackingNumbers: [],
    };
    expect(() =>
      parseOrderDetail({ ...baseDetail, lines: [line, line] }),
    ).toThrow(MarketplaceValidationError);
    expect(() =>
      parseOrderDetail({
        ...baseDetail,
        lines: [
          {
            ...line,
            unitPrice: { currency: "EUR", minorUnits: 100 },
            lineTotal: { currency: "EUR", minorUnits: 100 },
          },
        ],
      }),
    ).toThrow(MarketplaceValidationError);
  });
});

function normalizedSummary() {
  return {
    ref: { connectionId: "example-store", remoteId: "remote-100" },
    displayOrderNumber: "DISPLAY-100",
    buyerName: "Example Buyer",
    providerStatus: "Ready",
    providerStatusCode: "READY",
    lifecycle: "ready-to-ship" as const,
    createdAt: "2026-08-24T12:00:00.000Z",
    shippingMethod: "Standard",
    totals: {
      subtotal: { currency: "USD", minorUnits: 1200 },
      shipping: { currency: "USD", minorUnits: 125 },
      total: { currency: "USD", minorUnits: 1325 },
    },
    actions: Object.fromEntries(
      ORDER_ACTION_IDS.map((actionId) => [actionId, { state: "available" }]),
    ) as Record<OrderActionId, ActionAvailability>,
  };
}
