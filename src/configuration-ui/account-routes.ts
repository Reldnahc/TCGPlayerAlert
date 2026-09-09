import {
  SELLER_PAYOUT_STATUS_VALUES,
  type SellerPayoutStatusCode,
} from "../payment-management.js";
import type {
  ConfigurationRouteContext,
  ConfigurationRouteHandler,
} from "./context.js";
import {
  HttpRouteError,
  objectValue,
  readJsonBody,
  safeText,
  sendJson,
  withRequestAbort,
} from "./http.js";
import { parseConnectionId } from "../marketplaces/identity.js";
import type { MarketplaceAccountServices } from "../marketplaces/account-workspaces.js";

const SELLER_PAYOUT_STATUSES = new Set<SellerPayoutStatusCode>(
  SELLER_PAYOUT_STATUS_VALUES,
);

export const handleSellerAccountRoute: ConfigurationRouteHandler = async (
  context,
) => {
  if (await handlePaymentRoute(context)) return true;
  if (await handleFeedbackRoute(context)) return true;
  return handleMessageRoute(context);
};

async function handlePaymentRoute(
  context: ConfigurationRouteContext,
): Promise<boolean> {
  const { request, response, url } = context;
  if (request.method === "GET" && url.pathname === "/api/payments") {
    const paymentService = await workspaceService(context, "payments");
    if (paymentService === undefined) return true;
    const page = parsePage(url.searchParams.get("page"), "payment");
    const statusValue = url.searchParams.get("status");
    if (
      statusValue !== null &&
      !SELLER_PAYOUT_STATUSES.has(statusValue as SellerPayoutStatusCode)
    ) {
      sendJson(response, 400, {
        message: "The payment status filter is invalid.",
      });
      return true;
    }
    const result = await withRequestAbort(request, response, (signal) =>
      paymentService.list({
        page,
        ...(statusValue === null
          ? {}
          : { status: statusValue as SellerPayoutStatusCode }),
        force: url.searchParams.get("refresh") === "1",
        signal,
      }),
    );
    if (!response.destroyed) sendJson(response, 200, result);
    return true;
  }
  if (
    request.method !== "GET" ||
    !/^\/api\/payments\/[^/]{1,768}$/u.test(url.pathname)
  ) {
    return false;
  }
  const paymentService = await workspaceService(context, "payments");
  if (paymentService === undefined) return true;
  const referenceId = decodeURIComponent(
    url.pathname.slice("/api/payments/".length),
  );
  if (!safeText(referenceId) || referenceId.length > 256) {
    sendJson(response, 400, { message: "The payout reference is invalid." });
    return true;
  }
  const result = await withRequestAbort(request, response, (signal) =>
    paymentService.get(referenceId, {
      force: url.searchParams.get("refresh") === "1",
      signal,
    }),
  );
  if (!response.destroyed) sendJson(response, 200, result);
  return true;
}

async function handleFeedbackRoute(
  context: ConfigurationRouteContext,
): Promise<boolean> {
  const { request, response, url } = context;
  if (request.method !== "GET" || url.pathname !== "/api/feedback") {
    return false;
  }
  const feedbackService = await workspaceService(context, "feedback");
  if (feedbackService === undefined) return true;
  const page = parsePage(url.searchParams.get("page"), "feedback");
  const ratingValue = url.searchParams.get("rating");
  const rating = ratingValue === null ? undefined : Number(ratingValue);
  if (
    rating !== undefined &&
    (!Number.isInteger(rating) || rating < 1 || rating > 5)
  ) {
    sendJson(response, 400, {
      message: "The feedback rating filter is invalid.",
    });
    return true;
  }
  const daysValue = url.searchParams.get("days");
  const days = daysValue === null ? undefined : Number(daysValue);
  if (
    days !== undefined &&
    (!Number.isInteger(days) || days < 1 || days > 36_500)
  ) {
    sendJson(response, 400, {
      message: "The feedback age filter is invalid.",
    });
    return true;
  }
  const commentsValue = url.searchParams.get("comments");
  if (commentsValue !== null && commentsValue !== "1") {
    sendJson(response, 400, {
      message: "The feedback comment filter is invalid.",
    });
    return true;
  }
  const result = await withRequestAbort(request, response, (signal) =>
    feedbackService.list({
      page,
      ...(rating === undefined ? {} : { rating: rating as 1 | 2 | 3 | 4 | 5 }),
      ...(commentsValue === "1" ? { commentsOnly: true } : {}),
      ...(days === undefined ? {} : { days }),
      force: url.searchParams.get("refresh") === "1",
      signal,
    }),
  );
  if (!response.destroyed) sendJson(response, 200, result);
  return true;
}

