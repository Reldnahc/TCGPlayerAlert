import { randomUUID } from "node:crypto";
import { ApplicationError } from "./errors.js";
import type {
  LocalInventoryService,
  LocalInventoryState,
} from "./local-inventory.js";
import {
  projectLocalInventoryWorkspace,
  type MarketplaceInventoryObservation,
} from "./local-inventory-workspace.js";
import type { LocalInventoryItem } from "./local-inventory-contracts.js";
import type {
  InventoryListResult,
  MarketplaceInventoryService,
} from "./marketplaces/inventory.js";
import type { InventoryAdditionQueueStore } from "./inventory-additions.js";

export interface InventoryDelistPreview {
  readonly id: string;
  readonly localInventoryId: string;
  readonly displayName: string;
  readonly onHand: number;
  readonly listings: readonly { connectionLabel: string; quantity: number }[];
}
interface Dependencies {
  readonly local: LocalInventoryService;
  readonly inventory?: Pick<MarketplaceInventoryService, "listAll" | "update">;
  readonly queue?: InventoryAdditionQueueStore;
  readonly validateJobs?: (item: LocalInventoryItem) => Promise<void>;
}
interface StoredPreview {
  readonly preview: InventoryDelistPreview;
  readonly fingerprint: string;
  readonly expiresAt: number;
}
const previews = new WeakMap<
  LocalInventoryService,
  Map<string, StoredPreview>
>();
const fail = (message: string): never => {
  throw new ApplicationError("REVIEW_REQUIRED", message);
};

export async function previewInventoryDelisting(
  deps: Dependencies,
  localId: string,
): Promise<InventoryDelistPreview> {
  const state = await deps.local.snapshot();
  const item = state.items.find(
    (candidate) => candidate.localInventoryId === localId,
  );
  if (item === undefined) return fail("The local item no longer exists.");
  await deps.validateJobs?.(item);
  const listings = await readListings(deps, state.items, localId);
  const preview = {
    id: randomUUID(),
    localInventoryId: localId,
    displayName: item.displayName,
    onHand: item.onHand,
    listings: listings.map((listing) => ({
      connectionLabel: listing.descriptor.connectionLabel,
      quantity: listing.item.quantity,
    })),
  };
  const stored = previews.get(deps.local) ?? new Map<string, StoredPreview>();
  for (const [id, entry] of stored)
    if (entry.expiresAt <= Date.now()) stored.delete(id);
  if (stored.size >= 100) stored.clear();
  stored.set(preview.id, {
    preview,
    fingerprint: fingerprint(item, listings),
    expiresAt: Date.now() + 5 * 60_000,
  });
  previews.set(deps.local, stored);
  return preview;
}

export async function confirmInventoryDelisting(
  deps: Dependencies,
  localId: string,
  previewId: string,
): Promise<LocalInventoryItem> {
  const stored = previews.get(deps.local)?.get(previewId);
  previews.get(deps.local)?.delete(previewId);
  if (
    stored === undefined ||
    stored.expiresAt <= Date.now() ||
    stored.preview.localInventoryId !== localId
  )
    return fail(
      "This review expired or was already used. Review the card again.",
    );
  return deps.local.withReplenishmentState(async (state, save) => {
    const item = state.items.find(
      (candidate) => candidate.localInventoryId === localId,
    );
    if (item === undefined) return fail("The local item no longer exists.");
    await deps.validateJobs?.(item);
    const listings = await readListings(deps, state.items, localId);
    if (fingerprint(item, listings) !== stored.fingerprint)
      return fail(
        "Stock or listings changed after review. Review the card again.",
      );
    const execute = async () => {
      const paused: LocalInventoryState = {
        ...state,
        delistingAttempts: [
          ...(state.delistingAttempts ?? []).slice(-499),
          {
            id: previewId,
            localInventoryId: localId,
            status: "running",
            updatedAt: new Date().toISOString(),
          },
        ],
        replenishments: (state.replenishments ?? []).map((rule) =>
          rule.localInventoryId === localId
            ? {
                ...rule,
                enabled: false,
                tickets: [],
                status: "paused" as const,
                message: "Paused by explicit delisting and stock clearing.",
              }
            : rule,
        ),
      };
      await save(paused);
      try {
        for (const [index, listing] of listings.entries()) {
          const result = await deps.inventory?.update(
            listing.descriptor.connectionId,
            {
              inventoryKey: listing.item.inventoryKey,
              quantity: 0,
              idempotencyKey: `${previewId}/${String(index)}`,
            },
          );
          if (
            result?.outcome !== "applied" &&
            result?.outcome !== "already-applied"
          )
            return fail("The delisting result is uncertain.");
        }
        if ((await readListings(deps, state.items, localId)).length > 0)
          return fail("The marketplace still reports listed stock.");
      } catch {
        await save({
          ...paused,
          delistingAttempts:
            paused.delistingAttempts?.map((attempt) =>
              attempt.id === previewId
                ? {
                    ...attempt,
                    status: "review-required" as const,
                    updatedAt: new Date().toISOString(),
                  }
                : attempt,
            ) ?? [],
        });
        return fail(
          "Delisting was not fully verified. Some listings may have been removed. Local stock was kept; pending jobs were canceled and auto-relisting paused. Refresh and review before trying again.",
        );
      }
      const cleared = {
        ...item,
        onHand: 0,
        updatedAt: new Date().toISOString(),
      };
      await save({
        ...paused,
        delistingAttempts:
          paused.delistingAttempts?.map((attempt) =>
            attempt.id === previewId
              ? {
                  ...attempt,
                  status: "completed" as const,
                  updatedAt: new Date().toISOString(),
                }
              : attempt,
          ) ?? [],
        items: state.items.map((candidate) =>
          candidate.localInventoryId === localId ? cleared : candidate,
        ),
      });
      return cleared;
    };
    const skuIds = new Set(
      item.catalogIdentities
        .filter(
          (identity) =>
            identity.namespace === "tcgplayer.sku" &&
            identity.precision === "exact-variant",
        )
        .map((identity) => Number(identity.value)),
    );
    return deps.queue === undefined
      ? execute()
      : deps.queue.withCanceledSkuJobs(skuIds, execute);
  });
}

async function readListings(
  deps: Dependencies,
  items: readonly LocalInventoryItem[],
  id: string,
): Promise<readonly MarketplaceInventoryObservation[]> {
  const inventory: InventoryListResult | undefined =
    await deps.inventory?.listAll();
  if ((inventory?.issues.length ?? 0) > 0)
    return fail(
      "A marketplace could not be read. Restore its connection before delisting this card.",
    );
  const listings = projectLocalInventoryWorkspace(
    items,
    inventory,
    new Date().toISOString(),
  ).listings.filter(
    (listing) => listing.localInventoryId === id && listing.item.quantity > 0,
  );
  if (
    listings.some((listing) => listing.item.quantityMutation === "unavailable")
  )
    return fail(
      "A matched listing cannot be delisted through this app. Remove it on the marketplace first.",
    );
  return listings;
}

function fingerprint(
  item: LocalInventoryItem,
  listings: readonly MarketplaceInventoryObservation[],
): string {
  return JSON.stringify([
    item,
    listings.map((listing) => [
      listing.descriptor.connectionId,
      listing.item.inventoryKey,
      listing.item.quantity,
      listing.item.price,
    ]),
  ]);
}
