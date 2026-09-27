import type { LocalInventoryItem } from "../local-inventory-contracts.js";
import {
  LocalInventoryNotFoundError,
  type LocalInventoryAddition,
} from "../local-inventory.js";
import {
  previewInventoryDelisting,
  confirmInventoryDelisting,
} from "../local-inventory-delisting.js";
import {
  planLocalInventoryImport,
  projectLocalInventoryWorkspace,
} from "../local-inventory-workspace.js";
import { AggregateInventoryError } from "../marketplaces/inventory.js";
import type { InventoryListResult } from "../marketplaces/inventory.js";
import {
  MarketplaceValidationError,
  parseConnectionId,
} from "../marketplaces/identity.js";
import type {
  ConfigurationRouteContext,
  ConfigurationRouteHandler,
} from "./context.js";
import { objectValue, readJsonBody, sendJson } from "./http.js";

export const handleLocalInventoryRoute: ConfigurationRouteHandler = async (
  context,
) => {
  if (
    context.request.method === "GET" &&
    context.url.pathname === "/api/replenishment"
  ) {
    sendJson(
      context.response,
      200,
      context.replenishment === undefined
        ? { workerRunning: false, rules: [] }
        : await context.replenishment.snapshot(context.inventoryWorkerRunning),
    );
    return true;
  }
  const replenishMatch =
    context.request.method === "PUT"
      ? /^\/api\/replenishment\/([0-9a-f-]{36})$/iu.exec(context.url.pathname)
      : null;
  if (replenishMatch !== null) {
    if (context.replenishment === undefined) return unavailable(context);
    sendJson(context.response, 200, {
      ...(await context.replenishment.configure(
        replenishMatch[1] ?? "",
        await readJsonBody(context.request),
      )),
      workerRunning: context.inventoryWorkerRunning,
    });
    return true;
  }
  if (
    context.request.method === "GET" &&
    context.url.pathname === "/api/inventory"
  ) {
    return readInventoryWorkspace(context);
  }
  if (
    context.request.method === "GET" &&
    context.url.pathname === "/api/local-inventory/import-preview"
  ) {
    return previewMarketplaceImport(context);
  }
  if (
    context.request.method === "POST" &&
    context.url.pathname === "/api/local-inventory/publications/quote"
  ) {
    if (context.marketplacePublications === undefined)
      return unavailable(context);
    const quote = await context.marketplacePublications.quote(
      await readJsonBody(context.request),
    );
    sendJson(context.response, 200, { quote });
    return true;
  }
  if (
    context.request.method === "POST" &&
    context.url.pathname === "/api/local-inventory/publications/preview"
  ) {
    if (context.marketplacePublications === undefined)
      return unavailable(context);
    sendJson(context.response, 200, {
      preview: await context.marketplacePublications.preview(
        await readJsonBody(context.request),
      ),
    });
    return true;
  }
  const publicationMatch =
    context.request.method === "POST"
      ? /^\/api\/local-inventory\/publications\/previews\/([0-9a-f-]{36})\/publish$/iu.exec(
          context.url.pathname,
        )
      : null;
  if (publicationMatch !== null) {
    if (context.marketplacePublications === undefined)
      return unavailable(context);
    sendJson(context.response, 200, {
      job: await context.marketplacePublications.publish(
        publicationMatch[1] ?? "",
      ),
    });
    return true;
  }
  if (
    context.request.method === "POST" &&
    context.url.pathname === "/api/local-inventory/import"
  ) {
    return importMarketplaceInventory(context);
  }
  if (
    context.request.method === "POST" &&
    context.url.pathname === "/api/local-inventory/catalog-items"
  ) {
    return addCatalogItem(context);
  }
  const delistMatch =
    context.request.method === "POST"
      ? /^\/api\/local-inventory\/items\/([0-9a-f-]{36})\/(delist-preview|delist)$/iu.exec(
          context.url.pathname,
        )
      : null;
  if (delistMatch !== null) {
    if (context.localInventory === undefined) return unavailable(context);
    const deps = {
      local: context.localInventory,
      ...(!context.marketplaces?.registry
        .list()
        .some((connection) => connection.facets.inventoryReader !== undefined)
        ? {}
        : { inventory: context.marketplaces.inventory }),
      ...(context.inventoryQueue === undefined
        ? {}
        : { queue: context.inventoryQueue }),
      validateJobs: async (item: LocalInventoryItem) => {
        const skuIds = new Set(
          item.catalogIdentities
            .filter(
              (identity) =>
                identity.namespace === "tcgplayer.sku" &&
                identity.precision === "exact-variant",
            )
            .map((identity) => Number(identity.value)),
        );
        const jobs = await context.internalJobs?.snapshot();
        if (
          jobs?.schedules.some(
            (schedule) =>
              schedule.enabled &&
              schedule.payload.type === "list-inventory" &&
              schedule.payload.items.some((entry) =>
                skuIds.has(entry.productConditionId),
              ),
          ) ||
          jobs?.runs.some(
            (run) =>
              (run.status === "queued" || run.status === "running") &&
              run.payload.type === "list-inventory" &&
              run.payload.items.some((entry) =>
                skuIds.has(entry.productConditionId),
              ),
          )
        ) {
          throw new MarketplaceValidationError(
            "This card has an active listing schedule or run. Disable or cancel it in Jobs, then review again.",
          );
        }
      },
    };
    const localId = delistMatch[1] ?? "";
    if (delistMatch[2] === "delist-preview") {
      sendJson(
        context.response,
        200,
        await previewInventoryDelisting(deps, localId),
      );
    } else {
      const body = objectValue(await readJsonBody(context.request));
      if (
        body?.confirmation !== "DELIST_AND_EMPTY_ITEM" ||
        typeof body.previewId !== "string"
      ) {
        sendJson(context.response, 400, {
          message:
            "Review and confirm this card before delisting and emptying local stock.",
        });
        return true;
      }
      sendJson(context.response, 200, {
        item: await confirmInventoryDelisting(deps, localId, body.previewId),
      });
    }
    return true;
  }
  const quantityMatch =
    context.request.method === "PUT"
      ? /^\/api\/local-inventory\/items\/([0-9a-f-]{36})$/iu.exec(
          context.url.pathname,
        )
      : null;
  if (quantityMatch === null) return false;
  if (context.localInventory === undefined) return unavailable(context);
  const body = objectValue(await readJsonBody(context.request));
  const quantity = body?.onHand;
  if (!Number.isSafeInteger(quantity) || Number(quantity) < 0) {
    throw new MarketplaceValidationError(
      "A non-negative local on-hand quantity is required.",
    );
  }
  try {
    sendJson(context.response, 200, {
      item: await context.localInventory.setQuantity(
        quantityMatch[1] ?? "",
        Number(quantity),
      ),
    });
  } catch (error) {
    if (!(error instanceof LocalInventoryNotFoundError)) throw error;
    sendJson(context.response, 404, {
      message: error.message,
      code: "LOCAL_INVENTORY_NOT_FOUND",
    });
  }
  return true;
};

