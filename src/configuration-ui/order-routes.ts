import { ConfigurationError } from "../errors.js";
import type {
  ManagedOrderRefundInput,
  ManualPrintActionType,
} from "../order-management.js";
import type {
  ConfigurationRouteContext,
  ConfigurationRouteHandler,
} from "./context.js";
import {
  containsControlCharacter,
  objectValue,
  readJsonBody,
  safeText,
  sendBytes,
  sendJson,
  withRequestAbort,
} from "./http.js";

export const handleOrderRoute: ConfigurationRouteHandler = async (context) => {
  const { request, response, url } = context;
  if (request.method === "GET" && url.pathname === "/api/orders") {
    if (!requireOrderService(context)) return true;
    const status = url.searchParams.get("status");
    if (status !== null && status !== "ready-to-ship") {
      sendJson(response, 400, {
        message: "The order status filter is invalid.",
      });
      return true;
    }
    const scope = status === "ready-to-ship" ? "ready-to-ship" : "all";
    const force = url.searchParams.get("refresh") === "1";
    const result = await withRequestAbort(request, response, (signal) =>
      scope === "ready-to-ship" && context.orderSync !== undefined
        ? context.orderSync.listReadyOrders({ force, signal })
        : context.orderService.listOrders(scope, { force, signal }),
    );
    if (!response.destroyed) sendJson(response, 200, result);
    return true;
  }
  if (
    request.method === "GET" &&
    url.pathname === "/api/orders/refunds/options"
  ) {
    if (!requireOrderService(context)) return true;
    const result = await withRequestAbort(request, response, (signal) =>
      context.orderService.getRefundOptions({
        force: url.searchParams.get("refresh") === "1",
        signal,
      }),
    );
    if (!response.destroyed) sendJson(response, 200, result);
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/orders/pull-list") {
    if (!requireOrderService(context)) return true;
    const result = await withRequestAbort(request, response, (signal) =>
      context.orderService.getMasterPullList({
        force: url.searchParams.get("refresh") === "1",
        signal,
      }),
    );
    if (!response.destroyed) sendJson(response, 200, result);
    return true;
  }
  const orderAction = parseOrderAction(request.method, url.pathname);
  if (orderAction === undefined) return false;
  if (!requireOrderService(context)) return true;
  const orderNumber = decodeOrderNumber(url.pathname, orderAction.action);
  if (orderAction.method === "GET") {
    if (orderAction.action === "pirate-ship") {
      const result = await withRequestAbort(request, response, (signal) =>
        context.orderService.preparePirateShip(orderNumber, signal),
      );
      if (!response.destroyed) sendJson(response, 200, result);
    } else if (orderAction.action === "packing-slip") {
      const document = await withRequestAbort(request, response, (signal) =>
        context.orderService.getPackingSlip(orderNumber, signal),
      );
      if (!response.destroyed) {
        response.setHeader(
          "Content-Disposition",
          'attachment; filename="packing-slip.pdf"',
        );
        sendBytes(response, 200, "application/pdf", document.bytes);
      }
    } else {
      const result = await withRequestAbort(request, response, (signal) =>
        context.orderService.getOrder(orderNumber, {
          force: url.searchParams.get("refresh") === "1",
          signal,
        }),
      );
      if (!response.destroyed) sendJson(response, 200, result);
    }
    return true;
  }
  if (orderAction.action === "print") {
    const actionType = parseManualPrintAction(await readJsonBody(request));
    await withRequestAbort(request, response, (signal) =>
      context.orderService.print(orderNumber, actionType, signal),
    );
    if (!response.destroyed) {
      sendJson(response, 200, { printed: true, orderNumber, actionType });
    }
  } else if (orderAction.action === "tracking") {
    const trackingNumber = objectValue(
      await readJsonBody(request),
    )?.trackingNumber;
    if (!safeText(trackingNumber) || trackingNumber.length > 256) {
      throw new ConfigurationError(["A valid tracking number is required."]);
    }
    const result = await withRequestAbort(request, response, (signal) =>
      context.orderService.addTracking(orderNumber, trackingNumber, signal),
    );
    if (!response.destroyed) sendJson(response, 200, result);
  } else if (orderAction.action === "mark-shipped") {
    await readJsonBody(request);
    const result = await withRequestAbort(request, response, (signal) =>
      context.orderService.markShipped(orderNumber, signal),
    );
    if (!response.destroyed) sendJson(response, 200, result);
  } else {
    const refund = parseOrderRefund(await readJsonBody(request));
    const result = await withRequestAbort(request, response, (signal) =>
      context.orderService.refundOrder(orderNumber, refund, signal),
    );
    if (!response.destroyed) sendJson(response, 200, result);
  }
  return true;
};

export const handleAddressLabelRoute: ConfigurationRouteHandler = async (
  context,
) => {
  const { request, response, url, executeAddressLabel } = context;
  if (
    request.method !== "POST" ||
    url.pathname !== "/api/address-labels/print"
  ) {
    return false;
  }
  if (executeAddressLabel === undefined) {
    sendJson(response, 503, {
      message: "Address-label printing is unavailable.",
    });
    return true;
  }
  const lines = parsePastedAddress(await readJsonBody(request));
  await withRequestAbort(request, response, (signal) =>
    executeAddressLabel(lines, signal),
  );
  if (!response.destroyed) sendJson(response, 200, { printed: true });
  return true;
};

function requireOrderService(
  context: ConfigurationRouteContext,
): context is ConfigurationRouteContext & {
  readonly orderService: NonNullable<ConfigurationRouteContext["orderService"]>;
} {
  if (context.orderService !== undefined) return true;
  sendJson(context.response, 503, {
    message: "Order management is unavailable.",
  });
  return false;
}

