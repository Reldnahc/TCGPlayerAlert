import {
  MarketplaceValidationError,
  parseConnectionId,
  parseProviderId,
  parseProviderOrderRef,
  type ProviderOrderRef,
} from "./identity.js";

export type OrderLifecycle =
  | "pending"
  | "ready-to-ship"
  | "shipped"
  | "delivered"
  | "canceled"
  | "refunded"
  | "unknown";

export type ConnectionHealthState =
  | "disabled"
  | "not-configured"
  | "checking"
  | "connected"
  | "degraded"
  | "authentication-required"
  | "unavailable";

export type OrderActionId =
  | "view-detail"
  | "print-address-label"
  | "packing-slip"
  | "pirate-ship"
  | "add-tracking"
  | "mark-shipped"
  | "refund";

export type ActionUnavailableReason =
  | "connection-unavailable"
  | "provider-unsupported"
  | "order-state"
  | "missing-data"
  | "configuration-required"
  | "review-required";

export type ActionAvailability =
  | { readonly state: "available" }
  | { readonly state: "unavailable"; readonly reason: ActionUnavailableReason };

export interface MarketplaceConnectionDescriptor {
  readonly connectionId: string;
  readonly providerId: string;
  readonly providerLabel: string;
  readonly connectionLabel: string;
}

export interface ConnectionHealth {
  readonly state: ConnectionHealthState;
  readonly checkedAt?: string;
  readonly issueCode?: string;
  readonly retryable?: boolean;
}

export interface Money {
  readonly currency: string;
  readonly minorUnits: number;
}

export interface OrderTotals {
  readonly subtotal: Money;
  readonly shipping: Money;
  readonly tax?: Money;
  readonly total: Money;
}

export interface CatalogIdentity {
  readonly namespace: string;
  readonly value: string;
  readonly precision: "exact-variant" | "product";
}

export interface PostalAddress {
  readonly recipientName: string;
  readonly company?: string;
  readonly addressOne: string;
  readonly addressTwo?: string;
  readonly city: string;
  readonly territory: string;
  readonly country: string;
  readonly postalCode: string;
}

export interface OrderLine {
  readonly lineKey: string;
  readonly description: string;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly lineTotal: Money;
  readonly attributes: Readonly<Record<string, string>>;
  readonly catalogIdentities: readonly CatalogIdentity[];
}

export interface OrderSummary {
  readonly ref: ProviderOrderRef;
  readonly displayOrderNumber: string;
  readonly buyerName?: string;
  readonly providerStatus: string;
  readonly providerStatusCode?: string;
  readonly lifecycle: OrderLifecycle;
  readonly createdAt: string;
  readonly shippingMethod: string;
  /** Provider-declared sales channel, when the provider exposes one. */
  readonly orderChannel?: string;
  /** Provider-declared fulfillment mode, when the provider exposes one. */
  readonly orderFulfillment?: string;
  /** Provider-declared payment state. Absence must not be inferred as paid. */
  readonly buyerPaid?: boolean;
  readonly totals: OrderTotals;
  readonly actions: Readonly<Record<OrderActionId, ActionAvailability>>;
}

export interface OrderDetail extends OrderSummary {
  readonly shippingAddress: PostalAddress;
  readonly lines: readonly OrderLine[];
  readonly trackingNumbers: readonly string[];
  readonly sellerName?: string;
  readonly paymentMethod?: string;
}

export type OrderScope = "all" | "ready-to-ship";

export interface OrderPageQuery {
  readonly scope: OrderScope;
  readonly since?: string;
  readonly cursor?: string;
  readonly pageSize: number;
}

export interface OrderPage {
  readonly orders: readonly OrderSummary[];
  readonly nextCursor?: string;
}

export interface OrderPageReader {
  readOrderPage(
    query: OrderPageQuery,
    signal?: AbortSignal,
  ): Promise<OrderPage>;
}

export interface OrderDetailReader {
  getOrder(ref: ProviderOrderRef, signal?: AbortSignal): Promise<OrderDetail>;
}