async function readInventoryWorkspace(
  context: ConfigurationRouteContext,
): Promise<true> {
  if (context.localInventory === undefined) return unavailable(context);
  const local = await context.localInventory.snapshot();
  const runtime = context.marketplaces;
  if (runtime === undefined) {
    sendJson(
      context.response,
      200,
      projectLocalInventoryWorkspace(local.items, undefined, local.completedAt),
    );
    return true;
  }
  const requested = context.url.searchParams.get("connectionId");
  const connectionId =
    requested === null ? undefined : parseConnectionId(requested);
  if (
    connectionId !== undefined &&
    runtime.registry.get(connectionId) === undefined
  ) {
    sendJson(context.response, 404, {
      message: "The marketplace connection is unknown or disabled.",
      code: "UNKNOWN_MARKETPLACE_CONNECTION",
    });
    return true;
  }
  const result = await readMarketplaceInventory(context);
  const marketplace =
    connectionId === undefined || result === undefined
      ? result
      : {
          ...result,
          connections: result.connections.filter(
            (connection) => connection.descriptor.connectionId === connectionId,
          ),
          issues: result.issues.filter(
            (issue) => issue.connectionId === connectionId,
          ),
        };
  sendJson(
    context.response,
    200,
    projectLocalInventoryWorkspace(
      local.items,
      marketplace,
      new Date().toISOString(),
    ),
  );
  return true;
}

async function previewMarketplaceImport(
  context: ConfigurationRouteContext,
): Promise<true> {
  if (context.localInventory === undefined) return unavailable(context);
  const [local, marketplace] = await Promise.all([
    context.localInventory.snapshot(),
    readMarketplaceInventory(context),
  ]);
  sendJson(
    context.response,
    200,
    planLocalInventoryImport(
      local.items,
      marketplace,
      new Date().toISOString(),
    ),
  );
  return true;
}

