import type {
  ManaPoolFulfillmentStatus,
  SellerOrderDetail,
  SellerOrderItem,
  SellerOrderSummary,
} from "manapool-seller-api";
import {
  parseOrderDetail,
  parseOrderSummary,
  type CatalogIdentity,
  type OrderActionId,
  type OrderDetail,
  type OrderLifecycle,
  type OrderLine,
  type OrderSummary,
} from "../../marketplaces/contracts.js";
import { resolveOrderActions } from "../../marketplaces/order-actions.js";
import {
  MarketplaceValidationError,
  parseConnectionId,
} from "../../marketplaces/identity.js";

const SUPPORT: Readonly<Partial<Record<OrderActionId, boolean>>> = {
  "view-detail": true,
  "print-address-label": true,
  "packing-slip": true,
  "pirate-ship": true,
  "add-tracking": true,
  "mark-shipped": true,
  refund: false,
};

export function manaPoolLifecycle(
  status: ManaPoolFulfillmentStatus | null,
): OrderLifecycle {
  switch (status) {
    case null:
    case "error":
    case "processing":
      return "ready-to-ship";
    case "shipped":
      return "shipped";
    case "delivered":
      return "delivered";
    case "refunded":
      return "refunded";
    case "replaced":
      return "unknown";
  }
}

export function manaPoolStatusLabel(
  status: ManaPoolFulfillmentStatus | null,
): string {
  switch (status) {
    case null:
      return "Ready to Ship";
    case "error":
      return "Fulfillment Error";
    case "processing":
      return "Processing";
    case "shipped":
      return "Shipped";
    case "delivered":
      return "Delivered";
    case "refunded":
      return "Refunded";
    case "replaced":
      return "Replaced";
  }
}

export function normalizeManaPoolOrderSummary(
  summary: SellerOrderSummary,
  detail: SellerOrderDetail,
  connectionId: string,
): OrderSummary {
  assertMatchingOrder(summary, detail);
  const lifecycle = manaPoolLifecycle(summary.latestFulfillmentStatus);
  const providerAllowed = readyActions(lifecycle);
  return parseOrderSummary({
    ref: {
      connectionId: parseConnectionId(connectionId),
      remoteId: summary.id,
    },
    displayOrderNumber: summary.label,
    buyerName: detail.shippingAddress.name,
    providerStatus: manaPoolStatusLabel(summary.latestFulfillmentStatus),
    ...(summary.latestFulfillmentStatus === null
      ? {}
      : { providerStatusCode: summary.latestFulfillmentStatus }),
    lifecycle,
    createdAt: canonicalTimestamp(summary.createdAt),
    shippingMethod: shippingLabel(summary.shippingMethod),
    orderChannel: "ManaPool",
    orderFulfillment: "Seller",
    totals: {
      subtotal: usd(detail.payment.subtotalCents),
      shipping: usd(detail.payment.shippingCents),
      total: usd(detail.payment.totalCents),
    },
    actions: resolveOrderActions({
      lifecycle,
      hasShippingAddress: true,
      supported: SUPPORT,
      providerAllowed,
    }),
  });
}

export function normalizeManaPoolOrderDetail(
  detail: SellerOrderDetail,
  connectionId: string,
): OrderDetail {
  const lifecycle = manaPoolLifecycle(detail.latestFulfillmentStatus);
  const addressTwo = [
    detail.shippingAddress.line2,
    detail.shippingAddress.line3,
  ]
    .filter((line): line is string => line !== null && line.trim().length > 0)
    .join(", ");
  return parseOrderDetail({
    ref: {
      connectionId: parseConnectionId(connectionId),
      remoteId: detail.id,
    },
    displayOrderNumber: detail.label,
    buyerName: detail.shippingAddress.name,
    providerStatus: manaPoolStatusLabel(detail.latestFulfillmentStatus),
    ...(detail.latestFulfillmentStatus === null
      ? {}
      : { providerStatusCode: detail.latestFulfillmentStatus }),
    lifecycle,
    createdAt: canonicalTimestamp(detail.createdAt),
    shippingMethod: shippingLabel(detail.shippingMethod),
    totals: {
      subtotal: usd(detail.payment.subtotalCents),
      shipping: usd(detail.payment.shippingCents),
      total: usd(detail.payment.totalCents),
    },
    actions: resolveOrderActions({
      lifecycle,
      hasShippingAddress: true,
      supported: SUPPORT,
      providerAllowed: readyActions(lifecycle),
    }),
    shippingAddress: {
      recipientName: detail.shippingAddress.name,
      addressOne: detail.shippingAddress.line1,
      ...(addressTwo === "" ? {} : { addressTwo }),
      city: detail.shippingAddress.city,
      territory: detail.shippingAddress.state,
      country: detail.shippingAddress.country,
      postalCode: detail.shippingAddress.postalCode,
    },
    lines: combineEquivalentItems(detail.items),
    trackingNumbers: detail.fulfillments.flatMap((fulfillment) =>
      fulfillment.trackingNumber === null ? [] : [fulfillment.trackingNumber],
    ),
    orderChannel: "ManaPool",
    orderFulfillment: "Seller",
    sellerName: "ManaPool seller",
    paymentMethod: "ManaPool",
  });
}

