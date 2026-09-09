import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ApplicationError } from "./errors.js";
import type { LocalInventoryItem } from "./local-inventory-contracts.js";
import type { LocalInventoryService } from "./local-inventory.js";
import {
  parseInventoryItem,
  parseCatalogIdentity,
  parseMoney,
  type CatalogIdentity,
  type InventoryItem,
  type ListingQuote,
  type Money,
} from "./marketplaces/contracts.js";
import {
  MarketplaceValidationError,
  parseConnectionId,
} from "./marketplaces/identity.js";
import type { MarketplaceConnectionRegistry } from "./marketplaces/registry.js";

const PREVIEW_LIFETIME_MS = 15 * 60_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface MarketplacePublicationPreview {
  readonly id: string;
  readonly expiresAt: string;
  readonly connectionId: string;
  readonly connectionLabel: string;
  readonly localInventoryId: string;
  readonly displayName: string;
  readonly quantity: number;
  readonly price: Money;
  readonly exactIdentity: CatalogIdentity;
  readonly currentListing?: InventoryItem;
}

export interface MarketplaceListingQuote extends ListingQuote {
  readonly connectionId: string;
  readonly connectionLabel: string;
  readonly exactIdentity: CatalogIdentity;
}

export interface MarketplacePublicationJob {
  readonly id: string;
  readonly connectionId: string;
  readonly localInventoryId: string;
  readonly displayName: string;
  readonly quantity: number;
  readonly price: Money;
  readonly exactIdentity: CatalogIdentity;
  readonly status: "running" | "submitted" | "review-required";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reasonCode?: string;
}

interface StoredPreview extends MarketplacePublicationPreview {
  readonly localUpdatedAt: string;
  readonly currentFingerprint: string;
}

interface PublicationState {
  readonly version: 1;
  readonly jobs: readonly MarketplacePublicationJob[];
}

export class MarketplacePublicationService {
  private readonly path: string;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly previews = new Map<string, StoredPreview>();
  private writes: Promise<void> = Promise.resolve();

  constructor(
    path: string,
    private readonly localInventory: LocalInventoryService,
    private readonly registry: MarketplaceConnectionRegistry,
    options: { readonly now?: () => Date; readonly id?: () => string } = {},
  ) {
    this.path = resolve(path);
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  async preview(value: unknown): Promise<MarketplacePublicationPreview> {
    const input = publicationInput(value);
    const connection = this.registry.require(input.connectionId);
    const publisher = connection.facets.inventoryPublisher;
    if (publisher === undefined) {
      throw new MarketplaceValidationError(
        "The selected marketplace cannot publish exact inventory listings.",
      );
    }
    const item = await this.localItem(input.localInventoryId);
    if (input.quantity > item.onHand) {
      throw new MarketplaceValidationError(
        "Published quantity cannot exceed local on-hand stock.",
      );
    }
    const exactIdentity = publicationIdentity(item);
    const currentListing = await publisher.readExactInventory(exactIdentity);
    const created = this.now();
    const preview: StoredPreview = {
      id: this.id(),
      expiresAt: new Date(
        created.getTime() + PREVIEW_LIFETIME_MS,
      ).toISOString(),
      connectionId: input.connectionId,
      connectionLabel: connection.descriptor.connectionLabel,
      localInventoryId: item.localInventoryId,
      displayName: item.displayName,
      quantity: input.quantity,
      price: input.price,
      exactIdentity,
      ...(currentListing === undefined ? {} : { currentListing }),
      localUpdatedAt: item.updatedAt,
      currentFingerprint: fingerprint(currentListing),
    };
    this.removeExpiredPreviews();
    this.previews.set(preview.id, preview);
    return publicPreview(preview);
  }

  async quote(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<MarketplaceListingQuote | undefined> {
    const input = listingQuoteInput(value);
    const connection = this.registry.require(input.connectionId);
    const reader = connection.facets.listingQuotes;
    if (reader === undefined) {
      throw new MarketplaceValidationError(
        "The selected marketplace does not provide exact listing quotes.",
      );
    }
    const quote = await reader.quoteExactListing(input.exactIdentity, signal);
    return quote === undefined
      ? undefined
      : {
          ...quote,
          connectionId: input.connectionId,
          connectionLabel: connection.descriptor.connectionLabel,
          exactIdentity: input.exactIdentity,
        };
  }

  async publish(previewId: string): Promise<MarketplacePublicationJob> {
    if (!UUID.test(previewId)) {
      throw new MarketplaceValidationError(
        "The publication preview is invalid.",
      );
    }
    this.removeExpiredPreviews();
    const preview = this.previews.get(previewId);
    if (preview === undefined) {
      throw new ApplicationError(
        "REVIEW_REQUIRED",
        "The publication preview expired. Review the live listing again.",
      );
    }
    this.previews.delete(previewId);
    const item = await this.localItem(preview.localInventoryId);
    if (
      item.updatedAt !== preview.localUpdatedAt ||
      item.onHand < preview.quantity
    ) {
      throw new ApplicationError(
        "REVIEW_REQUIRED",
        "Local stock changed after preview. Review the publication again.",
      );
    }
    const publisher = this.registry.facet(
      preview.connectionId,
      "inventoryPublisher",
    );
    const current = await publisher.readExactInventory(preview.exactIdentity);
    if (fingerprint(current) !== preview.currentFingerprint) {
      throw new ApplicationError(
        "REVIEW_REQUIRED",
        "The live marketplace listing changed after preview.",
      );
    }
    const timestamp = this.now().toISOString();
    let job: MarketplacePublicationJob = {
      id: this.id(),
      connectionId: preview.connectionId,
      localInventoryId: preview.localInventoryId,
      displayName: preview.displayName,
      quantity: preview.quantity,
      price: preview.price,
      exactIdentity: preview.exactIdentity,
      status: "running",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.append(job);
    try {
      const result = await publisher.publishExactInventory({
        exactIdentity: preview.exactIdentity,
        quantity: preview.quantity,
        price: preview.price,
        idempotencyKey: job.id,
      });
      const matches =
        result.item?.quantity === preview.quantity &&
        result.item.price?.currency === preview.price.currency &&
        result.item.price.minorUnits === preview.price.minorUnits;
      job = {
        ...job,
        status:
          result.outcome === "applied" && matches
            ? "submitted"
            : "review-required",
        updatedAt: this.now().toISOString(),
        ...(result.reasonCode === undefined
          ? matches
            ? {}
            : { reasonCode: "RESULT_MISMATCH" }
          : { reasonCode: result.reasonCode }),
      };
    } catch {
      job = {
        ...job,
        status: "review-required",
        updatedAt: this.now().toISOString(),
        reasonCode: "UNCERTAIN_REMOTE_RESULT",
      };
    }
    await this.replace(job);
    return job;
  }

  private async localItem(id: string): Promise<LocalInventoryItem> {
    if (!UUID.test(id)) {
      throw new MarketplaceValidationError(
        "The local inventory item is invalid.",
      );
    }
    const item = (await this.localInventory.snapshot()).items.find(
      (candidate) => candidate.localInventoryId === id,
    );
    if (item === undefined) {
      throw new MarketplaceValidationError(
        "The local inventory item was not found.",
      );
    }
    return item;
  }

  private append(job: MarketplacePublicationJob): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.load();
      await this.save({ version: 1, jobs: [...state.jobs.slice(-199), job] });
    });
  }