async function handleMessageRoute(
  context: ConfigurationRouteContext,
): Promise<boolean> {
  const { request, response, url } = context;
  const markReadMatch =
    request.method === "POST"
      ? /^\/api\/messages\/(\d{1,16})\/mark-read$/u.exec(url.pathname)
      : null;
  const replyMatch =
    request.method === "POST"
      ? /^\/api\/messages\/(\d{1,16})\/reply$/u.exec(url.pathname)
      : null;
  const detailMatch =
    request.method === "GET"
      ? /^\/api\/messages\/(\d{1,16})$/u.exec(url.pathname)
      : null;
  const isMessageRoute =
    (request.method === "GET" &&
      (url.pathname === "/api/messages" ||
        url.pathname === "/api/messages/unread-count")) ||
    (request.method === "POST" &&
      url.pathname === "/api/messages/mark-all-read") ||
    markReadMatch !== null ||
    replyMatch !== null ||
    detailMatch !== null;
  if (!isMessageRoute) return false;
  const messageService = await workspaceService(context, "messages");
  if (messageService === undefined) return true;
  if (
    request.method === "GET" &&
    url.pathname === "/api/messages/unread-count"
  ) {
    const count = await withRequestAbort(request, response, (signal) =>
      messageService.unreadCount({
        force: url.searchParams.get("refresh") === "1",
        signal,
      }),
    );
    if (!response.destroyed) sendJson(response, 200, { unreadCount: count });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/messages") {
    const page = parsePage(url.searchParams.get("page"), "message");
    const orderNumber = url.searchParams.get("orderNumber") ?? undefined;
    if (
      orderNumber !== undefined &&
      (!safeText(orderNumber) || orderNumber.length > 256)
    ) {
      sendJson(response, 400, {
        message: "The message order filter is invalid.",
      });
      return true;
    }
    const deletedValue = url.searchParams.get("deleted");
    if (deletedValue !== null && deletedValue !== "1") {
      sendJson(response, 400, {
        message: "The deleted-message filter is invalid.",
      });
      return true;
    }
    const result = await withRequestAbort(request, response, (signal) =>
      messageService.list({
        page,
        ...(orderNumber === undefined ? {} : { orderNumber }),
        ...(deletedValue === "1" ? { includeDeleted: true } : {}),
        force: url.searchParams.get("refresh") === "1",
        signal,
      }),
    );
    if (!response.destroyed) sendJson(response, 200, result);
    return true;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/messages/mark-all-read"
  ) {
    await readJsonBody(request);
    const result = await withRequestAbort(request, response, (signal) =>
      messageService.markAllRead(signal),
    );
    if (!response.destroyed) sendJson(response, 200, result);
    return true;
  }
  if (markReadMatch !== null) {
    const threadId = parseThreadId(markReadMatch[1]);
    await readJsonBody(request);
    await withRequestAbort(request, response, (signal) =>
      messageService.markRead(threadId, signal),
    );
    if (!response.destroyed) sendJson(response, 200, { threadId });
    return true;
  }
  if (replyMatch !== null) {
    const threadId = parseThreadId(replyMatch[1]);
    const body = objectValue(await readJsonBody(request));
    if (typeof body?.body !== "string") {
      sendJson(response, 400, { message: "The message reply is invalid." });
      return true;
    }
    await withRequestAbort(request, response, (signal) =>
      messageService.reply(threadId, body.body as string, signal),
    );
    if (!response.destroyed) sendJson(response, 200, { threadId });
    return true;
  }
  if (detailMatch !== null) {
    const threadId = parseThreadId(detailMatch[1]);
    const page = parsePage(url.searchParams.get("page"), "message thread");
    const result = await withRequestAbort(request, response, (signal) =>
      messageService.get(threadId, {
        page,
        force: url.searchParams.get("refresh") === "1",
        signal,
      }),
    );
    if (!response.destroyed) sendJson(response, 200, result);
    return true;
  }
  return false;
}