type OrderAction =
  | { readonly method: "GET"; readonly action?: "pirate-ship" | "packing-slip" }
  | {
      readonly method: "POST";
      readonly action: "print" | "tracking" | "mark-shipped" | "refund";
    };

function parseOrderAction(
  method: string | undefined,
  pathname: string,
): OrderAction | undefined {
  if (method === "GET" && /^\/api\/orders\/[^/]{1,384}$/u.test(pathname)) {
    return { method };
  }
  if (
    method === "GET" &&
    /^\/api\/orders\/[^/]{1,384}\/pirate-ship$/u.test(pathname)
  ) {
    return { method, action: "pirate-ship" };
  }
  if (
    method === "GET" &&
    /^\/api\/orders\/[^/]{1,384}\/packing-slip$/u.test(pathname)
  ) {
    return { method, action: "packing-slip" };
  }
  if (method !== "POST") return undefined;
  for (const action of [
    "print",
    "tracking",
    "mark-shipped",
    "refund",
  ] as const) {
    if (new RegExp(`^/api/orders/[^/]{1,384}/${action}$`, "u").test(pathname)) {
      return { method, action };
    }
  }
  return undefined;
}

function decodeOrderNumber(pathname: string, action?: string): string {
  const suffix = action === undefined ? "" : `/${action}`;
  const encoded = pathname.slice(
    "/api/orders/".length,
    suffix === "" ? undefined : -suffix.length,
  );
  try {
    const orderNumber = decodeURIComponent(encoded);
    if (!safeText(orderNumber) || orderNumber.length > 128) {
      throw new Error("invalid");
    }
    return orderNumber;
  } catch {
    throw new ConfigurationError(["The order number is invalid."]);
  }
}

function parseManualPrintAction(value: unknown): ManualPrintActionType {
  const actionType = objectValue(value)?.actionType;
  if (
    actionType !== "print-address-label" &&
    actionType !== "print-packing-slip"
  ) {
    throw new ConfigurationError(["A valid order print action is required."]);
  }
  return actionType;
}

function parseOrderRefund(value: unknown): ManagedOrderRefundInput {
  const source = objectValue(value);
  if (source === undefined) {
    throw new ConfigurationError(["A valid refund request is required."]);
  }
  const type = source.type;
  const origin = boundedRefundText(source.origin, "Refund origin", 256);
  const reason = boundedRefundText(source.reason, "Refund reason", 256);
  const reasonText = refundMessage(source.reasonText);
  if (type === "full") return { type, origin, reason, reasonText };
  if (type !== "partial") {
    throw new ConfigurationError(["Refund type must be full or partial."]);
  }
  const shippingRefundAmount = refundAmount(
    source.shippingRefundAmount,
    "Shipping refund",
  );
  if (!Array.isArray(source.products) || source.products.length > 500) {
    throw new ConfigurationError([
      "A partial refund can contain at most 500 product lines.",
    ]);
  }
  const seen = new Set<string>();
  const products = source.products.map((value, index) => {
    const product = objectValue(value);
    const skuId = boundedRefundText(
      product?.skuId,
      `Refund product ${String(index + 1)} SKU`,
      128,
    );
    if (seen.has(skuId)) {
      throw new ConfigurationError([
        "A partial refund cannot repeat the same SKU.",
      ]);
    }
    seen.add(skuId);
    return {
      skuId,
      refundAmount: refundAmount(
        product?.refundAmount,
        `Refund product ${String(index + 1)} amount`,
      ),
    };
  });
  if (
    shippingRefundAmount === 0 &&
    products.every((product) => product.refundAmount === 0)
  ) {
    throw new ConfigurationError([
      "A partial refund must total at least $0.01.",
    ]);
  }
  return {
    type,
    origin,
    reason,
    reasonText,
    shippingRefundAmount,
    products,
  };
}

function boundedRefundText(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (typeof value !== "string") {
    throw new ConfigurationError([`${label} is required.`]);
  }
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximum ||
    containsControlCharacter(normalized)
  ) {
    throw new ConfigurationError([`${label} is invalid.`]);
  }
  return normalized;
}

function refundMessage(value: unknown): string {
  if (typeof value !== "string") {
    throw new ConfigurationError(["A refund message is required."]);
  }
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0 || normalized.length > 500) {
    throw new ConfigurationError([
      "The refund message must contain 1-500 characters.",
    ]);
  }
  for (const character of normalized) {
    const code = character.charCodeAt(0);
    if (
      (code <= 0x1f && character !== "\n" && character !== "\t") ||
      code === 0x7f
    ) {
      throw new ConfigurationError([
        "The refund message contains an unsupported character.",
      ]);
    }
  }
  return normalized;
}

function refundAmount(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1_000_000 ||
    Math.abs(value * 100 - Math.round(value * 100)) > 1e-9
  ) {
    throw new ConfigurationError([
      `${label} must be a non-negative amount in cents.`,
    ]);
  }
  return value;
}

function parsePastedAddress(value: unknown): readonly string[] {
  const address = objectValue(value)?.address;
  if (typeof address !== "string" || address.length > 1024) {
    throw new ConfigurationError([
      "The pasted address must be 1,024 characters or fewer.",
    ]);
  }
  const lines = address
    .split(/\r\n?|\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    lines.length === 0 ||
    lines.length > 8 ||
    lines.some((line) => line.length > 128 || containsControlCharacter(line))
  ) {
    throw new ConfigurationError([
      "The pasted address must contain one to eight valid lines of at most 128 characters each.",
    ]);
  }
  return lines;
}