async function importMarketplaceInventory(
  context: ConfigurationRouteContext,
): Promise<true> {
  if (context.localInventory === undefined) return unavailable(context);
  const body = objectValue(await readJsonBody(context.request));
  if (body?.confirmation !== "IMPORT_MARKETPLACE_STOCK") {
    throw new MarketplaceValidationError(
      "Explicit marketplace stock import confirmation is required.",
    );
  }
  const [local, marketplace] = await Promise.all([
    context.localInventory.snapshot(),
    readMarketplaceInventory(context),
  ]);
  const preview = planLocalInventoryImport(
    local.items,
    marketplace,
    new Date().toISOString(),
  );
  const createdItems = await context.localInventory.initializeMissing(
    preview.candidates.map((candidate) => ({
      displayName: candidate.displayName,
      quantity: candidate.suggestedOnHand,
      catalogIdentities: candidate.catalogIdentities,
      attributes: candidate.attributes,
    })),
  );
  sendJson(context.response, 200, {
    createdCount: createdItems.length,
    createdItems,
    preview,
  });
  return true;
}

async function readMarketplaceInventory(
  context: ConfigurationRouteContext,
): Promise<InventoryListResult | undefined> {
  if (context.marketplaces === undefined) return undefined;
  try {
    return await context.marketplaces.inventory.listAll();
  } catch (error) {
    if (!(error instanceof AggregateInventoryError)) throw error;
    return {
      connections: [],
      issues: error.issues,
      completedAt: new Date().toISOString(),
    };
  }
}

async function addCatalogItem(
  context: ConfigurationRouteContext,
): Promise<true> {
  if (
    context.localInventory === undefined ||
    context.inventoryService === undefined ||
    context.marketplaces === undefined
  ) {
    return unavailable(context);
  }
  const sourceId = context.url.searchParams.get("connectionId");
  if (sourceId === null) {
    sendJson(context.response, 400, {
      message: "Choose a catalog source connection.",
      code: "CATALOG_SOURCE_REQUIRED",
    });
    return true;
  }
  const connectionId = parseConnectionId(sourceId);
  const connection = context.marketplaces.registry.get(connectionId);
  if (
    connection?.facets.catalogSearch === undefined ||
    context.catalogConnectionId !== connectionId
  ) {
    sendJson(context.response, 409, {
      message:
        "The selected connection does not support this local catalog workflow.",
      code: "UNSUPPORTED_CATALOG_SOURCE",
    });
    return true;
  }
  const body = objectValue(await readJsonBody(context.request));
  const productId = body?.productId;
  const productConditionId = body?.productConditionId;
  const quantity = body?.quantity;
  if (
    !Number.isSafeInteger(productId) ||
    Number(productId) < 1 ||
    !Number.isSafeInteger(productConditionId) ||
    Number(productConditionId) < 1 ||
    !Number.isSafeInteger(quantity) ||
    Number(quantity) < 1
  ) {
    throw new MarketplaceValidationError(
      "A valid catalog product, exact SKU, and positive quantity are required.",
    );
  }
  const product = await context.inventoryService.getProduct(Number(productId));
  const sku = product.skus.find(
    (candidate) => candidate.productConditionId === Number(productConditionId),
  );
  if (sku === undefined) {
    throw new MarketplaceValidationError(
      "The selected exact catalog SKU is unavailable.",
    );
  }
  const providerId = connection.descriptor.providerId;
  const addition: LocalInventoryAddition = {
    displayName: product.productName,
    quantity: Number(quantity),
    catalogIdentities: [
      {
        namespace: `${providerId}.sku`,
        value: String(sku.productConditionId),
        precision: "exact-variant",
      },
      {
        namespace: `${providerId}.product`,
        value: String(product.productId),
        precision: "product",
      },
    ],
    attributes: nonEmptyAttributes({
      productLine: product.productLineName,
      set: product.setName,
      rarity: product.rarityName,
      number: product.cardNumber,
      condition: sku.condition,
      printing: sku.printing,
      language: sku.language,
    }),
  };
  sendJson(context.response, 201, {
    item: await context.localInventory.add(addition),
  });
  return true;
}

function nonEmptyAttributes(
  values: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value.trim().length > 0),
  );
}

function unavailable(context: ConfigurationRouteContext): true {
  sendJson(context.response, 503, {
    message: "The local inventory service is unavailable.",
    code: "LOCAL_INVENTORY_UNAVAILABLE",
  });
  return true;
}
