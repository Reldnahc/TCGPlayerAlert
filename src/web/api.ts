import type {
  AdditionPreview,
  CatalogProduct,
  CatalogSearch,
  FeedbackPage,
  InventoryJob,
  InventoryList,
  InventoryMutationResult,
  LocalInventoryImportPreview,
  LocalInventoryImportResult,
  LocalInventoryItemResponse,
  MarketplaceListingQuoteResponse,
  MarketplacePublicationJobResponse,
  MarketplacePublicationPreviewResponse,
  InventoryQueueResponse,
  InternalJobsResponse,
  JobRunResponse,
  JobScheduleInput,
  JobScheduleResponse,
  ScheduledListing,
  DeletedResponse,
  DiscordWebhookStatus,
  DiscordWebhookTestResult,
  MessagesPage,
  MessageMutationResult,
  MarkAllMessagesReadResult,
  MessageThread,
  MarketplaceConnections,
  MarketplaceCredentialStatus,
  OrderList,
  OrderDetail,
  MasterPullList,
  PaymentDetail,
  PaymentsPage,
  PirateShipResult,
  PriceJob,
  PriceQueueResponse,
  PricingPreview,
  PricingProgress,
  PricingRules,
  QueuedJob,
  QueuedJobs,
  Settings,
  SettingsUpdate,
  SellerConnectionStatus,
  SellerPairingChallenge,
  ShipmentResult,
  ShipmentScannerStatus,
  ShipmentScanResult,
  TrackingResult,
  UnreadMessages,
} from "./contracts.js";
import type { ProviderOrderRef } from "../marketplaces/identity.js";
import {
  additionPreviewDecoder,
  catalogProductDecoder,
  catalogSearchDecoder,
  feedbackPageDecoder,
  inventoryQueueDecoder,
  inventoryListDecoder,
  localInventoryImportPreviewDecoder,
  localInventoryImportResultDecoder,
  localInventoryItemResponseDecoder,
  marketplacePublicationJobResponseDecoder,
  marketplaceListingQuoteResponseDecoder,
  marketplacePublicationPreviewResponseDecoder,
  inventoryMutationDecoder,
  internalJobsDecoder,
  jobRunResponseDecoder,
  jobScheduleResponseDecoder,
  deletedResponseDecoder,
  discordWebhookStatusDecoder,
  discordWebhookTestDecoder,
  markAllMessagesReadDecoder,
  masterPullListDecoder,
  pullListRowDecoder,
  messageMutationDecoder,
  messagesPageDecoder,
  messageThreadDecoder,
  marketplaceConnectionsDecoder,
  marketplaceCredentialStatusDecoder,
  orderDetailDecoder,
  orderListDecoder,
  paymentDetailDecoder,
  paymentsPageDecoder,
  pirateShipDecoder,
  priceQueueDecoder,
  pricingPreviewDecoder,
  queuedInventoryJobDecoder,
  queuedInventoryJobsDecoder,
  queuedPriceJobDecoder,
  queuedPriceJobsDecoder,
  sellerConnectionDecoder,
  sellerPairingDecoder,
  settingsDecoder,
  shipmentResultDecoder,
  shipmentScannerStatusDecoder,
  shipmentScanResultDecoder,
  trackingResultDecoder,
  unreadMessagesDecoder,
} from "./api-contracts.js";
import { DecodeError, discard, type Decoder } from "./decoder.js";

export class UiApiError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "UiApiError";
    if (code !== undefined) this.code = code;
  }
}

export const AUTHENTICATION_REQUIRED_EVENT =
  "tcgplayer-alert:authentication-required";

function notifyAuthenticationRequired(code: string | undefined): void {
  if (code === "AUTHENTICATION_REQUIRED") {
    window.dispatchEvent(new Event(AUTHENTICATION_REQUIRED_EVENT));
  }
}

async function responseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  try {
    return contentType.includes("application/json")
      ? await response.json()
      : await response.text();
  } catch {
    throw new UiApiError(
      "The server returned malformed JSON.",
      "INVALID_RESPONSE",
    );
  }
}