export interface AddTrackingCommand {
  readonly ref: ProviderOrderRef;
  readonly trackingNumber: string;
}

export interface MarkShippedCommand {
  readonly ref: ProviderOrderRef;
}

export interface MutationResult {
  readonly ref: ProviderOrderRef;
  readonly outcome: "applied" | "already-applied" | "review-required";
}

export interface FulfillmentMutator {
  addTracking(
    input: AddTrackingCommand,
    signal?: AbortSignal,
  ): Promise<MutationResult>;
  markShipped(
    input: MarkShippedCommand,
    signal?: AbortSignal,
  ): Promise<MutationResult>;
}

export interface RefundCapabilities {
  readonly full: boolean;
  readonly partial: boolean;
}

export interface RefundLineCommand {
  readonly lineKey: string;
  readonly amount: Money;
}

export interface RefundCommand {
  readonly ref: ProviderOrderRef;
  readonly reason: string;
  readonly message: string;
  readonly shippingAmount?: Money;
  readonly lines?: readonly RefundLineCommand[];
}

export interface RefundProvider {
  getRefundCapabilities(
    ref: ProviderOrderRef,
    signal?: AbortSignal,
  ): Promise<RefundCapabilities>;
  refund(input: RefundCommand, signal?: AbortSignal): Promise<MutationResult>;
}

export interface NativeDocumentRequest {
  readonly ref: ProviderOrderRef;
  readonly kind: "packing-slip";
}