async function workspaceService<K extends keyof MarketplaceAccountServices>(
  context: ConfigurationRouteContext,
  facet: K,
): Promise<MarketplaceAccountServices[K] | undefined> {
  const runtime = context.marketplaces;
  const accounts = context.marketplaceAccounts ?? {};
  const requested = context.url.searchParams.get("connectionId");
  let connectionId: string;
  if (requested !== null) {
    try {
      connectionId = parseConnectionId(requested);
    } catch {
      sendJson(context.response, 400, {
        message: "The marketplace connection is invalid.",
        code: "INVALID_MARKETPLACE_CONNECTION",
      });
      return undefined;
    }
    const connection = runtime?.registry.get(connectionId);
    if (
      runtime === undefined
        ? accounts[connectionId]?.[facet] === undefined
        : connection === undefined
    ) {
      sendJson(context.response, 404, {
        message: "The marketplace connection is unknown or disabled.",
        code: "UNKNOWN_MARKETPLACE_CONNECTION",
      });
      return undefined;
    }
    if (connection !== undefined && connection.facets[facet] === undefined) {
      sendJson(context.response, 409, {
        message: "This workspace is unsupported by the selected connection.",
        code: "UNSUPPORTED_PROVIDER_CAPABILITY",
      });
      return undefined;
    }
  } else {
    const eligible =
      runtime === undefined
        ? Object.keys(accounts).filter(
            (candidate) => accounts[candidate]?.[facet] !== undefined,
          )
        : runtime.registry
            .list()
            .filter((candidate) => candidate.facets[facet] !== undefined)
            .map((candidate) => candidate.descriptor.connectionId);
    if (eligible.length !== 1) {
      sendJson(context.response, eligible.length === 0 ? 503 : 409, {
        message:
          eligible.length === 0
            ? "No enabled marketplace connection supplies this workspace."
            : "Select a marketplace connection for this workspace.",
        code:
          eligible.length === 0
            ? "NO_WORKSPACE_CONNECTIONS"
            : "AMBIGUOUS_WORKSPACE_CONNECTION",
      });
      return undefined;
    }
    const selected = eligible[0];
    if (selected === undefined) return undefined;
    connectionId = selected;
  }
  if (runtime !== undefined) {
    const health = await runtime.health.check(connectionId);
    if (health.state !== "connected" && health.state !== "degraded") {
      const authenticationRequired = health.state === "authentication-required";
      sendJson(context.response, authenticationRequired ? 401 : 503, {
        message: authenticationRequired
          ? "Marketplace authentication is required."
          : "The marketplace connection is unavailable.",
        code:
          health.issueCode ??
          (authenticationRequired
            ? "AUTHENTICATION_REQUIRED"
            : "MARKETPLACE_UNAVAILABLE"),
      });
      return undefined;
    }
  }
  const service = accounts[connectionId]?.[facet];
  if (service === undefined) {
    sendJson(context.response, 503, {
      message: "The selected marketplace workspace is unavailable.",
      code: "WORKSPACE_SERVICE_UNAVAILABLE",
    });
  }
  return service;
}

function parsePage(value: string | null, label: string): number {
  const page = value === null ? 1 : Number(value);
  if (!Number.isInteger(page) || page < 1 || page > 1_000_000) {
    throw new HttpRouteError(400, `The ${label} page is invalid.`);
  }
  return page;
}

function parseThreadId(value: string | undefined): number {
  const threadId = Number(value);
  if (!Number.isSafeInteger(threadId) || threadId < 1) {
    throw new HttpRouteError(400, "The message thread is invalid.");
  }
  return threadId;
}
