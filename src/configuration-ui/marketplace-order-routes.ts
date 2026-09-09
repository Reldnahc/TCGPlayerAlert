import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  parseMoney,
  parseOrderDetail,
  type ConnectionHealthState,
} from "../marketplaces/contracts.js";
import {
  MarketplaceValidationError,
  parseConnectionId,
  parseRemoteId,
  type ProviderOrderRef,
} from "../marketplaces/identity.js";
import { AggregateOrderQueryError } from "../marketplaces/order-query.js";
import type { MarketplaceFacets } from "../marketplaces/registry.js";
import type {
  ConfigurationRouteContext,
  ConfigurationRouteHandler,
} from "./context.js";
import { AggregatePullListError } from "../fulfillment/pull-list.js";
import {
  objectValue,
  readJsonBody,
  safeText,
  sendBytes,
  sendJson,
  withRequestAbort,
} from "./http.js";

type QualifiedOrderAction =
  | "detail"
  | "tracking"
  | "mark-shipped"
  | "packing-slip"
  | "print"
  | "pirate-ship";

interface QualifiedOrderRoute {
  readonly ref: ProviderOrderRef;
  readonly action: QualifiedOrderAction;
}

export const handleMarketplaceOrderRoute: ConfigurationRouteHandler = async (
  context,
) => {
  const runtime = context.marketplaces;
  if (
    context.request.method === "GET" &&
    context.url.pathname === "/api/marketplace-connections"
  ) {
    if (runtime === undefined) return unavailable(context.response);
    const connections = await runtime.health.statuses({
      force: context.url.searchParams.get("refresh") === "1",
    });
    sendJson(context.response, 200, {
      connections,
      completedAt: new Date().toISOString(),
    });
    return true;
  }
  if (runtime === undefined) return false;

  const inventoryRoute = parseInventoryMutationRoute(context);
  if (inventoryRoute !== undefined) {
    const connection = runtime.registry.get(inventoryRoute.connectionId);
    if (connection === undefined) {
      sendJson(context.response, 404, {
        message: "The marketplace connection is unknown or disabled.",
        code: "UNKNOWN_MARKETPLACE_CONNECTION",
      });
      return true;
    }
    if (connection.facets.inventoryMutator === undefined) {
      sendJson(context.response, 409, {
        message: "Inventory mutation is unsupported by this connection.",
        code: "UNSUPPORTED_PROVIDER_CAPABILITY",
      });
      return true;
    }
    const health = await runtime.health.check(inventoryRoute.connectionId);
    if (health.state !== "connected" && health.state !== "degraded") {
      sendHealthFailure(context.response, health.state, health.issueCode);
      return true;
    }
    const body = objectValue(await readJsonBody(context.request));
    const quantity = body?.quantity;
    if (!Number.isSafeInteger(quantity) || Number(quantity) < 0) {
      throw new MarketplaceValidationError(
        "A non-negative inventory quantity is required.",
      );
    }
    const price = body?.price;
    const result = await withRequestAbort(
      context.request,
      context.response,
      (signal) =>
        runtime.inventory.update(
          inventoryRoute.connectionId,
          {
            inventoryKey: inventoryRoute.inventoryKey,
            quantity: Number(quantity),
            ...(price === undefined ? {} : { price: parseMoney(price) }),
            idempotencyKey: randomUUID(),
          },
          signal,
        ),
    );
    if (!context.response.destroyed) sendJson(context.response, 200, result);
    return true;
  }

  if (
    context.request.method === "POST" &&
    context.url.pathname === "/api/orders/sync"
  ) {
    const result = await withRequestAbort(
      context.request,
      context.response,
      async (signal) => {
        await runtime.workflow.run("manual", { signal });
        const snapshot = runtime.readyOrders.snapshot();
        if (snapshot === undefined) {
          throw new AggregateOrderQueryError(
            "ALL_ORDER_CONNECTIONS_FAILED",
            [],
          );
        }
        return {
          data: snapshot.orders,
          issues: snapshot.issues,
          completedAt: snapshot.fetchedAt,
        };
      },
    ).catch((error: unknown) => {
      if (!(error instanceof AggregateOrderQueryError)) throw error;
      if (!context.response.destroyed) {
        sendJson(context.response, 503, {
          message: error.message,
          code: error.code,
          issues: error.issues,
        });
      }
      return undefined;
    });
    if (result !== undefined && !context.response.destroyed) {
      sendJson(context.response, 200, result);
    }
    return true;
  }

  const aggregateScope = aggregateOrderScope(context);
  if (aggregateScope !== undefined) {
    const force =
      context.url.searchParams.get("refresh") === "1" ||
      context.request.method === "POST";
    const result = await withRequestAbort(
      context.request,
      context.response,
      (signal) => runtime.orders.listOrders(aggregateScope, { force, signal }),
    ).catch((error: unknown) => {
      if (!(error instanceof AggregateOrderQueryError)) throw error;
      if (!context.response.destroyed) {
        sendJson(context.response, 503, {
          message: error.message,
          code: error.code,
          issues: error.issues,
        });
      }
      return undefined;
    });
    if (result !== undefined && !context.response.destroyed) {
      sendJson(context.response, 200, result);
    }
    return true;
  }

  if (
    context.request.method === "GET" &&
    context.url.pathname === "/api/orders/pull-list"
  ) {
    const result = await withRequestAbort(
      context.request,
      context.response,
      (signal) =>
        runtime.pullList.getMasterPullList({
          force: context.url.searchParams.get("refresh") === "1",
          signal,
        }),
    ).catch((error: unknown) => {
      if (!(error instanceof AggregatePullListError)) throw error;
      if (!context.response.destroyed) {
        sendJson(context.response, 503, {
          message: error.message,
          code: error.code,
          issues: error.issues,
        });
      }
      return undefined;
    });
    if (result !== undefined && !context.response.destroyed) {
      sendJson(context.response, 200, result);
    }
    return true;
  }
  const pullListRowKey = parsePullListRowPath(
    context.request.method,
    context.url.pathname,
  );
  if (pullListRowKey !== undefined) {
    const pulled = objectValue(await readJsonBody(context.request))?.pulled;
    if (typeof pulled !== "boolean") {
      throw new MarketplaceValidationError("Pulled must be true or false.");
    }
    const result = await withRequestAbort(
      context.request,
      context.response,
      (signal) => runtime.pullList.setRowPulled(pullListRowKey, pulled, signal),
    );
    if (!context.response.destroyed) sendJson(context.response, 200, result);
    return true;
  }

  const route = parseQualifiedOrderRoute(context);
  if (route === undefined) return false;
  const connection = runtime.registry.get(route.ref.connectionId);
  if (connection === undefined) {
    sendJson(context.response, 404, {
      message: "The marketplace connection is unknown or disabled.",
      code: "UNKNOWN_MARKETPLACE_CONNECTION",
    });
    return true;
  }
  const facet = requiredFacet(route.action);
  if (connection.facets[facet] === undefined) {
    sendJson(context.response, 409, {
      message: "The marketplace action is unsupported by this connection.",
      code: "UNSUPPORTED_PROVIDER_CAPABILITY",
    });
    return true;
  }
  const health = await runtime.health.check(route.ref.connectionId);
  if (health.state !== "connected" && health.state !== "degraded") {
    sendHealthFailure(context.response, health.state, health.issueCode);
    return true;
  }

  if (route.action === "detail") {
    const result = await withRequestAbort(
      context.request,
      context.response,
      async (signal) => {
        const detail = parseOrderDetail(
          await runtime.registry
            .facet(route.ref.connectionId, "orderDetails")
            .getOrder(route.ref, signal),
        );
        assertExactRef(detail.ref, route.ref);
        return {
          ...detail,
          actions: runtime.orders.presentOrder(detail).actions,
        };
      },
    );
    if (!context.response.destroyed) sendJson(context.response, 200, result);
    return true;
  }

  if (route.action === "tracking") {
    const trackingNumber = objectValue(
      await readJsonBody(context.request),
    )?.trackingNumber;
    if (!safeText(trackingNumber) || Array.from(trackingNumber).length > 256) {
      throw new MarketplaceValidationError(
        "A valid tracking number is required.",
      );
    }
    const result = await withRequestAbort(
      context.request,
      context.response,
      (signal) =>
        runtime.actions.addTracking({ ref: route.ref, trackingNumber }, signal),
    );
    if (!context.response.destroyed) sendJson(context.response, 200, result);
    return true;
  }

  if (route.action === "mark-shipped") {
    await readJsonBody(context.request);
    const result = await withRequestAbort(
      context.request,
      context.response,
      (signal) => runtime.actions.markShipped({ ref: route.ref }, signal),
    );
    if (!context.response.destroyed) sendJson(context.response, 200, result);
    return true;
  }

  if (route.action === "packing-slip") {
    const result = await withRequestAbort(
      context.request,
      context.response,
      (signal) => runtime.documents.getPackingSlip(route.ref, signal),
    );
    if (!context.response.destroyed) {
      context.response.setHeader(
        "Content-Disposition",
        `attachment; filename="${result.fileName}"`,
      );
      sendBytes(context.response, 200, result.mediaType, result.bytes);
    }
    return true;
  }

  if (route.action === "print") {
    const actionType = parseManualPrintAction(
      await readJsonBody(context.request),
    );
    await withRequestAbort(context.request, context.response, (signal) =>
      runtime.printing.print(route.ref, actionType, signal),
    );
    if (!context.response.destroyed) {
      sendJson(context.response, 200, {
        printed: true,
        ref: route.ref,
        actionType,
      });
    }
    return true;
  }

  const detail = await withRequestAbort(
    context.request,
    context.response,
    (signal) =>
      runtime.registry
        .facet(route.ref.connectionId, "orderDetails")
        .getOrder(route.ref, signal),
  );
  const address = detail.shippingAddress;
  if (!context.response.destroyed) {
    sendJson(context.response, 200, {
      url: "https://ship.pirateship.com/ship/single",
      pasteAddress: [
        address.recipientName,
        address.company,
        address.addressOne,
        address.addressTwo,
        `${address.city}, ${address.territory} ${address.postalCode}`,
        address.country,
      ]
        .filter((line): line is string => line !== undefined && line !== "")
        .join("\n"),
    });
  }
  return true;
};

