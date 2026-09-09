import {
  SellerOrderStatus,
  type SellerOrderDetail,
  type SellerOrderSearchSummary,
} from "tcgplayer-private-api";
import {
  parseOrderDetail,
  parseOrderSummary,
  type OrderActionId,
  type OrderDetail,
  type OrderLifecycle,
  type OrderSummary,
} from "../../marketplaces/contracts.js";
import { majorUnitsToMoney } from "../../marketplaces/money.js";
import { resolveOrderActions } from "../../marketplaces/order-actions.js";
import {
  MarketplaceValidationError,
  parseConnectionId,
} from "../../marketplaces/identity.js";

const CURRENCY = "USD";

const LIFECYCLE_BY_STATUS: Readonly<Record<SellerOrderStatus, OrderLifecycle>> =
  {
    [SellerOrderStatus.Canceled]: "canceled",
    [SellerOrderStatus.Delivered]: "delivered",
    [SellerOrderStatus.PickedUp]: "delivered",
    [SellerOrderStatus.PickupOrderCanceled]: "canceled",
    [SellerOrderStatus.Processing]: "pending",
    [SellerOrderStatus.Pulling]: "pending",
    [SellerOrderStatus.ReadyForPickup]: "ready-to-ship",
    [SellerOrderStatus.ReadyToShip]: "ready-to-ship",
    [SellerOrderStatus.Received]: "pending",
    [SellerOrderStatus.Shipped]: "shipped",
    [SellerOrderStatus.ShippedOrderCanceled]: "canceled",
    [SellerOrderStatus.Unknown]: "unknown",
  };

const SUMMARY_SUPPORT: Readonly<Partial<Record<OrderActionId, boolean>>> = {
  "view-detail": true,
  "print-address-label": true,
  "packing-slip": true,
  "pirate-ship": true,
  "add-tracking": true,
  "mark-shipped": true,
  refund: false,
};

export function tcgplayerLifecycle(status: SellerOrderStatus): OrderLifecycle {
  return LIFECYCLE_BY_STATUS[status];
}

export function normalizeTcgplayerProductLine(value: string): string {
  const normalized = value.trim();
  return /^magic(?::\s*the gathering)?$/iu.test(normalized)
    ? "Magic: The Gathering"
    : normalized;
}

export function normalizeTcgplayerOrderSummary(
  order: SellerOrderSearchSummary,
  connectionId: string,
): OrderSummary {
  const lifecycle = tcgplayerLifecycle(order.orderStatusCode);
  return parseOrderSummary({
    ref: {
      connectionId: parseConnectionId(connectionId),
      remoteId: order.orderNumber,
    },
    displayOrderNumber: order.orderNumber,
    ...(order.buyerName.trim().length === 0
      ? {}
      : { buyerName: order.buyerName }),
    providerStatus: order.orderStatus,
    providerStatusCode: order.orderStatusCode,
    lifecycle,
    createdAt: order.orderDate,
    shippingMethod: order.shippingType,
    orderChannel: order.orderChannel,
    orderFulfillment: order.orderFulfillment,
    buyerPaid: order.buyerPaid,
    totals: {
      subtotal: majorUnitsToMoney(order.productAmount, CURRENCY),
      shipping: majorUnitsToMoney(order.shippingAmount, CURRENCY),
      total: majorUnitsToMoney(order.totalAmount, CURRENCY),
    },
    actions: resolveOrderActions({
      lifecycle,
      hasShippingAddress: true,
      supported: SUMMARY_SUPPORT,
      providerAllowed:
        order.orderStatusCode === SellerOrderStatus.ReadyToShip
          ? new Set(["add-tracking", "mark-shipped"])
          : new Set(),
    }),
  });
}

export function normalizeTcgplayerOrderDetail(
  order: SellerOrderDetail,
  connectionId: string,
): OrderDetail {
  const lifecycle = tcgplayerLifecycle(order.statusCode);
  const providerAllowed = translateAllowedActions(order.allowedActions);
  const address = order.shippingAddress;
  const taxes = order.transaction.taxes.reduce(
    (total, tax) => total + tax.amount,
    0,
  );
  const normalized = parseOrderDetail({
    ref: {
      connectionId: parseConnectionId(connectionId),
      remoteId: order.orderNumber,
    },
    displayOrderNumber: order.orderNumber,
    ...(order.buyerName.trim().length === 0
      ? {}
      : { buyerName: order.buyerName }),
    providerStatus: order.status,
    providerStatusCode: order.statusCode,
    lifecycle,
    createdAt: order.createdAt,
    shippingMethod: order.shippingType,
    totals: {
      subtotal: majorUnitsToMoney(order.transaction.productAmount, CURRENCY),
      shipping: majorUnitsToMoney(order.transaction.shippingAmount, CURRENCY),
      ...(taxes === 0 ? {} : { tax: majorUnitsToMoney(taxes, CURRENCY) }),
      total: majorUnitsToMoney(order.transaction.grossAmount, CURRENCY),
    },
    actions: resolveOrderActions({
      lifecycle,
      hasShippingAddress: hasCompleteAddress(address),
      supported: SUMMARY_SUPPORT,
      providerAllowed,
    }),
    shippingAddress: address,
    lines: order.products.map((product) => ({
      lineKey: product.skuId,
      description: product.name,
      quantity: product.quantity,
      unitPrice: majorUnitsToMoney(product.unitPrice, CURRENCY),
      lineTotal: majorUnitsToMoney(product.extendedPrice, CURRENCY),
      attributes: compactAttributes({
        productUrl: product.url,
        ...(product.listoId === undefined
          ? {}
          : { providerLineId: String(product.listoId) }),
      }),
      catalogIdentities: [
        {
          namespace: "tcgplayer.sku",
          value: product.skuId,
          precision: "exact-variant",
        },
        {
          namespace: "tcgplayer.product",
          value: product.productId,
          precision: "product",
        },
      ],
    })),
    trackingNumbers: order.trackingNumbers.map(
      (tracking) => tracking.trackingNumber,
    ),
    orderChannel: order.orderChannel,
    orderFulfillment: order.orderFulfillment,
    sellerName: order.sellerName,
    paymentMethod: order.paymentType,
  });
  assertUniqueTcgplayerSkuLines(normalized);
  return normalized;
}

export function assertTcgplayerOrderConnection(
  expectedConnectionId: string,
  actualConnectionId: string,
): void {
  if (parseConnectionId(actualConnectionId) !== expectedConnectionId) {
    throw new MarketplaceValidationError(
      "The order reference belongs to another marketplace connection.",
    );
  }
}

function translateAllowedActions(
  actions: readonly string[],
): ReadonlySet<OrderActionId> {
  const translated = new Set<OrderActionId>();
  for (const action of actions) {
    if (action === "AddTracking") translated.add("add-tracking");
    if (action === "MarkShipped") translated.add("mark-shipped");
    if (action === "FullRefund" || action === "PartialRefund") {
      translated.add("refund");
    }
  }
  return translated;
}

function hasCompleteAddress(
  address: SellerOrderDetail["shippingAddress"],
): boolean {
  return [
    address.recipientName,
    address.addressOne,
    address.city,
    address.territory,
    address.country,
    address.postalCode,
  ].every((value) => value.trim().length > 0);
}

function compactAttributes(
  attributes: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value.trim().length > 0),
  );
}

function assertUniqueTcgplayerSkuLines(order: OrderDetail): void {
  if (
    new Set(order.lines.map((line) => line.lineKey)).size !== order.lines.length
  ) {
    throw new MarketplaceValidationError(
      "TCGplayer returned duplicate SKU lines for one order.",
    );
  }
}
