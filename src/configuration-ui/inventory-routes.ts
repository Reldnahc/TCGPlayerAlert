import { ConfigurationError } from "../errors.js";
import type { RepricingProgress, RepricingService } from "../repricing.js";
import type {
  ConfigurationRouteContext,
  ConfigurationRouteHandler,
} from "./context.js";
import {
  objectValue,
  readJsonBody,
  sendJson,
  withRequestAbort,
} from "./http.js";

export const handleInventoryRoute: ConfigurationRouteHandler = async (
  context,
) => {
  if (await handleRepricingRoute(context)) return true;
  if (await handleCatalogRoute(context)) return true;
  if (await handleInventoryQueueRoute(context)) return true;
  return handlePriceQueueRoute(context);
};

async function handleRepricingRoute(
  context: ConfigurationRouteContext,
): Promise<boolean> {
  const {
    request,
    response,
    url,
    repricingService,
    priceQueue,
    inventoryQueue,
  } = context;
  if (request.method === "POST" && url.pathname === "/api/repricing/preview") {
    if (repricingService === undefined) {
      sendJson(response, 503, {
        message: "The repricing service is unavailable.",
      });
      return true;
    }
    const rules = await readJsonBody(request);
    const forceRefresh = url.searchParams.get("forceRefresh") === "true";
    if (
      request.headers.accept?.toLowerCase().includes("application/x-ndjson") ===
      true
    ) {
      await streamRepricingPreview(
        request,
        response,
        repricingService,
        rules,
        forceRefresh,
      );
    } else {
      const result = await withRequestAbort(request, response, (signal) =>
        repricingService.preview(rules, { forceRefresh, signal }),
      );
      if (!response.destroyed) sendJson(response, 200, result);
    }
    return true;
  }
  const queueMatch =
    request.method === "POST"
      ? /^\/api\/repricing\/previews\/([0-9a-f-]{36})\/queue$/iu.exec(
          url.pathname,
        )
      : null;
  if (queueMatch !== null) {
    if (repricingService === undefined || priceQueue === undefined) {
      sendJson(response, 503, {
        message: "Repricing or the price-update queue is unavailable.",
      });
      return true;
    }
    const previewId = queueMatch[1] ?? "";
    const updates = repricingService.takeUpdates(
      previewId,
      await readJsonBody(request),
    );
    sendJson(response, 202, {
      jobs: await priceQueue.enqueue({ updates }),
    });
    return true;
  }
  const removeMatch =
    request.method === "POST"
      ? /^\/api\/repricing\/previews\/([0-9a-f-]{36})\/remove$/iu.exec(
          url.pathname,
        )
      : null;
  if (removeMatch === null) return false;
  if (repricingService === undefined || inventoryQueue === undefined) {
    sendJson(response, 503, {
      message: "The inventory-removal queue is unavailable.",
    });
    return true;
  }
  const body = objectValue(await readJsonBody(request));
  const removal = repricingService.takeRemoval(
    removeMatch[1] ?? "",
    body?.rowId,
  );
  sendJson(response, 202, {
    job: await inventoryQueue.enqueueRemoval(removal),
  });
  return true;
}

async function handleCatalogRoute(
  context: ConfigurationRouteContext,
): Promise<boolean> {
  const { request, response, url, inventoryService } = context;
  if (request.method === "GET" && url.pathname === "/api/catalog/search") {
    if (inventoryService === undefined) {
      sendJson(response, 503, {
        message: "The inventory catalog service is unavailable.",
      });
      return true;
    }
    const query = url.searchParams.get("q")?.trim() ?? "";
    const isProductNumber = /^\d+$/u.test(query);
    if ((!isProductNumber && query.length < 2) || query.length > 200) {
      sendJson(response, 400, {
        message:
          "Enter a TCGplayer product number or 2-200 characters of a card name.",
      });
      return true;
    }
    const productLine = url.searchParams.get("productLine")?.trim();
    const setName = url.searchParams.get("setName")?.trim();
    if (setName !== undefined && setName.length > 256) {
      sendJson(response, 400, { message: "Set name is too long." });
      return true;
    }
    const offsetText = url.searchParams.get("offset") ?? "0";
    if (!/^\d{1,7}$/u.test(offsetText) || Number(offsetText) > 1_000_000) {
      sendJson(response, 400, {
        message: "Catalog offset must be between 0 and 1000000.",
      });
      return true;
    }
    const result = await withRequestAbort(request, response, (signal) =>
      inventoryService.search(
        query,
        productLine === "" ? undefined : productLine,
        Number(offsetText),
        signal,
        setName === "" ? undefined : setName,
      ),
    );
    if (!response.destroyed) sendJson(response, 200, result);
    return true;
  }
  const productMatch =
    request.method === "GET"
      ? /^\/api\/catalog\/products\/(\d+)$/u.exec(url.pathname)
      : null;
  if (productMatch === null) return false;
  if (inventoryService === undefined) {
    sendJson(response, 503, {
      message: "The inventory catalog service is unavailable.",
    });
    return true;
  }
  sendJson(
    response,
    200,
    await inventoryService.getProduct(Number(productMatch[1])),
  );
  return true;
}