function parseInventoryMutationRoute(
  context: ConfigurationRouteContext,
):
  { readonly connectionId: string; readonly inventoryKey: string } | undefined {
  if (context.request.method !== "POST") return undefined;
  const match =
    /^\/api\/connections\/([^/]{1,192})\/inventory\/([^/]{1,768})$/u.exec(
      context.url.pathname,
    );
  const connection = match?.[1];
  const inventory = match?.[2];
  if (connection === undefined || inventory === undefined) return undefined;
  const inventoryKey = decodeSegment(inventory);
  if (
    inventoryKey.trim() === "" ||
    Array.from(inventoryKey).length > 256 ||
    /\p{Cc}/u.test(inventoryKey)
  ) {
    throw new MarketplaceValidationError("The inventory key is invalid.");
  }
  return {
    connectionId: parseConnectionId(decodeSegment(connection)),
    inventoryKey,
  };
}

function aggregateOrderScope(
  context: ConfigurationRouteContext,
): "all" | "ready-to-ship" | undefined {
  const { method } = context.request;
  const { pathname, searchParams } = context.url;
  if (method === "GET" && pathname === "/api/orders") {
    const status = searchParams.get("status");
    if (status === null) return "all";
    if (status === "ready-to-ship") return "ready-to-ship";
    throw new MarketplaceValidationError("The order status filter is invalid.");
  }
  if (method === "GET" && pathname === "/api/orders/ready") {
    return "ready-to-ship";
  }
  if (method === "POST" && pathname === "/api/orders/sync") {
    return "ready-to-ship";
  }
  return undefined;
}