  private replace(job: MarketplacePublicationJob): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.load();
      await this.save({
        version: 1,
        jobs: state.jobs.map((candidate) =>
          candidate.id === job.id ? job : candidate,
        ),
      });
    });
  }

  private async load(): Promise<PublicationState> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as {
        version?: unknown;
        jobs?: unknown;
      };
      if (value.version !== 1 || !Array.isArray(value.jobs)) throw new Error();
      return { version: 1, jobs: value.jobs as MarketplacePublicationJob[] };
    } catch (error) {
      if (hasCode(error, "ENOENT")) return { version: 1, jobs: [] };
      throw new ApplicationError(
        "PERSISTENCE_ERROR",
        "Unable to read marketplace publication history.",
        { cause: error },
      );
    }
  }

  private async save(state: PublicationState): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new ApplicationError(
        "PERSISTENCE_ERROR",
        "Unable to persist marketplace publication history.",
        { cause: error },
      );
    }
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.writes.then(work, work);
    this.writes = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private removeExpiredPreviews(): void {
    const now = this.now().getTime();
    for (const [id, preview] of this.previews) {
      if (Date.parse(preview.expiresAt) <= now) this.previews.delete(id);
    }
  }
}

function publicationInput(value: unknown): {
  readonly connectionId: string;
  readonly localInventoryId: string;
  readonly quantity: number;
  readonly price: Money;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MarketplaceValidationError("The publication request is invalid.");
  }
  const source = value as Record<string, unknown>;
  const quantity = source.quantity;
  const localInventoryId = source.localInventoryId;
  if (
    !Number.isSafeInteger(quantity) ||
    Number(quantity) < 1 ||
    Number(quantity) > 99_999
  ) {
    throw new MarketplaceValidationError(
      "Publication quantity must be from 1 through 99999.",
    );
  }
  if (typeof localInventoryId !== "string") {
    throw new MarketplaceValidationError(
      "The local inventory item is invalid.",
    );
  }
  return {
    connectionId: parseConnectionId(source.connectionId),
    localInventoryId,
    quantity: Number(quantity),
    price: parseMoney(source.price),
  };
}

function listingQuoteInput(value: unknown): {
  readonly connectionId: string;
  readonly exactIdentity: CatalogIdentity;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MarketplaceValidationError(
      "The listing quote request is invalid.",
    );
  }
  const source = value as Record<string, unknown>;
  return {
    connectionId: parseConnectionId(source.connectionId),
    exactIdentity: parseCatalogIdentity(source.exactIdentity),
  };
}

function publicationIdentity(item: LocalInventoryItem): CatalogIdentity {
  const identities = item.catalogIdentities.filter(
    (identity) =>
      identity.namespace === "tcgplayer.sku" &&
      identity.precision === "exact-variant",
  );
  if (identities.length !== 1) {
    throw new MarketplaceValidationError(
      "This local item does not have one exact TCGplayer SKU for ManaPool.",
    );
  }
  const identity = identities[0];
  if (identity === undefined) {
    throw new MarketplaceValidationError(
      "This local item does not have an exact TCGplayer SKU for ManaPool.",
    );
  }
  return identity;
}

function fingerprint(item: InventoryItem | undefined): string {
  if (item === undefined) return "missing";
  return JSON.stringify(parseInventoryItem(item));
}

function publicPreview(preview: StoredPreview): MarketplacePublicationPreview {
  return {
    id: preview.id,
    expiresAt: preview.expiresAt,
    connectionId: preview.connectionId,
    connectionLabel: preview.connectionLabel,
    localInventoryId: preview.localInventoryId,
    displayName: preview.displayName,
    quantity: preview.quantity,
    price: preview.price,
    exactIdentity: preview.exactIdentity,
    ...(preview.currentListing === undefined
      ? {}
      : { currentListing: preview.currentListing }),
  };
}

function hasCode(value: unknown, code: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    value.code === code
  );
}
