import type {
  AdditionPreview,
  ApiErrorBody,
  CatalogProduct,
  CatalogSearch,
  FeedbackPage,
  InventoryJob,
  InventoryQueueResponse,
  OrderList,
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
      const code =
        typeof body === "object" && body !== null && "code" in body
          ? String(body.code)
          : undefined;
      throw new UiApiError(
        apiMessage(body, `Request failed (${String(response.status)}).`),
        code,
      );
    }
    return body as PricingPreview;
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
      preview = event.preview as PricingPreview;
      return;
    }
    if (event?.type === "error") {
      throw new UiApiError(
        apiMessage(event, "The inventory preview could not be created."),
        typeof event.code === "string" ? event.code : undefined,
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
      signal === undefined ? {} : { signal },
    );
  },
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
    onProgress: (progress: PricingProgress) => void,
  ): Promise<PricingPreview> =>
    streamingRepricingPreview(rules, forceRefresh, onProgress),
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