function parseQualifiedOrderRoute(
  context: ConfigurationRouteContext,
): QualifiedOrderRoute | undefined {
  const { pathname } = context.url;
  const qualified =
    /^\/api\/connections\/([^/]{1,192})\/orders\/([^/]{1,768})(?:\/(tracking|mark-shipped|packing-slip|print|pirate-ship))?$/u.exec(
      pathname,
    );
  if (qualified !== null) {
    const connection = qualified[1];
    const remote = qualified[2];
    if (connection === undefined || remote === undefined) return undefined;
    return {
      ref: {
        connectionId: parseConnectionId(decodeSegment(connection)),
        remoteId: parseRemoteId(decodeSegment(remote)),
      },
      action: parseAction(context.request.method, qualified[3]),
    };
  }
  return undefined;
}

function parseAction(
  method: string | undefined,
  suffix: string | undefined,
): QualifiedOrderAction {
  if (suffix === undefined && method === "GET") return "detail";
  if (suffix === "tracking" && method === "POST") return "tracking";
  if (suffix === "mark-shipped" && method === "POST") return "mark-shipped";
  if (suffix === "packing-slip" && method === "GET") return "packing-slip";
  if (suffix === "print" && method === "POST") return "print";
  if (suffix === "pirate-ship" && method === "GET") return "pirate-ship";
  throw new MarketplaceValidationError(
    "The marketplace order route is invalid.",
  );
}

