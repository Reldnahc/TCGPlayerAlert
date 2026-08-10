import {
  SellerPayoutStatus,
  type SellerPayoutStatus as SellerPayoutStatusCode,
} from "tcgplayer-private-api";
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

const SELLER_PAYOUT_STATUSES = new Set<SellerPayoutStatusCode>(
  Object.values(SellerPayoutStatus),
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
  const { request, response, url, paymentService } = context;
  if (request.method === "GET" && url.pathname === "/api/payments") {
    if (paymentService === undefined) {
      sendJson(response, 503, { message: "Payment history is unavailable." });
      return true;
    }
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
  if (paymentService === undefined) {
    sendJson(response, 503, { message: "Payment history is unavailable." });
    return true;
  }
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
  const { request, response, url, feedbackService } = context;
  if (request.method !== "GET" || url.pathname !== "/api/feedback") {
    return false;
  }
  if (feedbackService === undefined) {
    sendJson(response, 503, { message: "Seller feedback is unavailable." });
    return true;
  }
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
  const { request, response, url, messageService } = context;
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
  if (messageService === undefined) {
    sendJson(response, 503, { message: "Seller messages are unavailable." });
    return true;
  }
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