function apiMessage(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null) return fallback;
  const candidate = body as Readonly<Record<string, unknown>>;
  if (
    Array.isArray(candidate.issues) &&
    candidate.issues.length > 0 &&
    candidate.issues.every((issue) => typeof issue === "string")
  ) {
    return candidate.issues.join(" ");
  }
  return typeof candidate.message === "string" ? candidate.message : fallback;
}

function apiCode(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const code = (body as Readonly<Record<string, unknown>>).code;
  return typeof code === "string" ? code : undefined;
}

export async function requestJson<T>(
  path: string,
  responseDecoder: Decoder<T>,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (options.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, {
    ...options,
    headers,
  });
  const body = await responseBody(response);
  if (!response.ok) {
    const code = apiCode(body);
    notifyAuthenticationRequired(code);
    throw new UiApiError(
      apiMessage(body, `Request failed (${String(response.status)}).`),
      code,
    );
  }
  return decodeResponse(responseDecoder, body);
}

function decodeResponse<T>(responseDecoder: Decoder<T>, body: unknown): T {
  try {
    return responseDecoder.decode(body);
  } catch (error) {
    if (error instanceof DecodeError) {
      throw new UiApiError(
        `The server returned invalid data: ${error.message}`,
        "INVALID_RESPONSE",
      );
    }
    throw error;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pricingProgress(value: unknown): PricingProgress {
  const source = objectValue(value);
  const phase = source?.phase;
  const completed = source?.completed;
  const total = source?.total;
  const unit = source?.unit;
  const detail = source?.detail;
  if (
    (phase !== "inventory" &&
      phase !== "market-prices" &&
      phase !== "comparisons" &&
      phase !== "exact-comparisons" &&
      phase !== "finalizing") ||
    !Number.isInteger(completed) ||
    Number(completed) < 0 ||
    (total !== undefined &&
      (!Number.isInteger(total) ||
        Number(total) < Number(completed) ||
        Number(total) < 0)) ||
    (unit !== "products" && unit !== "batches" && unit !== "listings") ||
    typeof detail !== "string" ||
    detail.length === 0
  ) {
    throw new UiApiError("Inventory progress was malformed.");
  }
  return {
    phase,
    completed: Number(completed),
    ...(total === undefined ? {} : { total: Number(total) }),
    unit,
    detail,
  };
}

async function streamingRepricingPreview(
  rules: PricingRules,
  forceRefresh: boolean,
  onProgress: (progress: PricingProgress) => void,
): Promise<PricingPreview> {
  const response = await fetch(
    `/api/repricing/preview${forceRefresh ? "?forceRefresh=true" : ""}`,
    {
      method: "POST",
      headers: {
        Accept: "application/x-ndjson, application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(rules),
    },
  );
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-ndjson")) {
    const body = await responseBody(response);
    if (!response.ok) {
      const code = apiCode(body);
      notifyAuthenticationRequired(code);
      throw new UiApiError(
        apiMessage(body, `Request failed (${String(response.status)}).`),
        code,
      );
    }
    return decodeResponse(pricingPreviewDecoder, body);
  }
  if (!response.ok || response.body === null) {
    throw new UiApiError(
      `Inventory preview stream failed (${String(response.status)}).`,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let preview: PricingPreview | undefined;
  const handleLine = (line: string) => {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new UiApiError("Inventory progress was malformed.");
    }
    const event = objectValue(value);
    if (event?.type === "progress") {
      onProgress(pricingProgress(event.progress));
      return;
    }
    if (event?.type === "complete") {
      preview = decodeResponse(pricingPreviewDecoder, event.preview);
      return;
    }
    if (event?.type === "error") {
      const code = typeof event.code === "string" ? event.code : undefined;
      notifyAuthenticationRequired(code);
      throw new UiApiError(
        apiMessage(event, "The inventory preview could not be created."),
        code,
      );
    }
    throw new UiApiError("Inventory progress was malformed.");
  };
  let streamDone = false;
  while (!streamDone) {
    const chunk = await reader.read();
    streamDone = chunk.done;
    buffered += decoder.decode(chunk.value, { stream: !chunk.done });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  }
  handleLine(buffered);
  if (preview === undefined) {
    throw new UiApiError("Inventory preview stream ended before completion.");
  }
  return preview;
}

export const uiApi = {
  sellerConnection: (): Promise<SellerConnectionStatus> =>
    requestJson("/api/auth/status", sellerConnectionDecoder),
  startSellerPairing: (): Promise<SellerPairingChallenge> =>
    requestJson("/api/auth/pairing", sellerPairingDecoder, {
      method: "POST",
      body: "{}",
    }),
  disconnectSeller: (): Promise<SellerConnectionStatus> =>
    requestJson("/api/auth/disconnect", sellerConnectionDecoder, {
      method: "POST",
      body: "{}",
    }),
  discordWebhook: (): Promise<DiscordWebhookStatus> =>
    requestJson("/api/notifications/discord", discordWebhookStatusDecoder),
  connectDiscordWebhook: (webhookUrl: string): Promise<DiscordWebhookStatus> =>
    requestJson(
      "/api/notifications/discord/connect",
      discordWebhookStatusDecoder,
      { method: "POST", body: JSON.stringify({ webhookUrl }) },
    ),
  disconnectDiscordWebhook: (): Promise<DiscordWebhookStatus> =>
    requestJson(
      "/api/notifications/discord/disconnect",
      discordWebhookStatusDecoder,
      { method: "POST", body: "{}" },
    ),
  testDiscordWebhook: (): Promise<DiscordWebhookTestResult> =>
    requestJson("/api/notifications/discord/test", discordWebhookTestDecoder, {
      method: "POST",
      body: "{}",
    }),
  settings: (): Promise<Settings> =>
    requestJson("/api/settings", settingsDecoder),
  saveSettings: (settings: SettingsUpdate): Promise<Settings> =>
    requestJson("/api/settings", settingsDecoder, {
      method: "PUT",
      body: JSON.stringify(settings),
    }),
  printTest: (actionId: string, settings: SettingsUpdate): Promise<void> =>
    requestJson(`/api/print-tests/${encodeURIComponent(actionId)}`, discard, {
      method: "POST",
      body: JSON.stringify(settings),
    }),
  printAddressLabel: (address: string): Promise<void> =>
    requestJson("/api/address-labels/print", discard, {
      method: "POST",
      body: JSON.stringify({ address }),
    }),
  shipmentScannerStatus: (): Promise<ShipmentScannerStatus> =>
    requestJson("/api/shipment-scanner", shipmentScannerStatusDecoder),
  scanShipmentTag: (tagId: number): Promise<ShipmentScanResult> =>
    requestJson("/api/shipment-scanner/scan", shipmentScanResultDecoder, {
      method: "POST",
      body: JSON.stringify({ tagId }),
    }),
  markScannedShipment: (
    tagId: number,
    ref: ProviderOrderRef,
  ): Promise<ShipmentScanResult> =>
    requestJson(
      "/api/shipment-scanner/mark-shipped",
      shipmentScanResultDecoder,
      {
        method: "POST",
        body: JSON.stringify({ tagId, ref }),
      },
    ),
  marketplaceConnections: (force = false): Promise<MarketplaceConnections> =>
    requestJson(
      `/api/marketplace-connections${force ? "?refresh=1" : ""}`,
      marketplaceConnectionsDecoder,
    ),
  marketplaceCredentials: (
    connectionId: string,
  ): Promise<MarketplaceCredentialStatus> =>
    requestJson(
      `/api/marketplace-connections/${encodeURIComponent(connectionId)}/credentials`,
      marketplaceCredentialStatusDecoder,
    ),
  saveMarketplaceCredentials: (
    connectionId: string,
    values: Readonly<Record<string, string>>,
  ): Promise<MarketplaceCredentialStatus> =>
    requestJson(
      `/api/marketplace-connections/${encodeURIComponent(connectionId)}/credentials`,
      marketplaceCredentialStatusDecoder,
      { method: "PUT", body: JSON.stringify({ values }) },
    ),
  removeMarketplaceCredentials: (
    connectionId: string,
  ): Promise<MarketplaceCredentialStatus> =>
    requestJson(
      `/api/marketplace-connections/${encodeURIComponent(connectionId)}/credentials`,
      marketplaceCredentialStatusDecoder,
      { method: "DELETE" },
    ),
  inventory: (connectionId?: string): Promise<InventoryList> => {
    const query = new URLSearchParams();
    if (connectionId !== undefined) query.set("connectionId", connectionId);
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    return requestJson(`/api/inventory${suffix}`, inventoryListDecoder);
  },
  localInventoryImportPreview: (): Promise<LocalInventoryImportPreview> =>
    requestJson(
      "/api/local-inventory/import-preview",
      localInventoryImportPreviewDecoder,
    ),
  importMarketplaceInventory: (): Promise<LocalInventoryImportResult> =>
    requestJson(
      "/api/local-inventory/import",
      localInventoryImportResultDecoder,
      {
        method: "POST",
        body: JSON.stringify({
          confirmation: "IMPORT_MARKETPLACE_STOCK",
        }),
      },
    ),
  addLocalInventory: (
    connectionId: string,
    input: {
      readonly productId: number;
      readonly productConditionId: number;
      readonly quantity: number;
    },
  ): Promise<LocalInventoryItemResponse> =>
    requestJson(
      `/api/local-inventory/catalog-items?connectionId=${encodeURIComponent(connectionId)}`,
      localInventoryItemResponseDecoder,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  setLocalInventoryQuantity: (
    localInventoryId: string,
    onHand: number,
  ): Promise<LocalInventoryItemResponse> =>
    requestJson(
      `/api/local-inventory/items/${encodeURIComponent(localInventoryId)}`,
      localInventoryItemResponseDecoder,
      {
        method: "PUT",
        body: JSON.stringify({ onHand }),
      },
    ),
  previewMarketplacePublication: (input: {
    readonly connectionId: string;
    readonly localInventoryId: string;
    readonly quantity: number;
    readonly price: { readonly currency: string; readonly minorUnits: number };
  }): Promise<MarketplacePublicationPreviewResponse> =>
    requestJson(
      "/api/local-inventory/publications/preview",
      marketplacePublicationPreviewResponseDecoder,
      { method: "POST", body: JSON.stringify(input) },
    ),
  quoteMarketplaceListing: (input: {
    readonly connectionId: string;
    readonly exactIdentity: {
      readonly namespace: string;
      readonly value: string;
      readonly precision: "exact-variant" | "product";
    };
  }): Promise<MarketplaceListingQuoteResponse> =>
    requestJson(
      "/api/local-inventory/publications/quote",
      marketplaceListingQuoteResponseDecoder,
      { method: "POST", body: JSON.stringify(input) },
    ),
  publishMarketplacePublication: (
    previewId: string,
  ): Promise<MarketplacePublicationJobResponse> =>
    requestJson(
      `/api/local-inventory/publications/previews/${encodeURIComponent(previewId)}/publish`,
      marketplacePublicationJobResponseDecoder,
      { method: "POST", body: "{}" },
    ),
  updateInventory: (
    connectionId: string,
    inventoryKey: string,
    quantity: number,
    price?: { readonly currency: string; readonly minorUnits: number },
  ): Promise<InventoryMutationResult> =>
    requestJson(
      `/api/connections/${encodeURIComponent(connectionId)}/inventory/${encodeURIComponent(inventoryKey)}`,
      inventoryMutationDecoder,
      {
        method: "POST",
        body: JSON.stringify({
          quantity,
          ...(price === undefined ? {} : { price }),
        }),
      },
    ),
  orders: (force = false): Promise<OrderList> => {
    const query = new URLSearchParams();
    if (force) query.set("refresh", "1");
    return requestJson(`/api/orders?${query.toString()}`, orderListDecoder);
  },
  readyOrders: (): Promise<OrderList> =>
    requestJson("/api/orders/ready", orderListDecoder),
  synchronizeReadyOrders: (): Promise<OrderList> =>
    requestJson("/api/orders/sync", orderListDecoder, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  order: (
    ref: ProviderOrderRef,
    force = false,
    signal?: AbortSignal,
  ): Promise<OrderDetail> =>
    requestJson(
      providerOrderApiPath(ref, undefined, force),
      orderDetailDecoder,
      signal === undefined ? {} : { signal },
    ),
  masterPullList: (
    force = false,
    signal?: AbortSignal,
  ): Promise<MasterPullList> =>
    requestJson(
      `/api/orders/pull-list${force ? "?refresh=1" : ""}`,
      masterPullListDecoder,
      signal === undefined ? {} : { signal },
    ),
  setPullListRowPulled: (
    rowKey: string,
    pulled: boolean,
  ): Promise<MasterPullList["rows"][number]> =>
    requestJson(
      `/api/orders/pull-list/items/${encodeURIComponent(rowKey)}`,
      pullListRowDecoder,
      {
        method: "POST",
        body: JSON.stringify({ pulled }),
      },
    ),
  payments: (
    page: number,
    status: string,
    force = false,
  ): Promise<PaymentsPage> => {
    const query = new URLSearchParams({ page: String(page) });
    if (status !== "") query.set("status", status);
    if (force) query.set("refresh", "1");
    return requestJson(
      `/api/payments?${query.toString()}`,
      paymentsPageDecoder,
    );
  },
  payment: (referenceId: string, force = false): Promise<PaymentDetail> =>
    requestJson(
      `/api/payments/${encodeURIComponent(referenceId)}${force ? "?refresh=1" : ""}`,
      paymentDetailDecoder,
    ),
  feedback: (
    page: number,
    rating: string,
    commentsOnly: boolean,
    days: string,
    force = false,
    signal?: AbortSignal,
  ): Promise<FeedbackPage> => {
    const query = new URLSearchParams({ page: String(page) });
    if (rating !== "") query.set("rating", rating);
    if (commentsOnly) query.set("comments", "1");
    if (days !== "") query.set("days", days);
    if (force) query.set("refresh", "1");
    return requestJson(
      `/api/feedback?${query.toString()}`,
      feedbackPageDecoder,
      signal === undefined ? {} : { signal },
    );
  },
  messageCount: (
    force = false,
    signal?: AbortSignal,
  ): Promise<UnreadMessages> =>
    requestJson(
      `/api/messages/unread-count${force ? "?refresh=1" : ""}`,
      unreadMessagesDecoder,
      signal === undefined ? {} : { signal },
    ),
  messages: (
    page: number,
    orderNumber: string,
    includeDeleted: boolean,
    force = false,
    signal?: AbortSignal,
  ): Promise<MessagesPage> => {
    const query = new URLSearchParams({ page: String(page) });
    if (orderNumber !== "") query.set("orderNumber", orderNumber);
    if (includeDeleted) query.set("deleted", "1");
    if (force) query.set("refresh", "1");
    return requestJson(
      `/api/messages?${query.toString()}`,
      messagesPageDecoder,
      signal === undefined ? {} : { signal },
    );
  },
  message: (
    threadId: number,
    page: number,
    force = false,
    signal?: AbortSignal,
  ): Promise<MessageThread> => {
    const query = new URLSearchParams({ page: String(page) });
    if (force) query.set("refresh", "1");
    return requestJson(
      `/api/messages/${String(threadId)}?${query.toString()}`,
      messageThreadDecoder,
      signal === undefined ? {} : { signal },
    );
  },
  markMessageThreadRead: (threadId: number): Promise<MessageMutationResult> =>
    requestJson(
      `/api/messages/${String(threadId)}/mark-read`,
      messageMutationDecoder,
      {
        method: "POST",
        body: "{}",
      },
    ),
  markAllMessageThreadsRead: (): Promise<MarkAllMessagesReadResult> =>
    requestJson("/api/messages/mark-all-read", markAllMessagesReadDecoder, {
      method: "POST",
      body: "{}",
    }),
  replyToMessageThread: (
    threadId: number,
    body: string,
  ): Promise<MessageMutationResult> =>
    requestJson(
      `/api/messages/${String(threadId)}/reply`,
      messageMutationDecoder,
      {
        method: "POST",
        body: JSON.stringify({ body }),
      },
    ),
  printOrder: (
    ref: ProviderOrderRef,
    actionType: "print-address-label" | "print-packing-slip",
  ): Promise<void> =>
    requestJson(providerOrderApiPath(ref, "print"), discard, {
      method: "POST",
      body: JSON.stringify({ actionType }),
    }),
  addTracking: (
    ref: ProviderOrderRef,
    trackingNumber: string,
  ): Promise<TrackingResult> =>
    requestJson(providerOrderApiPath(ref, "tracking"), trackingResultDecoder, {
      method: "POST",
      body: JSON.stringify({ trackingNumber }),
    }),
  markShipped: (ref: ProviderOrderRef): Promise<ShipmentResult> =>
    requestJson(
      providerOrderApiPath(ref, "mark-shipped"),
      shipmentResultDecoder,
      {
        method: "POST",
        body: "{}",
      },
    ),
  pirateShip: (ref: ProviderOrderRef): Promise<PirateShipResult> =>
    requestJson(providerOrderApiPath(ref, "pirate-ship"), pirateShipDecoder),
  catalogSearch: (
    connectionId: string,
    query: string,
    productLine: string,
    setName: string,
    offset: number,
    signal?: AbortSignal,
  ): Promise<CatalogSearch> => {
    const parameters = new URLSearchParams({
      connectionId,
      q: query,
      offset: String(offset),
    });
    if (productLine !== "") parameters.set("productLine", productLine);
    if (setName !== "") parameters.set("setName", setName);
    return requestJson(
      `/api/catalog/search?${parameters.toString()}`,
      catalogSearchDecoder,
      signal === undefined ? {} : { signal },
    );
  },
  catalogProduct: (
    connectionId: string,
    productId: number,
  ): Promise<CatalogProduct> =>
    requestJson(
      `/api/catalog/products/${String(productId)}?connectionId=${encodeURIComponent(connectionId)}`,
      catalogProductDecoder,
    ),
  previewAddition: (
    connectionId: string,
    body: unknown,
  ): Promise<AdditionPreview> =>
    requestJson(
      `/api/inventory-additions/preview?connectionId=${encodeURIComponent(connectionId)}`,
      additionPreviewDecoder,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),
  queueAddition: (
    connectionId: string,
    previewId: string,
  ): Promise<QueuedJobs<InventoryJob>> =>
    requestJson(
      `/api/inventory-additions/previews/${encodeURIComponent(previewId)}/queue?connectionId=${encodeURIComponent(connectionId)}`,
      queuedInventoryJobsDecoder,
      {
        method: "POST",
        body: "{}",
      },
    ),
  inventoryJobs: (): Promise<InventoryQueueResponse> =>
    requestJson("/api/inventory-additions", inventoryQueueDecoder),
  priceJobs: (): Promise<PriceQueueResponse> =>
    requestJson("/api/price-updates", priceQueueDecoder),
  mutateJob: <T extends InventoryJob | PriceJob>(
    queue: "inventory" | "price",
    jobId: string,
    action: "cancel" | "resubmit",
  ): Promise<QueuedJob<T>> => {
    const base =
      queue === "inventory" ? "/api/inventory-additions" : "/api/price-updates";
    const path = `${base}/${encodeURIComponent(jobId)}${action === "resubmit" ? "/resubmit" : ""}`;
    const options = {
      method: action === "resubmit" ? "POST" : "DELETE",
      body: "{}",
    };
    return (
      queue === "inventory"
        ? requestJson(path, queuedInventoryJobDecoder, options)
        : requestJson(path, queuedPriceJobDecoder, options)
    ) as Promise<QueuedJob<T>>;
  },
  internalJobs: (): Promise<InternalJobsResponse> =>
    requestJson("/api/internal-jobs", internalJobsDecoder),
  createJobSchedule: (
    schedule: JobScheduleInput,
  ): Promise<JobScheduleResponse> =>
    requestJson("/api/internal-jobs/schedules", jobScheduleResponseDecoder, {
      method: "POST",
      body: JSON.stringify(schedule),
    }),
  updateJobSchedule: (
    scheduleId: string,
    schedule: JobScheduleInput,
  ): Promise<JobScheduleResponse> =>
    requestJson(
      `/api/internal-jobs/schedules/${encodeURIComponent(scheduleId)}`,
      jobScheduleResponseDecoder,
      { method: "PUT", body: JSON.stringify(schedule) },
    ),
  deleteJobSchedule: (scheduleId: string): Promise<DeletedResponse> =>
    requestJson(
      `/api/internal-jobs/schedules/${encodeURIComponent(scheduleId)}`,
      deletedResponseDecoder,
      { method: "DELETE", body: "{}" },
    ),
  runJobSchedule: (scheduleId: string): Promise<JobRunResponse> =>
    requestJson(
      `/api/internal-jobs/schedules/${encodeURIComponent(scheduleId)}/run`,
      jobRunResponseDecoder,
      { method: "POST", body: "{}" },
    ),
  cancelJobRun: (runId: string): Promise<JobRunResponse> =>
    requestJson(
      `/api/internal-jobs/runs/${encodeURIComponent(runId)}`,
      jobRunResponseDecoder,
      { method: "DELETE", body: "{}" },
    ),
  scheduleListing: (listing: ScheduledListing): Promise<JobScheduleResponse> =>
    requestJson("/api/internal-jobs/listings", jobScheduleResponseDecoder, {
      method: "POST",
      body: JSON.stringify(listing),
    }),
  repricingPreview: (
    rules: PricingRules,
    forceRefresh: boolean,
    onProgress: (progress: PricingProgress) => void,
  ): Promise<PricingPreview> =>
    streamingRepricingPreview(rules, forceRefresh, onProgress),
  queuePrices: (
    previewId: string,
    rowIds: readonly string[],
  ): Promise<QueuedJobs<PriceJob>> =>
    requestJson(
      `/api/repricing/previews/${encodeURIComponent(previewId)}/queue`,
      queuedPriceJobsDecoder,
      {
        method: "POST",
        body: JSON.stringify({ rowIds }),
      },
    ),
  queueRemoval: (
    previewId: string,
    rowId: string,
  ): Promise<QueuedJob<InventoryJob>> =>
    requestJson(
      `/api/repricing/previews/${encodeURIComponent(previewId)}/remove`,
      queuedInventoryJobDecoder,
      {
        method: "POST",
        body: JSON.stringify({ rowId }),
      },
    ),
};

export function packingSlipUrl(ref: ProviderOrderRef): string {
  return providerOrderApiPath(ref, "packing-slip");
}

export function sellerPortalOrderUrl(orderNumber: string): string {
  return `https://sellerportal.tcgplayer.com/orders/${encodeURIComponent(orderNumber)}`;
}

export function orderDetailUrl(ref: ProviderOrderRef): string {
  return `#orders/${encodeURIComponent(ref.connectionId)}/${encodeURIComponent(ref.remoteId)}`;
}

function providerOrderApiPath(
  ref: ProviderOrderRef,
  action?: string,
  force = false,
): string {
  const suffix = action === undefined ? "" : `/${action}`;
  const query = new URLSearchParams();
  if (force) query.set("refresh", "1");
  const serialized = query.toString();
  return `/api/connections/${encodeURIComponent(ref.connectionId)}/orders/${encodeURIComponent(ref.remoteId)}${suffix}${serialized === "" ? "" : `?${serialized}`}`;
}

export function masterPullListUrl(): string {
  return "#orders/pull-list";
}

export function sellerPortalPaymentsUrl(
  experience: PaymentsPage["experience"],
): string {
  return experience === "legacy"
    ? "https://store.tcgplayer.com/admin/payment/sellerpayment"
    : "https://sellerportal.tcgplayer.com/payments";
}