async function handleInventoryQueueRoute(
  context: ConfigurationRouteContext,
): Promise<boolean> {
  const {
    request,
    response,
    url,
    inventoryService,
    inventoryQueue,
    inventoryWorkerRunning,
  } = context;
  if (
    request.method === "POST" &&
    url.pathname === "/api/inventory-additions/preview"
  ) {
    if (inventoryService === undefined) {
      sendJson(response, 503, {
        message: "The inventory-addition service is unavailable.",
      });
      return true;
    }
    sendJson(
      response,
      200,
      await inventoryService.preview(await readJsonBody(request)),
    );
    return true;
  }
  const queueMatch =
    request.method === "POST"
      ? /^\/api\/inventory-additions\/previews\/([0-9a-f-]{36})\/queue$/iu.exec(
          url.pathname,
        )
      : null;
  if (queueMatch !== null) {
    if (inventoryService === undefined || inventoryQueue === undefined) {
      sendJson(response, 503, {
        message: "The inventory-change queue is unavailable.",
      });
      return true;
    }
    sendJson(response, 202, {
      jobs: await inventoryQueue.enqueue(
        inventoryService.takeAddition(queueMatch[1] ?? ""),
      ),
    });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/inventory-additions") {
    if (inventoryQueue === undefined) {
      sendJson(response, 503, {
        message: "The inventory-change queue is unavailable.",
      });
      return true;
    }
    sendJson(response, 200, {
      ...(await inventoryQueue.snapshot()),
      workerRunning: inventoryWorkerRunning,
    });
    return true;
  }
  const resubmitMatch =
    request.method === "POST"
      ? /^\/api\/inventory-additions\/([0-9a-f-]{36})\/resubmit$/iu.exec(
          url.pathname,
        )
      : null;
  if (resubmitMatch !== null) {
    if (inventoryQueue === undefined) {
      sendJson(response, 503, {
        message: "The inventory-change queue is unavailable.",
      });
      return true;
    }
    sendJson(response, 202, {
      job: await inventoryQueue.resubmit(resubmitMatch[1] ?? ""),
    });
    return true;
  }
  const cancelMatch =
    request.method === "DELETE"
      ? /^\/api\/inventory-additions\/([0-9a-f-]{36})$/iu.exec(url.pathname)
      : null;
  if (cancelMatch === null) return false;
  if (inventoryQueue === undefined) {
    sendJson(response, 503, {
      message: "The inventory-change queue is unavailable.",
    });
    return true;
  }
  sendJson(response, 200, {
    job: await inventoryQueue.cancel(cancelMatch[1] ?? ""),
  });
  return true;
}

async function handlePriceQueueRoute(
  context: ConfigurationRouteContext,
): Promise<boolean> {
  const { request, response, url, priceQueue, priceWorkerRunning } = context;
  if (
    (request.method === "GET" || request.method === "POST") &&
    url.pathname === "/api/price-updates"
  ) {
    if (priceQueue === undefined) {
      sendJson(response, 503, {
        message: "The price-update queue is unavailable.",
      });
      return true;
    }
    if (request.method === "GET") {
      sendJson(response, 200, {
        ...(await priceQueue.snapshot()),
        workerRunning: priceWorkerRunning,
      });
    } else {
      sendJson(response, 202, {
        jobs: await priceQueue.enqueue(await readJsonBody(request)),
      });
    }
    return true;
  }
  const resubmitMatch =
    request.method === "POST"
      ? /^\/api\/price-updates\/([0-9a-f-]{36})\/resubmit$/iu.exec(url.pathname)
      : null;
  if (resubmitMatch !== null) {
    if (priceQueue === undefined) {
      sendJson(response, 503, {
        message: "The price-update queue is unavailable.",
      });
      return true;
    }
    sendJson(response, 202, {
      job: await priceQueue.resubmit(resubmitMatch[1] ?? ""),
    });
    return true;
  }
  const cancelMatch =
    request.method === "DELETE"
      ? /^\/api\/price-updates\/([0-9a-f-]{36})$/iu.exec(url.pathname)
      : null;
  if (cancelMatch === null) return false;
  if (priceQueue === undefined) {
    sendJson(response, 503, {
      message: "The price-update queue is unavailable.",
    });
    return true;
  }
  sendJson(response, 200, {
    job: await priceQueue.cancel(cancelMatch[1] ?? ""),
  });
  return true;
}

async function streamRepricingPreview(
  request: ConfigurationRouteContext["request"],
  response: ConfigurationRouteContext["response"],
  repricingService: RepricingService,
  rules: unknown,
  forceRefresh: boolean,
): Promise<void> {
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.flushHeaders();
  const write = (value: unknown) => {
    if (!response.destroyed) response.write(`${JSON.stringify(value)}\n`);
  };
  try {
    const preview = await withRequestAbort(request, response, (signal) =>
      repricingService.preview(rules, {
        forceRefresh,
        signal,
        onProgress: (progress: RepricingProgress) =>
          write({ type: "progress", progress }),
      }),
    );
    write({ type: "complete", preview });
  } catch (error) {
    if ((request.destroyed && !request.complete) || response.destroyed) return;
    write({ type: "error", ...streamError(error) });
  } finally {
    if (!response.destroyed) response.end();
  }
}

function streamError(error: unknown): {
  readonly message: string;
  readonly issues?: readonly string[];
  readonly code?: string;
} {
  if (error instanceof ConfigurationError) {
    return { message: "Settings are invalid.", issues: error.issues };
  }
  if (error instanceof Error && "code" in error) {
    return { message: error.message, code: String(error.code) };
  }
  return { message: "The inventory preview could not be created." };
}