export interface NormalizedFulfillmentDocument {
  readonly ref: ProviderOrderRef;
  readonly kind: "packing-slip";
  readonly mediaType: string;
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

export interface NativeDocumentUnsupported {
  readonly outcome: "unsupported";
}

export type NativeDocumentResult =
  NormalizedFulfillmentDocument | NativeDocumentUnsupported;

export interface NativeOrderDocumentSource {
  getDocument(
    input: NativeDocumentRequest,
    signal?: AbortSignal,
  ): Promise<NativeDocumentResult>;
}

export interface PullAllocationRef {
  readonly order: ProviderOrderRef;
  readonly lineKey: string;
}

export interface PullLineAllocation extends PullAllocationRef {
  readonly quantity: number;
}

export interface PullLine {
  readonly description: string;
  readonly quantity: number;
  readonly attributes: Readonly<Record<string, string>>;
  readonly catalogIdentities: readonly CatalogIdentity[];
  readonly allocations: readonly PullLineAllocation[];
}

export interface PullLineReader {
  getPullLines(
    refs: readonly ProviderOrderRef[],
    signal?: AbortSignal,
  ): Promise<readonly PullLine[]>;
}

export interface InventoryPageQuery {
  readonly cursor?: string;
  readonly pageSize: number;
}

export interface InventoryItem {
  readonly inventoryKey: string;
  readonly displayName: string;
  readonly quantity: number;
  readonly price?: Money;
  readonly catalogIdentities: readonly CatalogIdentity[];
  readonly attributes: Readonly<Record<string, string>>;
  /**
   * Absolute means the provider can replace any quantity. Increase-or-clear
   * can safely increase quantity or clear it, but cannot partially decrease it.
   */
  readonly quantityMutation: "absolute" | "increase-or-clear" | "unavailable";
  readonly priceMutable: boolean;
}

export interface InventoryPage {
  readonly items: readonly InventoryItem[];
  readonly nextCursor?: string;
}

export interface InventoryReader {
  readInventoryPage(
    query: InventoryPageQuery,
    signal?: AbortSignal,
  ): Promise<InventoryPage>;
}

export interface InventoryMutationCommand {
  readonly inventoryKey: string;
  readonly quantity: number;
  readonly price?: Money;
  readonly idempotencyKey: string;
}

export interface InventoryMutator {
  updateInventory(
    input: InventoryMutationCommand,
    signal?: AbortSignal,
  ): Promise<InventoryMutationOutcome>;
}

export interface PublishExactInventoryCommand {
  readonly exactIdentity: CatalogIdentity;
  readonly quantity: number;
  readonly price: Money;
  readonly idempotencyKey: string;
}

export interface PublishExactInventoryResult {
  readonly outcome: "applied" | "review-required";
  readonly item?: InventoryItem;
  readonly reasonCode?: string;
}

export interface InventoryPublisher {
  readExactInventory(
    identity: CatalogIdentity,
    signal?: AbortSignal,
  ): Promise<InventoryItem | undefined>;
  publishExactInventory(
    input: PublishExactInventoryCommand,
    signal?: AbortSignal,
  ): Promise<PublishExactInventoryResult>;
}

export type ListingQuoteSource = "market-low" | "market";

export interface ListingQuote {
  readonly price: Money;
  readonly source: ListingQuoteSource;
  readonly availableQuantity?: number;
  readonly asOf?: string;
}

export interface ListingQuoteReader {
  quoteExactListing(
    identity: CatalogIdentity,
    signal?: AbortSignal,
  ): Promise<ListingQuote | undefined>;
}

export type InventoryMutationOutcome =
  "applied" | "already-applied" | "review-required";

export interface CatalogMetadataReader {
  readCatalogMetadata(
    identities: readonly CatalogIdentity[],
    signal?: AbortSignal,
  ): Promise<
    Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>
  >;
}

export type ProviderOperation =
  | "health"
  | "list-orders"
  | "get-order"
  | "document"
  | "pull-lines"
  | "tracking"
  | "mark-shipped"
  | "refund"
  | "inventory"
  | "local-inventory";

export interface ProviderIssue {
  readonly connectionId: string;
  readonly operation: ProviderOperation;
  readonly code: string;
  readonly retryable: boolean;
}

export interface AggregateResult<T> {
  readonly data: T;
  readonly issues: readonly ProviderIssue[];
  readonly completedAt: string;
}

export const ORDER_ACTION_IDS: readonly OrderActionId[] = [
  "view-detail",
  "print-address-label",
  "packing-slip",
  "pirate-ship",
  "add-tracking",
  "mark-shipped",
  "refund",
];

const ORDER_LIFECYCLES = new Set<OrderLifecycle>([
  "pending",
  "ready-to-ship",
  "shipped",
  "delivered",
  "canceled",
  "refunded",
  "unknown",
]);
const HEALTH_STATES = new Set<ConnectionHealthState>([
  "disabled",
  "not-configured",
  "checking",
  "connected",
  "degraded",
  "authentication-required",
  "unavailable",
]);
const UNAVAILABLE_REASONS = new Set<ActionUnavailableReason>([
  "connection-unavailable",
  "provider-unsupported",
  "order-state",
  "missing-data",
  "configuration-required",
  "review-required",
]);
const PROVIDER_OPERATIONS = new Set<ProviderOperation>([
  "health",
  "list-orders",
  "get-order",
  "document",
  "pull-lines",
  "tracking",
  "mark-shipped",
  "refund",
  "inventory",
  "local-inventory",
]);

export function parseMoney(value: unknown): Money {
  const source = record(value, "money");
  if (
    typeof source.currency !== "string" ||
    !/^[A-Z]{3}$/u.test(source.currency) ||
    !Number.isSafeInteger(source.minorUnits)
  ) {
    throw invalid("Money must use an uppercase currency and safe minor units.");
  }
  return { currency: source.currency, minorUnits: Number(source.minorUnits) };
}

export function addMoney(left: Money, right: Money): Money {
  const first = parseMoney(left);
  const second = parseMoney(right);
  if (first.currency !== second.currency) {
    throw invalid("Money with different currencies cannot be combined.");
  }
  const minorUnits = first.minorUnits + second.minorUnits;
  if (!Number.isSafeInteger(minorUnits)) {
    throw invalid("The money total exceeds the safe integer range.");
  }
  return { currency: first.currency, minorUnits };
}

export function parseConnectionDescriptor(
  value: unknown,
): MarketplaceConnectionDescriptor {
  const source = record(value, "connection descriptor");
  return {
    connectionId: parseConnectionId(source.connectionId),
    providerId: parseProviderId(source.providerId),
    providerLabel: text(source.providerLabel, "provider label", 128),
    connectionLabel: text(source.connectionLabel, "connection label", 128),
  };
}

export function parseConnectionHealth(value: unknown): ConnectionHealth {
  const source = record(value, "connection health");
  if (
    typeof source.state !== "string" ||
    !HEALTH_STATES.has(source.state as ConnectionHealthState)
  ) {
    throw invalid("The connection health state is invalid.");
  }
  const checkedAt = optionalTimestamp(source.checkedAt, "health checkedAt");
  const issueCode = optionalCode(source.issueCode, "health issue code");
  if (source.retryable !== undefined && typeof source.retryable !== "boolean") {
    throw invalid("The connection health retryable value is invalid.");
  }
  return {
    state: source.state as ConnectionHealthState,
    ...(checkedAt === undefined ? {} : { checkedAt }),
    ...(issueCode === undefined ? {} : { issueCode }),
    ...(source.retryable === undefined ? {} : { retryable: source.retryable }),
  };
}

export function parseActionAvailability(value: unknown): ActionAvailability {
  const source = record(value, "action availability");
  if (source.state === "available") return { state: "available" };
  if (
    source.state !== "unavailable" ||
    typeof source.reason !== "string" ||
    !UNAVAILABLE_REASONS.has(source.reason as ActionUnavailableReason)
  ) {
    throw invalid("The action availability is invalid.");
  }
  return {
    state: "unavailable",
    reason: source.reason as ActionUnavailableReason,
  };
}

export function parseCatalogIdentity(value: unknown): CatalogIdentity {
  const source = record(value, "catalog identity");
  if (source.precision !== "exact-variant" && source.precision !== "product") {
    throw invalid("The catalog identity precision is invalid.");
  }
  return {
    namespace: slug(source.namespace, "catalog namespace", 64),
    value: text(source.value, "catalog identity", 256),
    precision: source.precision,
  };
}

export function parseOrderSummary(value: unknown): OrderSummary {
  const source = record(value, "order summary");
  const lifecycle = lifecycleValue(source.lifecycle);
  const totals = parseOrderTotals(source.totals);
  return {
    ref: parseProviderOrderRef(source.ref),
    displayOrderNumber: text(
      source.displayOrderNumber,
      "display order number",
      256,
    ),
    ...(source.buyerName === undefined
      ? {}
      : { buyerName: text(source.buyerName, "buyer name", 256) }),
    providerStatus: text(source.providerStatus, "provider status", 256),
    ...(source.providerStatusCode === undefined
      ? {}
      : {
          providerStatusCode: text(
            source.providerStatusCode,
            "provider status code",
            128,
          ),
        }),
    lifecycle,
    createdAt: timestamp(source.createdAt, "order creation time"),
    shippingMethod: text(source.shippingMethod, "shipping method", 256),
    ...optionalTextProperty(source, "orderChannel", "order channel"),
    ...optionalTextProperty(source, "orderFulfillment", "order fulfillment"),
    ...(source.buyerPaid === undefined
      ? {}
      : { buyerPaid: booleanValue(source.buyerPaid, "buyer paid") }),
    totals,
    actions: parseActions(source.actions),
  };
}

export function parseOrderDetail(value: unknown): OrderDetail {
  const source = record(value, "order detail");
  const summary = parseOrderSummary(source);
  if (!Array.isArray(source.lines) || source.lines.length > 10_000) {
    throw invalid("The order lines are invalid.");
  }
  const lines = source.lines.map(parseOrderLine);
  const lineKeys = new Set(lines.map((line) => line.lineKey));
  if (lineKeys.size !== lines.length) {
    throw invalid("Order line keys must be unique within an order.");
  }
  const trackingNumbers = stringArray(
    source.trackingNumbers,
    "tracking numbers",
    100,
    256,
  );
  assertCurrencyConsistency(summary.totals, lines);
  return {
    ...summary,
    shippingAddress: parsePostalAddress(source.shippingAddress),
    lines,
    trackingNumbers,
    ...optionalTextProperty(source, "sellerName", "seller name"),
    ...optionalTextProperty(source, "paymentMethod", "payment method"),
  };
}

export function parseMutationResult(value: unknown): MutationResult {
  const source = record(value, "mutation result");
  if (
    source.outcome !== "applied" &&
    source.outcome !== "already-applied" &&
    source.outcome !== "review-required"
  ) {
    throw invalid("The mutation outcome is invalid.");
  }
  return {
    ref: parseProviderOrderRef(source.ref),
    outcome: source.outcome,
  };
}

export function parseOrderPage(value: unknown): OrderPage {
  const source = record(value, "order page");
  if (!Array.isArray(source.orders) || source.orders.length > 10_000) {
    throw invalid("The order page is invalid.");
  }
  const nextCursor =
    source.nextCursor === undefined
      ? undefined
      : text(source.nextCursor, "order cursor", 512);
  return {
    orders: source.orders.map(parseOrderSummary),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

export function parsePullLine(value: unknown): PullLine {
  const source = record(value, "pull line");
  if (!Number.isSafeInteger(source.quantity) || Number(source.quantity) < 1) {
    throw invalid("The pull-line quantity is invalid.");
  }
  if (
    !Array.isArray(source.catalogIdentities) ||
    source.catalogIdentities.length > 64 ||
    !Array.isArray(source.allocations) ||
    source.allocations.length < 1 ||
    source.allocations.length > 10_000
  ) {
    throw invalid("The pull-line identities or allocations are invalid.");
  }
  const catalogIdentities = source.catalogIdentities.map(parseCatalogIdentity);
  const identityKeys = catalogIdentities.map(
    (identity) =>
      `${identity.namespace}\u0000${identity.value}\u0000${identity.precision}`,
  );
  if (new Set(identityKeys).size !== identityKeys.length) {
    throw invalid("The pull-line catalog identities contain duplicates.");
  }
  const allocations = source.allocations.map((allocation) => {
    const entry = record(allocation, "pull-line allocation");
    if (!Number.isSafeInteger(entry.quantity) || Number(entry.quantity) < 1) {
      throw invalid("The pull-line allocation quantity is invalid.");
    }
    return {
      order: parseProviderOrderRef(entry.order),
      lineKey: text(entry.lineKey, "pull-line allocation key", 256),
      quantity: Number(entry.quantity),
    };
  });
  const allocationKeys = allocations.map((allocation) =>
    JSON.stringify([
      allocation.order.connectionId,
      allocation.order.remoteId,
      allocation.lineKey,
    ]),
  );
  if (new Set(allocationKeys).size !== allocationKeys.length) {
    throw invalid("The pull-line allocations contain duplicates.");
  }
  const allocatedQuantity = allocations.reduce(
    (total, allocation) => total + allocation.quantity,
    0,
  );
  if (
    !Number.isSafeInteger(allocatedQuantity) ||
    allocatedQuantity !== Number(source.quantity)
  ) {
    throw invalid("The pull-line allocation quantities do not match.");
  }
  return {
    description: text(source.description, "pull-line description", 512),
    quantity: Number(source.quantity),
    attributes: stringRecord(source.attributes, "pull-line attributes"),
    catalogIdentities,
    allocations,
  };
}

export function parseInventoryItem(value: unknown): InventoryItem {
  const source = record(value, "inventory item");
  if (
    !Number.isSafeInteger(source.quantity) ||
    Number(source.quantity) < 0 ||
    !Array.isArray(source.catalogIdentities) ||
    source.catalogIdentities.length > 64 ||
    (source.quantityMutation !== "absolute" &&
      source.quantityMutation !== "increase-or-clear" &&
      source.quantityMutation !== "unavailable") ||
    typeof source.priceMutable !== "boolean"
  ) {
    throw invalid("The inventory item is invalid.");
  }
  if (source.priceMutable && source.price === undefined) {
    throw invalid("A price-mutable inventory item must expose its price.");
  }
  const catalogIdentities = source.catalogIdentities.map(parseCatalogIdentity);
  const identityKeys = catalogIdentities.map((identity) =>
    JSON.stringify([identity.namespace, identity.value, identity.precision]),
  );
  if (new Set(identityKeys).size !== identityKeys.length) {
    throw invalid("The inventory catalog identities contain duplicates.");
  }
  return {
    inventoryKey: text(source.inventoryKey, "inventory key", 256),
    displayName: text(source.displayName, "inventory display name", 512),
    quantity: Number(source.quantity),
    ...(source.price === undefined ? {} : { price: parseMoney(source.price) }),
    catalogIdentities,
    attributes: stringRecord(source.attributes, "inventory attributes"),
    quantityMutation: source.quantityMutation,
    priceMutable: source.priceMutable,
  };
}

export function parseInventoryPage(value: unknown): InventoryPage {
  const source = record(value, "inventory page");
  if (!Array.isArray(source.items) || source.items.length > 10_000) {
    throw invalid("The inventory page items are invalid.");
  }
  const items = source.items.map(parseInventoryItem);
  const keys = items.map((item) => item.inventoryKey);
  if (new Set(keys).size !== keys.length) {
    throw invalid("The inventory page contains duplicate keys.");
  }
  return {
    items,
    ...(source.nextCursor === undefined
      ? {}
      : { nextCursor: text(source.nextCursor, "inventory cursor", 1_024) }),
  };
}

export function parseInventoryMutationCommand(
  value: unknown,
): InventoryMutationCommand {
  const source = record(value, "inventory mutation");
  if (!Number.isSafeInteger(source.quantity) || Number(source.quantity) < 0) {
    throw invalid("The inventory quantity is invalid.");
  }
  return {
    inventoryKey: text(source.inventoryKey, "inventory key", 256),
    quantity: Number(source.quantity),
    ...(source.price === undefined ? {} : { price: parseMoney(source.price) }),
    idempotencyKey: text(
      source.idempotencyKey,
      "inventory idempotency key",
      256,
    ),
  };
}

export function parseProviderIssue(value: unknown): ProviderIssue {
  const source = record(value, "provider issue");
  if (
    typeof source.operation !== "string" ||
    !PROVIDER_OPERATIONS.has(source.operation as ProviderOperation) ||
    typeof source.retryable !== "boolean"
  ) {
    throw invalid("The provider issue is invalid.");
  }
  return {
    connectionId: parseConnectionId(source.connectionId),
    operation: source.operation as ProviderOperation,
    code: code(source.code, "provider issue code"),
    retryable: source.retryable,
  };
}

function parseOrderTotals(value: unknown): OrderTotals {
  const source = record(value, "order totals");
  const subtotal = parseMoney(source.subtotal);
  const shipping = parseMoney(source.shipping);
  const tax = source.tax === undefined ? undefined : parseMoney(source.tax);
  const total = parseMoney(source.total);
  const currencies = [
    subtotal,
    shipping,
    total,
    ...(tax === undefined ? [] : [tax]),
  ];
  if (new Set(currencies.map((money) => money.currency)).size !== 1) {
    throw invalid("Order totals must use one currency.");
  }
  return { subtotal, shipping, ...(tax === undefined ? {} : { tax }), total };
}

function parseOrderLine(value: unknown): OrderLine {
  const source = record(value, "order line");
  if (!Number.isSafeInteger(source.quantity) || Number(source.quantity) < 1) {
    throw invalid("The order line quantity is invalid.");
  }
  if (
    !Array.isArray(source.catalogIdentities) ||
    source.catalogIdentities.length > 64
  ) {
    throw invalid("The order line catalog identities are invalid.");
  }
  const catalogIdentities = source.catalogIdentities.map(parseCatalogIdentity);
  const identityKeys = new Set(
    catalogIdentities.map(
      (identity) =>
        `${identity.namespace}\u0000${identity.value}\u0000${identity.precision}`,
    ),
  );
  if (identityKeys.size !== catalogIdentities.length) {
    throw invalid("The order line catalog identities contain duplicates.");
  }
  return {
    lineKey: text(source.lineKey, "order line key", 256),
    description: text(source.description, "order line description", 512),
    quantity: Number(source.quantity),
    unitPrice: parseMoney(source.unitPrice),
    lineTotal: parseMoney(source.lineTotal),
    attributes: stringRecord(source.attributes, "order line attributes"),
    catalogIdentities,
  };
}

function parsePostalAddress(value: unknown): PostalAddress {
  const source = record(value, "postal address");
  const country = text(source.country, "country", 2);
  if (!/^[A-Z]{2}$/u.test(country))
    throw invalid("The country code is invalid.");
  return {
    recipientName: text(source.recipientName, "recipient name", 256),
    ...optionalTextProperty(source, "company", "company"),
    addressOne: text(source.addressOne, "address line one", 256),
    ...optionalTextProperty(source, "addressTwo", "address line two"),
    city: text(source.city, "city", 128),
    territory: text(source.territory, "territory", 128),
    country,
    postalCode: text(source.postalCode, "postal code", 32),
  };
}

function parseActions(
  value: unknown,
): Readonly<Record<OrderActionId, ActionAvailability>> {
  const source = record(value, "order actions");
  const actualKeys = Object.keys(source).sort();
  const expectedKeys = [...ORDER_ACTION_IDS].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw invalid(
      "The order action set is incomplete or contains unknown actions.",
    );
  }
  return Object.fromEntries(
    ORDER_ACTION_IDS.map((actionId) => [
      actionId,
      parseActionAvailability(source[actionId]),
    ]),
  ) as Record<OrderActionId, ActionAvailability>;
}

function lifecycleValue(value: unknown): OrderLifecycle {
  if (
    typeof value !== "string" ||
    !ORDER_LIFECYCLES.has(value as OrderLifecycle)
  ) {
    throw invalid("The order lifecycle is invalid.");
  }
  return value as OrderLifecycle;
}

function assertCurrencyConsistency(
  totals: OrderTotals,
  lines: readonly OrderLine[],
): void {
  for (const line of lines) {
    if (
      line.unitPrice.currency !== totals.total.currency ||
      line.lineTotal.currency !== totals.total.currency
    ) {
      throw invalid("Order lines and totals must use one currency.");
    }
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`The ${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Array.from(value).length > maximum ||
    /\p{Cc}/u.test(value)
  ) {
    throw invalid(`The ${label} is invalid.`);
  }
  return value;
}

function slug(value: unknown, label: string, maximum: number): string {
  const parsed = text(value, label, maximum);
  if (!/^[a-z][a-z0-9._-]*$/u.test(parsed)) {
    throw invalid(`The ${label} is invalid.`);
  }
  return parsed;
}

function code(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{1,63}$/u.test(value)) {
    throw invalid(`The ${label} is invalid.`);
  }
  return value;
}

function optionalCode(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : code(value, label);
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw invalid(`The ${label} is invalid.`);
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw invalid(`The ${label} is invalid.`);
  }
  return value;
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : timestamp(value, label);
}

function optionalTextProperty(
  source: Record<string, unknown>,
  key:
    | "company"
    | "addressTwo"
    | "orderChannel"
    | "orderFulfillment"
    | "sellerName"
    | "paymentMethod",
  label: string,
): Readonly<Record<string, string>> {
  return source[key] === undefined
    ? {}
    : { [key]: text(source[key], label, 256) };
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw invalid(`The ${label} value is invalid.`);
  }
  return value;
}

function stringArray(
  value: unknown,
  label: string,
  maximumEntries: number,
  maximumLength: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumEntries) {
    throw invalid(`The ${label} are invalid.`);
  }
  return value.map((entry) => text(entry, label, maximumLength));
}

function stringRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, string>> {
  const source = record(value, label);
  const entries = Object.entries(source);
  if (entries.length > 64) throw invalid(`The ${label} are invalid.`);
  return Object.fromEntries(
    entries.map(([key, entry]) => [
      text(key, `${label} key`, 128),
      text(entry, `${label} value`, 256),
    ]),
  );
}

function invalid(message: string): MarketplaceValidationError {
  return new MarketplaceValidationError(message);
}
