import { randomUUID } from "node:crypto";
import type {
  SellerInventoryRemoval,
  SellerPriceUpdate,
} from "tcgplayer-private-api";
import { ConfigurationError } from "../errors.js";
import {
  resolveSellerKey,
  type SellerKeySource,
} from "../seller-credentials.js";
import type { RepricingPreview, RepricingProgress } from "./contracts.js";
import {
  comparisonEvidence,
  comparisonRecoveryKey,
  emptyComparisonSample,
  RepricingMarketplace,
  requiresExactShippingVerification,
  sellerConditionKey,
  type RepricingMarketplaceClient,
} from "./marketplace.js";
import {
  allowedConditions,
  calculateRepricingRow,
  roundCurrency,
  skippedRow,
  type SellerListingContext,
} from "./pricing.js";
import { objectValue, parseRepricingRules } from "./rules.js";

interface StoredPreview {
  readonly expiresAt: number;
  readonly updates: ReadonlyMap<string, SellerPriceUpdate>;
  readonly removals: ReadonlyMap<string, SellerInventoryRemoval>;
}

export interface RepricingServiceOptions {
  readonly client: RepricingMarketplaceClient;
  readonly sellerKey: SellerKeySource;
  readonly now?: () => Date;
  readonly id?: () => string;
  readonly previewLifetimeMs?: number;
  readonly marketplaceCacheLifetimeMs?: number;
}

export interface RepricingPreviewOptions {
  readonly forceRefresh?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: RepricingProgress) => void;
}

export class RepricingService {
  private readonly sellerKey: SellerKeySource;
  private activeSellerKey: string | undefined;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly previewLifetimeMs: number;
  private readonly previews = new Map<string, StoredPreview>();
  private readonly marketplace: RepricingMarketplace;

  constructor(options: RepricingServiceOptions) {
    this.sellerKey = options.sellerKey;
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.previewLifetimeMs = options.previewLifetimeMs ?? 15 * 60_000;
    this.marketplace = new RepricingMarketplace({
      client: options.client,
      sellerKey: () => this.currentSellerKey(),
      now: this.now,
      cacheLifetimeMs: options.marketplaceCacheLifetimeMs ?? 10 * 60_000,
    });
  }