export function assertManaPoolConnection(
  expectedConnectionId: string,
  actualConnectionId: string,
): void {
  if (parseConnectionId(actualConnectionId) !== expectedConnectionId) {
    throw new MarketplaceValidationError(
      "The order reference belongs to another marketplace connection.",
    );
  }
}

function combineEquivalentItems(
  items: readonly SellerOrderItem[],
): OrderLine[] {
  const combined = new Map<string, OrderLine>();
  for (const item of items) {
    const identities = catalogIdentities(item);
    const attributes = itemAttributes(item);
    const key = stableItemKey(item, identities, attributes);
    const current = combined.get(key);
    if (current === undefined) {
      combined.set(key, {
        lineKey: key,
        description:
          item.product.single?.name ??
          item.product.sealed?.name ??
          "ManaPool product",
        quantity: item.quantity,
        unitPrice: usd(item.priceCents),
        lineTotal: usd(item.priceCents * item.quantity),
        attributes,
        catalogIdentities: identities,
      });
      continue;
    }
    const quantity = current.quantity + item.quantity;
    const lineTotal =
      current.lineTotal.minorUnits + item.priceCents * item.quantity;
    if (!Number.isSafeInteger(quantity) || !Number.isSafeInteger(lineTotal)) {
      throw new MarketplaceValidationError(
        "ManaPool returned an order line outside the supported numeric range.",
      );
    }
    combined.set(key, {
      ...current,
      quantity,
      lineTotal: usd(lineTotal),
    });
  }
  return [...combined.values()];
}

function catalogIdentities(item: SellerOrderItem): CatalogIdentity[] {
  const identities: CatalogIdentity[] = [
    {
      namespace: "manapool.product",
      value: item.productId,
      precision: "exact-variant",
    },
  ];
  if (item.tcgplayerSku !== null) {
    identities.push({
      namespace: "tcgplayer.sku",
      value: String(item.tcgplayerSku),
      precision: "exact-variant",
    });
  }
  const source = item.product.single ?? item.product.sealed;
  if (source !== null) {
    identities.push(
      {
        namespace: "mtgjson.uuid",
        value: source.mtgjsonId,
        precision: "product",
      },
      ...(source.tcgplayerId === null
        ? []
        : [
            {
              namespace: "tcgplayer.product",
              value: String(source.tcgplayerId),
              precision: "product" as const,
            },
          ]),
    );
  }
  if (item.product.single !== null) {
    identities.push({
      namespace: "scryfall.printing",
      value: item.product.single.scryfallId,
      precision: "product",
    });
  }
  return identities;
}

function itemAttributes(
  item: SellerOrderItem,
): Readonly<Record<string, string>> {
  const single = item.product.single;
  const sealed = item.product.sealed;
  return Object.fromEntries(
    Object.entries({
      productLine: "Magic: The Gathering",
      productType: item.productType,
      set: single?.set ?? sealed?.set ?? "",
      setCode: single?.set ?? sealed?.set ?? "",
      number: single?.number ?? "",
      collectorNumber: single?.number ?? "",
      language: single?.languageId ?? sealed?.languageId ?? "",
      condition: single?.conditionId ?? "",
      finish: single?.finishId ?? "",
    }).filter(([, value]) => value !== ""),
  );
}

function stableItemKey(
  item: SellerOrderItem,
  identities: readonly CatalogIdentity[],
  attributes: Readonly<Record<string, string>>,
): string {
  if (item.customExternalId !== null && item.customExternalId.trim() !== "") {
    return `external:${item.customExternalId}`;
  }
  const exact = identities.find(
    (identity) => identity.precision === "exact-variant",
  );
  if (exact === undefined) {
    throw new MarketplaceValidationError(
      "ManaPool returned an order line without an exact identity.",
    );
  }
  const variant = Object.entries(attributes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join(";");
  return `${exact.namespace}:${exact.value}:price=${String(item.priceCents)}:${variant}`;
}

function assertMatchingOrder(
  summary: SellerOrderSummary,
  detail: SellerOrderDetail,
): void {
  if (summary.id !== detail.id || summary.label !== detail.label) {
    throw new MarketplaceValidationError(
      "ManaPool returned mismatched order detail.",
    );
  }
}

function readyActions(lifecycle: OrderLifecycle): ReadonlySet<OrderActionId> {
  return lifecycle === "ready-to-ship"
    ? new Set(["add-tracking", "mark-shipped"])
    : new Set();
}

function shippingLabel(method: SellerOrderSummary["shippingMethod"]): string {
  return method === "ground_advantage" ? "Ground Advantage" : "First Class";
}

function canonicalTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : value;
}

function usd(minorUnits: number) {
  if (!Number.isSafeInteger(minorUnits)) {
    throw new MarketplaceValidationError(
      "ManaPool returned an invalid money amount.",
    );
  }
  return { currency: "USD", minorUnits } as const;
}
