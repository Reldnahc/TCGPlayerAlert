import type {
  AdditionPreview,
  ApiErrorBody,
  CatalogProduct,
  CatalogSearch,
  InventoryJob,
  InventoryQueueResponse,
  OrderList,
  PaymentDetail,
  PaymentsPage,
  PirateShipResult,
  PriceJob,
  PriceQueueResponse,
  PricingPreview,
  PricingRules,
  QueuedJob,
  QueuedJobs,
  Settings,
  SettingsUpdate,
  ShipmentResult,
  TrackingResult,
} from "./contracts.js";

export class UiApiError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "UiApiError";
    if (code !== undefined) this.code = code;
  }
}

async function responseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("application/json")
    ? response.json()
    : response.text();
}

function apiMessage(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null) return fallback;
  const candidate = body as ApiErrorBody;
  if (candidate.issues !== undefined && candidate.issues.length > 0) {
    return candidate.issues.join(" ");
  }
  return candidate.message ?? fallback;
}

export async function requestJson<T>(
  path: string,
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
    const code =
      typeof body === "object" && body !== null && "code" in body
        ? String(body.code)
        : undefined;
    throw new UiApiError(
      apiMessage(body, `Request failed (${String(response.status)}).`),
      code,
    );
  }
  return body as T;
}

export const uiApi = {
  settings: (): Promise<Settings> => requestJson("/api/settings"),
  saveSettings: (settings: SettingsUpdate): Promise<Settings> =>
    requestJson("/api/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),
  printTest: (actionId: string, settings: SettingsUpdate): Promise<void> =>
    requestJson(`/api/print-tests/${encodeURIComponent(actionId)}`, {
      method: "POST",
      body: JSON.stringify(settings),
    }),
  orders: (
    scope: "all" | "ready-to-ship",
    force = false,
  ): Promise<OrderList> => {
    const query = new URLSearchParams();
    if (scope === "ready-to-ship") query.set("status", "ready-to-ship");
    if (force) query.set("refresh", "1");
    return requestJson(`/api/orders?${query.toString()}`);
  },
  payments: (
    page: number,
    status: string,
    force = false,
  ): Promise<PaymentsPage> => {
    const query = new URLSearchParams({ page: String(page) });
    if (status !== "") query.set("status", status);
    if (force) query.set("refresh", "1");
    return requestJson(`/api/payments?${query.toString()}`);
  },
  payment: (referenceId: string, force = false): Promise<PaymentDetail> =>
    requestJson(
      `/api/payments/${encodeURIComponent(referenceId)}${force ? "?refresh=1" : ""}`,
    ),
  printOrder: (orderNumber: string, actionType: string): Promise<void> =>
    requestJson(`/api/orders/${encodeURIComponent(orderNumber)}/print`, {
      method: "POST",
      body: JSON.stringify({ actionType }),
    }),
  addTracking: (
    orderNumber: string,
    trackingNumber: string,
  ): Promise<TrackingResult> =>
    requestJson(`/api/orders/${encodeURIComponent(orderNumber)}/tracking`, {
      method: "POST",
      body: JSON.stringify({ trackingNumber }),
    }),
  markShipped: (orderNumber: string): Promise<ShipmentResult> =>
    requestJson(`/api/orders/${encodeURIComponent(orderNumber)}/mark-shipped`, {
      method: "POST",
      body: "{}",
    }),
  pirateShip: (orderNumber: string): Promise<PirateShipResult> =>
    requestJson(`/api/orders/${encodeURIComponent(orderNumber)}/pirate-ship`),
  catalogSearch: (
    query: string,
    productLine: string,
    setName: string,
    offset: number,
    signal?: AbortSignal,
  ): Promise<CatalogSearch> => {
    const parameters = new URLSearchParams({
      q: query,
      offset: String(offset),
    });
    if (productLine !== "") parameters.set("productLine", productLine);
    if (setName !== "") parameters.set("setName", setName);
    return requestJson(
      `/api/catalog/search?${parameters.toString()}`,
      signal === undefined ? {} : { signal },
    );
  },
  catalogProduct: (productId: number): Promise<CatalogProduct> =>
    requestJson(`/api/catalog/products/${String(productId)}`),
  previewAddition: (body: unknown): Promise<AdditionPreview> =>
    requestJson("/api/inventory-additions/preview", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  queueAddition: (previewId: string): Promise<QueuedJobs<InventoryJob>> =>
    requestJson(
      `/api/inventory-additions/previews/${encodeURIComponent(previewId)}/queue`,
      {
        method: "POST",
        body: "{}",
      },
    ),
  inventoryJobs: (): Promise<InventoryQueueResponse> =>
    requestJson("/api/inventory-additions"),
  priceJobs: (): Promise<PriceQueueResponse> =>
    requestJson("/api/price-updates"),
  mutateJob: <T extends InventoryJob | PriceJob>(
    queue: "inventory" | "price",
    jobId: string,
    action: "cancel" | "resubmit",
  ): Promise<QueuedJob<T>> => {
    const base =
      queue === "inventory" ? "/api/inventory-additions" : "/api/price-updates";
    return requestJson(
      `${base}/${encodeURIComponent(jobId)}${action === "resubmit" ? "/resubmit" : ""}`,
      {
        method: action === "resubmit" ? "POST" : "DELETE",
        body: "{}",
      },
    );
  },
  repricingPreview: (
    rules: PricingRules,
    forceRefresh: boolean,
  ): Promise<PricingPreview> =>
    requestJson(
      `/api/repricing/preview${forceRefresh ? "?forceRefresh=true" : ""}`,
      {
        method: "POST",
        body: JSON.stringify(rules),
      },
    ),
  queuePrices: (
    previewId: string,
    rowIds: readonly string[],
  ): Promise<QueuedJobs<PriceJob>> =>
    requestJson(
      `/api/repricing/previews/${encodeURIComponent(previewId)}/queue`,
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
      {
        method: "POST",
        body: JSON.stringify({ rowId }),
      },
    ),
};

export function packingSlipUrl(orderNumber: string): string {
  return `/api/orders/${encodeURIComponent(orderNumber)}/packing-slip`;
}

export function sellerPortalOrderUrl(orderNumber: string): string {
  return `https://sellerportal.tcgplayer.com/orders/${encodeURIComponent(orderNumber)}`;
}

export function sellerPortalPaymentsUrl(
  experience: PaymentsPage["experience"],
): string {
  return experience === "legacy"
    ? "https://store.tcgplayer.com/admin/payment/sellerpayment"
    : "https://sellerportal.tcgplayer.com/payments";
}