  async preview(
    value: unknown,
    options: RepricingPreviewOptions = {},
  ): Promise<RepricingPreview> {
    const sellerKey = this.currentSellerKey();
    const rules = parseRepricingRules(value);
    this.removeExpiredPreviews();
    const { snapshot, source } = await this.marketplace.snapshot(
      options.forceRefresh === true,
      options.onProgress,
      options.signal,
    );
    const { inventory, secondaryInventory } = snapshot;
    const sellerListings: SellerListingContext[] = inventory.flatMap(
      (product) =>
        product.listings
          .filter((listing) => listing.sellerKey === sellerKey)
          .map((listing) => ({ product, listing })),
    );
    const secondarySkus = new Set(
      secondaryInventory.flatMap((product) =>
        product.listings.map((listing) => listing.productConditionId),
      ),
    );
    const sellerConditionCounts = new Map<string, number>();
    for (const context of sellerListings) {
      const key = sellerConditionKey(context);
      sellerConditionCounts.set(key, (sellerConditionCounts.get(key) ?? 0) + 1);
    }

    const comparableSellerListings = sellerListings.filter(
      (context) => !secondarySkus.has(context.listing.productConditionId),
    );
    await this.marketplace.prepareComparisons(
      snapshot,
      comparableSellerListings,
      rules,
      sellerConditionCounts,
      options.onProgress,
      options.signal,
    );
    options.onProgress?.({
      phase: "finalizing",
      completed: 0,
      total: sellerListings.length,
      unit: "listings",
      detail: "Calculating proposed changes",
    });

    const updates = new Map<string, SellerPriceUpdate>();
    const removals = new Map<string, SellerInventoryRemoval>();
    const rows = sellerListings.map((context) => {
      const hasSecondaryInventory = secondarySkus.has(
        context.listing.productConditionId,
      );
      const row = hasSecondaryInventory
        ? skippedRow(
            {
              id: this.id(),
              productId: context.product.productId,
              productConditionId: context.listing.productConditionId,
              productName: context.product.productName,
              productLineName: context.product.productLineName,
              setName: context.product.setName,
              condition: context.listing.condition,
              printing: context.listing.printing,
              language: context.listing.language,
              quantity: context.listing.quantity,
              currentPrice: context.listing.price,
              currentShipping: context.listing.shippingPrice,
            },
            "This SKU also has secondary-channel inventory, so reserve quantity cannot be changed safely.",
          )
        : (() => {
            const conditions = allowedConditions(
              context.listing.condition,
              rules.conditionPolicy,
            );
            const recoveredSample =
              conditions === undefined
                ? undefined
                : snapshot.comparisonRecoveries.get(
                    comparisonRecoveryKey(context, conditions),
                  );
            const sample = recoveredSample ?? emptyComparisonSample();
            const calculated = calculateRepricingRow(
              context,
              sample.listings,
              sellerKey,
              rules,
              this.id(),
              recoveredSample === undefined
                ? {}
                : comparisonEvidence(
                    context,
                    conditions ?? [],
                    sample,
                    sellerConditionCounts,
                  ),
            );
            if (
              conditions !== undefined &&
              snapshot.exactComparisonFailures.has(
                comparisonRecoveryKey(context, conditions),
              ) &&
              requiresExactShippingVerification(calculated, rules)
            ) {
              return {
                ...calculated,
                proposedPrice: calculated.currentPrice,
                minimumApplied: false,
                status: "skipped" as const,
                reason:
                  "Exact marketplace verification failed for a high-shipping reference. Refresh the preview before queuing this listing.",
                queueable: false,
              };
            }
            return sample.source === "exact"
              ? {
                  ...calculated,
                  comparisonSource: "exact" as const,
                  reason: `${calculated.reason} Exact listing verification replaced a high-shipping batch reference.`,
                }
              : calculated;
          })();
      const removable =
        !hasSecondaryInventory &&
        context.listing.quantity > 0 &&
        context.listing.customData.customListingId === undefined;
      const removalReason = hasSecondaryInventory
        ? "This SKU also has secondary-channel inventory."
        : context.listing.quantity <= 0
          ? "This listing has no available inventory."
          : context.listing.customData.customListingId !== undefined
            ? "Custom listings cannot be removed automatically."
            : undefined;
      const inventoryRow = {
        ...row,
        removable,
        ...(removalReason === undefined ? {} : { removalReason }),
      };
      if (row.queueable) {
        updates.set(row.id, {
          productId: context.product.productId,
          productName: context.product.productName,
          productConditionId: context.listing.productConditionId,
          conditionId: context.listing.conditionId,
          channelId: context.listing.channelId,
          categoryName: context.product.productLineName,
          quantity: context.listing.quantity,
          price: row.proposedPrice,
          storePriceCustomId: null,
          reserveQuantity: 0,
        });
      }
      if (removable) {
        removals.set(row.id, {
          productId: context.product.productId,
          productName: context.product.productName,
          productConditionId: context.listing.productConditionId,
          conditionId: context.listing.conditionId,
          channelId: context.listing.channelId,
          categoryName: context.product.productLineName,
          currentQuantity: context.listing.quantity,
          price: context.listing.price,
          storePriceCustomId: null,
          reserveQuantity: 0,
        });
      }
      return inventoryRow;
    });
    rows.sort(
      (left, right) =>
        left.productLineName.localeCompare(right.productLineName) ||
        left.setName.localeCompare(right.setName) ||
        left.productName.localeCompare(right.productName) ||
        left.condition.localeCompare(right.condition),
    );
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.previewLifetimeMs);
    const previewId = this.id();
    this.previews.set(previewId, {
      expiresAt: expiresAt.getTime(),
      updates,
      removals,
    });
    options.onProgress?.({
      phase: "finalizing",
      completed: sellerListings.length,
      total: sellerListings.length,
      unit: "listings",
      detail: "Calculating proposed changes",
    });
    return {
      id: previewId,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      rules,
      rows,
      counts: {
        ready: rows.filter((row) => row.status === "ready").length,
        unchanged: rows.filter((row) => row.status === "unchanged").length,
        skipped: rows.filter((row) => row.status === "skipped").length,
      },
      totals: {
        listingCount: rows.length,
        totalQuantity: rows.reduce((total, row) => total + row.quantity, 0),
        currentListingValue: roundCurrency(
          rows.reduce(
            (total, row) => total + row.currentPrice * row.quantity,
            0,
          ),
        ),
      },
      marketplaceSnapshot: {
        capturedAt: snapshot.capturedAt.toISOString(),
        expiresAt: snapshot.expiresAt.toISOString(),
        source,
      },
    };
  }

  takeUpdates(previewId: string, value: unknown): readonly SellerPriceUpdate[] {
    this.removeExpiredPreviews();
    const preview = this.previews.get(previewId);
    if (preview === undefined) {
      throw new ConfigurationError([
        "The repricing preview expired or does not exist. Update the preview again.",
      ]);
    }
    const source = objectValue(value);
    const rowIds = source?.rowIds;
    if (
      !Array.isArray(rowIds) ||
      rowIds.length === 0 ||
      rowIds.some((rowId) => typeof rowId !== "string") ||
      new Set(rowIds).size !== rowIds.length
    ) {
      throw new ConfigurationError([
        "Choose one or more distinct repricing rows to queue.",
      ]);
    }
    const updates = rowIds.map((rowId) => preview.updates.get(String(rowId)));
    if (updates.some((update) => update === undefined)) {
      throw new ConfigurationError([
        "The selection contains a row that is not eligible for repricing.",
      ]);
    }
    this.previews.delete(previewId);
    // A queued mutation can make the seller-inventory portion stale immediately.
    this.marketplace.invalidate();
    return updates as SellerPriceUpdate[];
  }

  takeRemoval(previewId: string, rowId: unknown): SellerInventoryRemoval {
    this.removeExpiredPreviews();
    const preview = this.previews.get(previewId);
    if (preview === undefined) {
      throw new ConfigurationError([
        "The inventory preview expired or does not exist. Update the preview again.",
      ]);
    }
    if (typeof rowId !== "string") {
      throw new ConfigurationError(["The inventory row id is invalid."]);
    }
    const removal = preview.removals.get(rowId);
    if (removal === undefined) {
      throw new ConfigurationError([
        "This inventory row is not eligible for automatic removal.",
      ]);
    }
    return removal;
  }

  private removeExpiredPreviews(): void {
    const now = this.now().getTime();
    for (const [id, preview] of this.previews) {
      if (preview.expiresAt <= now) this.previews.delete(id);
    }
  }

  private currentSellerKey(): string {
    const sellerKey = resolveSellerKey(this.sellerKey).trim();
    if (sellerKey.length === 0 || sellerKey.length > 256) {
      throw new ConfigurationError(["Seller key is invalid."]);
    }
    if (
      this.activeSellerKey !== undefined &&
      this.activeSellerKey.toLowerCase() !== sellerKey.toLowerCase()
    ) {
      this.previews.clear();
      this.marketplace.invalidate();
    }
    this.activeSellerKey = sellerKey;
    return sellerKey;
  }
}
