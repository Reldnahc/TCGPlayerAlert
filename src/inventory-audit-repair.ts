import { randomUUID } from "node:crypto";
import { ApplicationError } from "./errors.js";
import type {
  LocalInventoryService,
  LocalInventoryState,
} from "./local-inventory.js";
import type {
  InventoryAdditionService,
  InventoryAdditionQueueStore,
} from "./inventory-additions.js";
import type { MarketplaceInventoryService } from "./marketplaces/inventory.js";
import { projectLocalInventoryWorkspace } from "./local-inventory-workspace.js";

export interface InventoryAuditRepairPreview {
  readonly id: string;
  readonly localInventoryId: string;
  readonly connectionId: string;
  readonly displayName: string;
  readonly onHand: number;
  readonly listed: number;
  readonly target: number;
  readonly addQuantity: number;
  readonly price?: number;
  readonly fixedPrice: boolean;
  readonly reservedElsewhere: number;
  readonly limited: boolean;
}
interface Dependencies {
  readonly local: LocalInventoryService;
  readonly inventory: Pick<MarketplaceInventoryService, "listAll">;
  readonly additions: Pick<InventoryAdditionService, "prepareStockRepair">;
  readonly queue: InventoryAdditionQueueStore;
  readonly fixedPrices: () => Promise<Readonly<Record<string, number>>>;
}
interface Request {
  readonly localId: string;
  readonly connectionId: string;
  readonly price?: number;
}
type Prepared = Awaited<ReturnType<typeof prepare>>;
const previews = new WeakMap<
  LocalInventoryService,
  Map<string, { request: Request; prepared: Prepared; expires: number }>
>();
function fail(message: string): never {
  throw new ApplicationError("REVIEW_REQUIRED", message);
}

export function previewAuditRepair(
  deps: Dependencies,
  request: Request,
): Promise<InventoryAuditRepairPreview> {
  return deps.local.withReplenishmentState(async (state) => {
    const prepared = await prepare(deps, request, state);
    const stored =
      previews.get(deps.local) ??
      new Map<
        string,
        { request: Request; prepared: Prepared; expires: number }
      >();
    for (const [id, value] of stored)
      if (value.expires <= Date.now()) stored.delete(id);
    if (stored.size >= 100) stored.clear();
    stored.set(prepared.preview.id, {
      request,
      prepared,
      expires: Date.now() + 5 * 60_000,
    });
    previews.set(deps.local, stored);
    return prepared.preview;
  });
}

export async function queueAuditRepair(
  deps: Dependencies,
  localId: string,
  connectionId: string,
  previewId: string,
) {
  const stored = previews.get(deps.local)?.get(previewId);
  previews.get(deps.local)?.delete(previewId);
  if (
    stored === undefined ||
    stored.expires <= Date.now() ||
    stored.request.localId !== localId ||
    stored.request.connectionId !== connectionId
  )
    return fail(
      "This repair review expired or was already used. Review the missing quantity again.",
    );
  return await deps.local.withReplenishmentState(async (state) => {
    const current = await prepare(deps, stored.request, state);
    if (current.fingerprint !== stored.prepared.fingerprint)
      return fail(
        "Stock, listing price, or public limits changed. Review the correction again.",
      );
    if (current.addition === undefined)
      return fail("Enter and review a price before listing this card.");
    return deps.queue.enqueueStockRepair(current.addition);
  });
}

async function prepare(
  deps: Dependencies,
  request: Request,
  state: LocalInventoryState,
) {
  const item = state.items.find(
    (candidate) => candidate.localInventoryId === request.localId,
  );
  if (item === undefined)
    return fail("The local inventory item is unavailable.");
  const inventory = await deps.inventory.listAll();
  if (inventory.issues.length > 0)
    return fail(
      "A marketplace could not be read. Refresh its connection before repairing quantities.",
    );
  const listings = projectLocalInventoryWorkspace(
    state.items,
    inventory,
    inventory.completedAt,
  ).listings.filter(
    (listing) => listing.localInventoryId === item.localInventoryId,
  );
  const identities = [
    ...item.catalogIdentities,
    ...listings.flatMap((listing) => listing.item.catalogIdentities),
  ];
  const uniqueIdentity = (namespace: string) => {
    const values = new Set(
      identities
        .filter((identity) => identity.namespace === namespace)
        .map((identity) => identity.value),
    );
    if (values.size !== 1)
      return fail(
        "A unique exact TCGplayer catalog identity is required. Use Add Cards to resolve this variant first.",
      );
    const id = Number([...values][0]);
    if (!Number.isSafeInteger(id) || id < 1)
      return fail("The catalog identity is invalid.");
    return id;
  };
  const skuId = uniqueIdentity("tcgplayer.sku");
  const productId = uniqueIdentity("tcgplayer.product");
  const jobs = await deps.queue.snapshot();
  if (
    jobs.jobs.some(
      (job) =>
        (job.operation === "add"
          ? job.addition.productConditionId
          : job.removal.productConditionId) === skuId &&
        (job.status === "pending" || job.status === "applying"),
    )
  )
    return fail(
      "This card already has a pending or running inventory job. Let it finish or cancel it in Jobs, then refresh the audit.",
    );
  const reservedElsewhere = listings
    .filter(
      (listing) => listing.descriptor.connectionId !== request.connectionId,
    )
    .reduce((sum, listing) => sum + listing.item.quantity, 0);
  const rule = state.replenishments?.find(
    (candidate) =>
      candidate.localInventoryId === item.localInventoryId &&
      candidate.connectionId === request.connectionId &&
      candidate.enabled,
  );
  const target = Math.min(
    Math.max(0, item.onHand - reservedElsewhere),
    rule?.targetQuantity ?? item.onHand,
  );
  const fixed = (await deps.fixedPrices())[`${String(skuId)}:0`];
  const prepared = await deps.additions.prepareStockRepair(
    productId,
    skuId,
    target,
    fixed ?? request.price,
  );
  const observed = listings
    .filter(
      (listing) => listing.descriptor.connectionId === request.connectionId,
    )
    .reduce((sum, listing) => sum + listing.item.quantity, 0);
  if (observed !== prepared.currentQuantity)
    return fail(
      "The marketplace quantity changed or the listing match is incomplete. Refresh and review again.",
    );
  const preview: InventoryAuditRepairPreview = {
    id: randomUUID(),
    localInventoryId: item.localInventoryId,
    connectionId: request.connectionId,
    displayName: item.displayName,
    onHand: item.onHand,
    listed: prepared.currentQuantity,
    target,
    addQuantity: target - prepared.currentQuantity,
    ...(prepared.price === undefined ? {} : { price: prepared.price }),
    fixedPrice: fixed !== undefined,
    reservedElsewhere,
    limited: rule !== undefined,
  };
  return {
    preview,
    addition: prepared.addition,
    fingerprint: JSON.stringify([
      item,
      target,
      prepared.currentQuantity,
      prepared.price,
      reservedElsewhere,
      rule,
      fixed,
    ]),
  };
}