function requiredFacet(action: QualifiedOrderAction): keyof MarketplaceFacets {
  if (
    action === "detail" ||
    action === "packing-slip" ||
    action === "print" ||
    action === "pirate-ship"
  )
    return "orderDetails";
  return "fulfillment";
}

function parseManualPrintAction(
  value: unknown,
): "print-address-label" | "print-packing-slip" {
  const actionType = objectValue(value)?.actionType;
  if (
    actionType !== "print-address-label" &&
    actionType !== "print-packing-slip"
  ) {
    throw new MarketplaceValidationError(
      "The manual print action type is invalid.",
    );
  }
  return actionType;
}

function parsePullListRowPath(
  method: string | undefined,
  pathname: string,
): string | undefined {
  if (
    method !== "POST" ||
    !/^\/api\/orders\/pull-list\/items\/[^/]{1,3072}$/u.test(pathname)
  ) {
    return undefined;
  }
  return decodeSegment(pathname.slice("/api/orders/pull-list/items/".length));
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new MarketplaceValidationError(
      "The marketplace route identity is invalid.",
    );
  }
}

function assertExactRef(
  actual: ProviderOrderRef,
  expected: ProviderOrderRef,
): void {
  if (
    actual.connectionId !== expected.connectionId ||
    actual.remoteId !== expected.remoteId
  ) {
    throw new MarketplaceValidationError(
      "The provider returned detail for the wrong order.",
    );
  }
}

function unavailable(response: ServerResponse): true {
  sendJson(response, 503, {
    message: "Marketplace order management is unavailable.",
    code: "NO_ORDER_CONNECTIONS",
  });
  return true;
}

function sendHealthFailure(
  response: ServerResponse,
  state: ConnectionHealthState,
  issueCode: string | undefined,
): void {
  const status = state === "authentication-required" ? 401 : 503;
  sendJson(response, status, {
    message:
      status === 401
        ? "Marketplace authentication is required."
        : "The marketplace connection is unavailable.",
    code: issueCode ?? `HEALTH_${state.toUpperCase().replaceAll("-", "_")}`,
  });
}
