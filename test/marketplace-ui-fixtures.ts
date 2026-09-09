import type {
  ActionAvailability,
  OrderActionId,
  OrderDetail,
  OrderLifecycle,
  OrderSummary,
} from "../src/marketplaces/contracts.js";

const AVAILABLE = { state: "available" } as const;
const UNSUPPORTED = {
  state: "unavailable",
  reason: "provider-unsupported",
} as const;

export function marketplaceActions(
  available: readonly OrderActionId[] = [
    "view-detail",
    "print-address-label",
    "packing-slip",
    "pirate-ship",
    "add-tracking",
    "mark-shipped",
    "refund",
  ],
): Readonly<Record<OrderActionId, ActionAvailability>> {
  const enabled = new Set(available);
  return {
    "view-detail": enabled.has("view-detail") ? AVAILABLE : UNSUPPORTED,
    "print-address-label": enabled.has("print-address-label")
      ? AVAILABLE
      : UNSUPPORTED,
    "packing-slip": enabled.has("packing-slip") ? AVAILABLE : UNSUPPORTED,
    "pirate-ship": enabled.has("pirate-ship") ? AVAILABLE : UNSUPPORTED,
    "add-tracking": enabled.has("add-tracking") ? AVAILABLE : UNSUPPORTED,
    "mark-shipped": enabled.has("mark-shipped") ? AVAILABLE : UNSUPPORTED,
    refund: enabled.has("refund") ? AVAILABLE : UNSUPPORTED,
  };
}

export interface MarketplaceOrderFixtureInput {
  readonly connectionId?: string;
  readonly remoteId: string;
  readonly displayOrderNumber?: string;
  readonly buyerName?: string;
  readonly createdAt?: string;
  readonly providerStatus?: string;
  readonly providerStatusCode?: string;
  readonly lifecycle?: OrderLifecycle;
  readonly shippingMethod?: string;
  readonly subtotalMinorUnits?: number;
  readonly shippingMinorUnits?: number;
  readonly totalMinorUnits?: number;
  readonly availableActions?: readonly OrderActionId[];
}

export function marketplaceOrder(
  input: MarketplaceOrderFixtureInput,
): OrderSummary {
  return {
    ref: {
      connectionId: input.connectionId ?? "tcgplayer-main",
      remoteId: input.remoteId,
    },
    displayOrderNumber: input.displayOrderNumber ?? input.remoteId,
    buyerName: input.buyerName ?? "Synthetic Buyer",
    providerStatus: input.providerStatus ?? "Ready to Ship",
    providerStatusCode: input.providerStatusCode ?? "ReadyToShip",
    lifecycle: input.lifecycle ?? "ready-to-ship",
    createdAt: input.createdAt ?? "2026-08-07T12:00:00.000Z",
    shippingMethod: input.shippingMethod ?? "Standard",
    totals: {
      subtotal: {
        currency: "USD",
        minorUnits: input.subtotalMinorUnits ?? 1_200,
      },
      shipping: {
        currency: "USD",
        minorUnits: input.shippingMinorUnits ?? 149,
      },
      total: {
        currency: "USD",
        minorUnits: input.totalMinorUnits ?? 1_349,
      },
    },
    actions: marketplaceActions(input.availableActions),
  };
}

export function marketplaceOrderDetail(
  input: MarketplaceOrderFixtureInput & {
    readonly addressOne?: string;
    readonly description?: string;
    readonly quantity?: number;
    readonly trackingNumbers?: readonly string[];
    readonly orderChannel?: string;
    readonly sellerName?: string;
    readonly paymentMethod?: string;
  },
): OrderDetail {
  const summary = marketplaceOrder(input);
  const quantity = input.quantity ?? 2;
  return {
    ...summary,
    shippingAddress: {
      recipientName: input.buyerName ?? "Synthetic Buyer",
      addressOne: input.addressOne ?? "125 Example Avenue",
      addressTwo: "Unit 4",
      city: "Test City",
      territory: "IL",
      country: "US",
      postalCode: "60000",
    },
    lines: [
      {
        lineKey: `${summary.ref.remoteId}:line-1`,
        description: (input.description ?? "Synthetic Card").replaceAll(
          "\u00c2\u00b7",
          "\u00b7",
        ),
        quantity,
        unitPrice: {
          currency: "USD",
          minorUnits: Math.round(summary.totals.subtotal.minorUnits / quantity),
        },
        lineTotal: summary.totals.subtotal,
        attributes: { condition: "Near Mint" },
        catalogIdentities: [],
      },
    ],
    trackingNumbers: input.trackingNumbers ?? [],
    orderChannel: input.orderChannel ?? "Marketplace",
    sellerName: input.sellerName ?? "Synthetic Seller",
    paymentMethod: input.paymentMethod ?? "Credit card",
  };
}
