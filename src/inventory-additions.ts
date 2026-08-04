import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createTcgplayerSellerClient,
  isTcgplayerApiError,
  type CatalogProductDetails,
  type CatalogProductSku,
  type CatalogProductSummary,
  type MarketplaceListing,
  type SellerInventoryAddition,
  type TcgplayerSellerClient,
} from "tcgplayer-private-api";
import type { AppConfig, InventoryAdditionQueueConfig } from "./config.js";
import {
  ApplicationError,
  ConfigurationError,
  safeErrorCode,
} from "./errors.js";
import type { Logger } from "./logger.js";
import { safeIdentifier } from "./logger.js";
import type {
  RepricingConditionPolicy,
  RepricingPriceBasis,
} from "./repricing.js";
import { TCGPLAYER_CONDITION_ORDER } from "./repricing.js";
import { FileSyncLease, type SyncLease } from "./sync-lease.js";

type UnknownRecord = Record<string, unknown>;

export interface InventoryPricingRules {
  readonly minimumPrice: number;
  readonly conditionPolicy: RepricingConditionPolicy;
  readonly priceBasis: RepricingPriceBasis;
  readonly adjustmentCents: number;
  readonly estimatedShippingPrice: number;
  readonly noComparisonFallback: "market" | "manual" | "stop";
  readonly manualPrice?: number;
}

export interface InventoryAdditionPreview {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly product: CatalogProductSummary;
  readonly sku: CatalogProductSku;
  readonly currentQuantity: number;
  readonly addQuantity: number;
  readonly proposedPrice?: number;
  readonly effectiveShippingPrice?: number;
  readonly proposedDeliveredPrice?: number;
  readonly competitorPrice?: number;
  readonly competitorShipping?: number;
  readonly competitorCondition?: string;
  readonly minimumApplied: boolean;
  readonly queueable: boolean;
  readonly reason: string;
  readonly rules: InventoryPricingRules;
}

interface StoredAdditionPreview {
  readonly expiresAt: number;
  readonly addition?: SellerInventoryAddition;
}

export interface InventoryAdditionServiceOptions {
  readonly client: Pick<
    TcgplayerSellerClient,
    "searchCatalogProducts" | "getCatalogProduct" | "searchMarketplaceProducts"
  >;
  readonly sellerKey: string;
  readonly now?: () => Date;
  readonly id?: () => string;
  readonly previewLifetimeMs?: number;
}

function objectValue(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function safeText(
  value: unknown,
  path: string,
  maximum: number,
  issues: string[],
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    containsControlCharacter(value)
  ) {
    issues.push(`${path} must contain 1-${String(maximum)} safe characters.`);
    return "";
  }
  return value.trim();
}

function whole(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  issues: string[],
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    issues.push(
      `${path} must be an integer between ${String(minimum)} and ${String(maximum)}.`,
    );
    return minimum;
  }
  return value;
}

function money(
  value: unknown,
  path: string,
  minimum: number,
  issues: string[],
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > 1_000_000 ||
    Math.abs(value * 100 - Math.round(value * 100)) > 1e-9
  ) {
    issues.push(`${path} must be a valid amount with at most two decimals.`);
    return minimum;
  }
  return value;
}

export function parseInventoryPricingRules(
  value: unknown,
): InventoryPricingRules {
  const source = objectValue(value);
  const issues: string[] = [];
  if (source === undefined) issues.push("Pricing rules must be an object.");
  const minimumPrice = money(
    source?.minimumPrice,
    "minimumPrice",
    0.01,
    issues,
  );
  const conditionPolicy = source?.conditionPolicy;
  if (conditionPolicy !== "same" && conditionPolicy !== "same-or-better") {
    issues.push("conditionPolicy must be same or same-or-better.");
  }
  const priceBasis = source?.priceBasis;
  if (priceBasis !== "item" && priceBasis !== "delivered") {
    issues.push("priceBasis must be item or delivered.");
  }
  const adjustmentCents = whole(
    source?.adjustmentCents,
    "adjustmentCents",
    0,
    100_000,
    issues,
  );
  const estimatedShippingPrice = money(
    source?.estimatedShippingPrice,
    "estimatedShippingPrice",
    0,
    issues,
  );
  const noComparisonFallback = source?.noComparisonFallback;
  if (
    noComparisonFallback !== "market" &&
    noComparisonFallback !== "manual" &&
    noComparisonFallback !== "stop"
  ) {
    issues.push("noComparisonFallback must be market, manual, or stop.");
  }
  const manualPrice =
    noComparisonFallback === "manual"
      ? money(source?.manualPrice, "manualPrice", 0.01, issues)
      : undefined;
  if (issues.length > 0) throw new ConfigurationError(issues);
  return {
    minimumPrice,
    conditionPolicy: conditionPolicy as RepricingConditionPolicy,
    priceBasis: priceBasis as RepricingPriceBasis,
    adjustmentCents,
    estimatedShippingPrice,
    noComparisonFallback: noComparisonFallback as "market" | "manual" | "stop",
    ...(manualPrice === undefined ? {} : { manualPrice }),
  };
}

function allowedConditions(
  condition: string,
  policy: RepricingConditionPolicy,
): readonly string[] | undefined {
  if (policy === "same") return [condition];
  const index = TCGPLAYER_CONDITION_ORDER.indexOf(
    condition as (typeof TCGPLAYER_CONDITION_ORDER)[number],
  );
  return index === -1
    ? undefined
    : TCGPLAYER_CONDITION_ORDER.slice(0, index + 1);
}

function listingBasis(
  listing: MarketplaceListing,
  basis: RepricingPriceBasis,
): number {
  return listing.price + (basis === "delivered" ? listing.shippingPrice : 0);
}

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

const TCGPLAYER_MINIMUM_SHIPPING_ORDER_SUBTOTAL = 5;
const TCGPLAYER_MINIMUM_SHIPPING_PRICE = 1.49;

function effectiveShippingPrice(
  itemPrice: number,
  configuredShippingPrice: number,
): number {
  return itemPrice < TCGPLAYER_MINIMUM_SHIPPING_ORDER_SUBTOTAL
    ? Math.max(configuredShippingPrice, TCGPLAYER_MINIMUM_SHIPPING_PRICE)
    : configuredShippingPrice;
}

function itemPriceForDeliveredTarget(
  deliveredTarget: number,
  configuredShippingPrice: number,
): number {
  const underMinimumCandidate =
    deliveredTarget -
    Math.max(configuredShippingPrice, TCGPLAYER_MINIMUM_SHIPPING_PRICE);
  return underMinimumCandidate < TCGPLAYER_MINIMUM_SHIPPING_ORDER_SUBTOTAL
    ? underMinimumCandidate
    : deliveredTarget - configuredShippingPrice;
}

export class InventoryAdditionService {
  private readonly client: InventoryAdditionServiceOptions["client"];
  private readonly sellerKey: string;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly previewLifetimeMs: number;
  private readonly previews = new Map<string, StoredAdditionPreview>();

  constructor(options: InventoryAdditionServiceOptions) {
    this.client = options.client;
    this.sellerKey = options.sellerKey;
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.previewLifetimeMs = options.previewLifetimeMs ?? 15 * 60_000;
  }

  search(query: string, productLineName?: string) {
    return this.client.searchCatalogProducts({
      query,
      ...(productLineName === undefined || productLineName.trim() === ""
        ? {}
        : { productLineName }),
      limit: 20,
    });
  }

  getProduct(productId: number): Promise<CatalogProductDetails> {
    return this.client.getCatalogProduct({ productId });
  }

  async preview(value: unknown): Promise<InventoryAdditionPreview> {
    this.removeExpiredPreviews();
    const source = objectValue(value);
    const issues: string[] = [];
    if (source === undefined)
      issues.push("The inventory preview must be an object.");
    const productId = whole(
      source?.productId,
      "productId",
      1,
      Number.MAX_SAFE_INTEGER,
      issues,
    );
    const productConditionId = whole(
      source?.productConditionId,
      "productConditionId",
      1,
      Number.MAX_SAFE_INTEGER,
      issues,
    );
    const addQuantity = whole(
      source?.addQuantity,
      "addQuantity",
      1,
      10_000_000,
      issues,
    );
    if (issues.length > 0) throw new ConfigurationError(issues);
    const rules = parseInventoryPricingRules(source?.rules);
    const product = await this.client.getCatalogProduct({ productId });
    const sku = product.skus.find(
      (candidate) => candidate.productConditionId === productConditionId,
    );
    if (sku === undefined) {
      throw new ConfigurationError([
        "The selected condition, printing, and language SKU does not belong to this product.",
      ]);
    }
    const conditions = allowedConditions(sku.condition, rules.conditionPolicy);
    if (conditions === undefined) {
      return this.storePreview(product, sku, addQuantity, rules, {
        currentQuantity: 0,
        minimumApplied: false,
        queueable: false,
        reason: "The selected SKU uses an unsupported condition.",
      });
    }
    const [primary, secondary, comparisons] = await Promise.all([
      this.client.searchMarketplaceProducts({
        productIds: [productId],
        sellerKey: this.sellerKey,
        channelId: 0,
        limit: 24,
      }),
      this.client.searchMarketplaceProducts({
        productIds: [productId],
        sellerKey: this.sellerKey,
        channelId: 1,
        limit: 24,
      }),
      this.client.searchMarketplaceProducts({
        productIds: [productId],
        conditions,
        printings: [sku.printing],
        languages: [sku.language],
        channelId: 0,
        limit: 24,
      }),
    ]);
    const currentListing = primary.products
      .flatMap((item) => item.listings)
      .find(
        (listing) =>
          listing.productConditionId === productConditionId &&
          listing.sellerKey === this.sellerKey &&
          listing.channelId === 0,
      );
    const currentQuantity = currentListing?.quantity ?? 0;
    if (currentListing?.customData.customListingId !== undefined) {
      return this.storePreview(product, sku, addQuantity, rules, {
        currentQuantity,
        minimumApplied: false,
        queueable: false,
        reason: "Custom listings cannot receive automatic inventory additions.",
      });
    }
    const hasSecondaryInventory = secondary.products
      .flatMap((item) => item.listings)
      .some(
        (listing) =>
          listing.productConditionId === productConditionId &&
          listing.sellerKey === this.sellerKey,
      );
    if (hasSecondaryInventory) {
      return this.storePreview(product, sku, addQuantity, rules, {
        currentQuantity,
        minimumApplied: false,
        queueable: false,
        reason:
          "This SKU has secondary-channel inventory, so reserve quantity cannot be preserved safely.",
      });
    }
    const candidates = comparisons.products
      .flatMap((item) => item.listings)
      .filter(
        (listing) =>
          listing.productId === productId &&
          listing.sellerKey !== this.sellerKey &&
          listing.channelId === 0 &&
          listing.printing === sku.printing &&
          listing.language === sku.language &&
          conditions.includes(listing.condition) &&
          listing.quantity > 0 &&
          listing.customData.customListingId === undefined,
      )
      .sort(
        (left, right) =>
          listingBasis(left, rules.priceBasis) -
          listingBasis(right, rules.priceBasis),
      );
    const competitor = candidates[0];
    let rawTarget: number | undefined;
    let reason: string;
    if (competitor !== undefined) {
      const comparisonTarget =
        listingBasis(competitor, rules.priceBasis) -
        rules.adjustmentCents / 100;
      rawTarget =
        rules.priceBasis === "delivered"
          ? itemPriceForDeliveredTarget(
              comparisonTarget,
              rules.estimatedShippingPrice,
            )
          : comparisonTarget;
      reason =
        competitor.condition === sku.condition
          ? "Matches the lowest qualifying listing."
          : `Matches a lower-priced ${competitor.condition} listing because it is a better condition.`;
    } else if (
      rules.noComparisonFallback === "market" &&
      product.marketPrice > 0
    ) {
      rawTarget = product.marketPrice;
      reason =
        "No qualifying listing was found, so the market price fallback was used.";
    } else if (rules.noComparisonFallback === "manual") {
      rawTarget = rules.manualPrice;
      reason =
        "No qualifying listing was found, so the manual fallback was used.";
    } else {
      return this.storePreview(product, sku, addQuantity, rules, {
        currentQuantity,
        minimumApplied: false,
        queueable: false,
        reason:
          "No qualifying competing listing or enabled fallback price was found.",
      });
    }
    if (rawTarget === undefined) {
      throw new ApplicationError(
        "PROVIDER_ERROR",
        "The inventory price could not be calculated.",
      );
    }
    const minimumApplied = rawTarget < rules.minimumPrice;
    const proposedPrice = roundCurrency(
      Math.max(rules.minimumPrice, rawTarget),
    );
    const shippingPrice = roundCurrency(
      effectiveShippingPrice(proposedPrice, rules.estimatedShippingPrice),
    );
    const proposedDeliveredPrice = roundCurrency(proposedPrice + shippingPrice);
    const shippingMinimumApplied =
      rules.priceBasis === "delivered" &&
      shippingPrice > rules.estimatedShippingPrice;
    return this.storePreview(product, sku, addQuantity, rules, {
      currentQuantity,
      proposedPrice,
      effectiveShippingPrice: shippingPrice,
      proposedDeliveredPrice,
      ...(competitor === undefined
        ? {}
        : {
            competitorPrice: competitor.price,
            competitorShipping: competitor.shippingPrice,
            competitorCondition: competitor.condition,
          }),
      minimumApplied,
      queueable: product.sellerListable,
      reason: product.sellerListable
        ? minimumApplied
          ? `${reason} The configured item-price minimum was applied.${shippingMinimumApplied ? ` TCGplayer's $${TCGPLAYER_MINIMUM_SHIPPING_PRICE.toFixed(2)} minimum shipping for orders under $${TCGPLAYER_MINIMUM_SHIPPING_ORDER_SUBTOTAL.toFixed(2)} was also applied.` : ""}`
          : `${reason}${shippingMinimumApplied ? ` TCGplayer's $${TCGPLAYER_MINIMUM_SHIPPING_PRICE.toFixed(2)} minimum shipping for orders under $${TCGPLAYER_MINIMUM_SHIPPING_ORDER_SUBTOTAL.toFixed(2)} was applied.` : ""}`
        : "TCGplayer marks this product as unavailable for seller listings.",
    });
  }

  takeAddition(previewId: string): SellerInventoryAddition {
    this.removeExpiredPreviews();
    const preview = this.previews.get(previewId);
    if (preview?.addition === undefined) {
      throw new ConfigurationError([
        "The inventory preview expired or cannot be queued. Preview the card again.",
      ]);
    }
    this.previews.delete(previewId);
    return preview.addition;
  }

  private storePreview(
    product: CatalogProductDetails,
    sku: CatalogProductSku,
    addQuantity: number,
    rules: InventoryPricingRules,
    result: Omit<
      InventoryAdditionPreview,
      | "id"
      | "createdAt"
      | "expiresAt"
      | "product"
      | "sku"
      | "addQuantity"
      | "rules"
    >,
  ): InventoryAdditionPreview {
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.previewLifetimeMs);
    const id = this.id();
    const addition =
      result.queueable && result.proposedPrice !== undefined
        ? {
            productId: product.productId,
            productName: product.productName,
            productConditionId: sku.productConditionId,
            conditionId: sku.conditionId,
            channelId: 0,
            categoryName: product.productLineName,
            currentQuantity: result.currentQuantity,
            addQuantity,
            price: result.proposedPrice,
            storePriceCustomId: null,
            reserveQuantity: 0,
          }
        : undefined;
    this.previews.set(id, {
      expiresAt: expiresAt.getTime(),
      ...(addition === undefined ? {} : { addition }),
    });
    return {
      id,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      product: {
        productId: product.productId,
        imageUrl: product.imageUrl,
        productName: product.productName,
        productLineName: product.productLineName,
        setName: product.setName,
        rarityName: product.rarityName,
        cardNumber: product.cardNumber,
        marketPrice: product.marketPrice,
        sellerListable: product.sellerListable,
      },
      sku,
      addQuantity,
      rules,
      ...result,
    };
  }

  private removeExpiredPreviews(): void {
    const now = this.now().getTime();
    for (const [id, preview] of this.previews) {
      if (preview.expiresAt <= now) this.previews.delete(id);
    }
  }
}

export type InventoryAdditionJobStatus =
  | "pending"
  | "applying"
  | "submitted"
  | "failed"
  | "review-required"
  | "superseded"
  | "canceled";

export interface InventoryAdditionJob {
  readonly id: string;
  readonly addition: SellerInventoryAddition;
  readonly status: InventoryAdditionJobStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly attempts: number;
  readonly nextAttemptAt?: string;
  readonly errorCode?: string;
}

interface InventoryAdditionQueueState {
  readonly version: 1;
  readonly jobs: readonly InventoryAdditionJob[];
}

export interface InventoryAdditionQueueSnapshot {
  readonly jobs: readonly InventoryAdditionJob[];
  readonly counts: Readonly<Record<InventoryAdditionJobStatus, number>>;
}

export interface InventoryAdditionExecutor {
  apply(addition: SellerInventoryAddition): Promise<void>;
}

const TERMINAL_STATUSES = new Set<InventoryAdditionJobStatus>([
  "submitted",
  "failed",
  "superseded",
  "canceled",
]);

function additionKey(addition: SellerInventoryAddition): string {
  return `${String(addition.productConditionId)}:${String(addition.channelId)}`;
}

function parseAddition(value: unknown): SellerInventoryAddition {
  const source = objectValue(value);
  const issues: string[] = [];
  if (source === undefined)
    issues.push("The inventory addition must be an object.");
  const price = money(source?.price, "addition.price", 0.01, issues);
  const currentQuantity = whole(
    source?.currentQuantity,
    "addition.currentQuantity",
    0,
    10_000_000,
    issues,
  );
  const addQuantity = whole(
    source?.addQuantity,
    "addition.addQuantity",
    1,
    10_000_000,
    issues,
  );
  const addition: SellerInventoryAddition = {
    productId: whole(
      source?.productId,
      "addition.productId",
      1,
      Number.MAX_SAFE_INTEGER,
      issues,
    ),
    productName: safeText(
      source?.productName,
      "addition.productName",
      1024,
      issues,
    ),
    productConditionId: whole(
      source?.productConditionId,
      "addition.productConditionId",
      1,
      Number.MAX_SAFE_INTEGER,
      issues,
    ),
    conditionId: whole(
      source?.conditionId,
      "addition.conditionId",
      1,
      6,
      issues,
    ),
    channelId: whole(
      source?.channelId,
      "addition.channelId",
      0,
      Number.MAX_SAFE_INTEGER,
      issues,
    ),
    categoryName: safeText(
      source?.categoryName,
      "addition.categoryName",
      256,
      issues,
    ),
    currentQuantity,
    addQuantity,
    price,
    storePriceCustomId:
      source?.storePriceCustomId === null
        ? null
        : whole(
            source?.storePriceCustomId,
            "addition.storePriceCustomId",
            0,
            Number.MAX_SAFE_INTEGER,
            issues,
          ),
    reserveQuantity: money(
      source?.reserveQuantity,
      "addition.reserveQuantity",
      0,
      issues,
    ),
  };
  if (currentQuantity + addQuantity > 10_000_000) {
    issues.push("The resulting inventory quantity is too large.");
  }
  if (issues.length > 0) throw new ConfigurationError(issues);
  return addition;
}

function parseQueueState(value: unknown): InventoryAdditionQueueState {
  const source = objectValue(value);
  if (source?.version !== 1 || !Array.isArray(source.jobs)) {
    throw new ApplicationError(
      "PERSISTENCE_ERROR",
      "The inventory-addition queue has an unsupported schema.",
    );
  }
  const statuses = new Set<InventoryAdditionJobStatus>([
    "pending",
    "applying",
    "submitted",
    "failed",
    "review-required",
    "superseded",
    "canceled",
  ]);
  const jobs = source.jobs.map((value, index): InventoryAdditionJob => {
    const job = objectValue(value);
    if (
      job === undefined ||
      typeof job.id !== "string" ||
      !/^[0-9a-f-]{36}$/iu.test(job.id) ||
      typeof job.status !== "string" ||
      !statuses.has(job.status as InventoryAdditionJobStatus) ||
      typeof job.createdAt !== "string" ||
      !Number.isFinite(Date.parse(job.createdAt)) ||
      typeof job.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(job.updatedAt)) ||
      !Number.isSafeInteger(job.attempts) ||
      Number(job.attempts) < 0
    ) {
      throw new ApplicationError(
        "PERSISTENCE_ERROR",
        `Inventory-addition job ${String(index)} is invalid.`,
      );
    }
    return {
      id: job.id,
      addition: parseAddition(job.addition),
      status: job.status as InventoryAdditionJobStatus,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      attempts: Number(job.attempts),
      ...(typeof job.nextAttemptAt === "string"
        ? { nextAttemptAt: job.nextAttemptAt }
        : {}),
      ...(typeof job.errorCode === "string"
        ? { errorCode: job.errorCode }
        : {}),
    };
  });
  return { version: 1, jobs };
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

export class InventoryAdditionQueueStore {
  private readonly stateFile: string;
  private readonly historyLimit: number;
  private readonly now: () => Date;
  private readonly lease: SyncLease;
  private operations: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly stateFile: string;
    readonly historyLimit: number;
    readonly now?: () => Date;
    readonly lease?: SyncLease;
  }) {
    this.stateFile = resolve(options.stateFile);
    this.historyLimit = options.historyLimit;
    this.now = options.now ?? (() => new Date());
    this.lease =
      options.lease ?? new FileSyncLease(`${this.stateFile}.queue-lock`);
  }

  enqueue(value: unknown): Promise<readonly InventoryAdditionJob[]> {
    const addition = parseAddition(value);
    return this.exclusive(async () =>
      this.lease.runExclusive(async () => {
        const state = await this.loadState();
        const timestamp = this.now().toISOString();
        const key = additionKey(addition);
        const previous = state.jobs.find(
          (job) =>
            job.status === "pending" && additionKey(job.addition) === key,
        );
        const combined =
          previous === undefined
            ? addition
            : {
                ...addition,
                addQuantity:
                  previous.addition.addQuantity + addition.addQuantity,
              };
        if (combined.currentQuantity + combined.addQuantity > 10_000_000) {
          throw new ConfigurationError([
            "The combined pending quantity exceeds the supported limit.",
          ]);
        }
        const jobs = state.jobs.map((job) =>
          job.status === "pending" && additionKey(job.addition) === key
            ? {
                ...job,
                status: "superseded" as const,
                updatedAt: timestamp,
              }
            : job,
        );
        const created: InventoryAdditionJob = {
          id: randomUUID(),
          addition: combined,
          status: "pending",
          createdAt: timestamp,
          updatedAt: timestamp,
          attempts: 0,
        };
        await this.saveState({
          version: 1,
          jobs: this.prune([...jobs, created]),
        });
        return [created];
      }),
    );
  }

  snapshot(): Promise<InventoryAdditionQueueSnapshot> {
    return this.exclusive(async () =>
      this.snapshotFrom(await this.loadState()),
    );
  }

  cancel(jobId: string): Promise<InventoryAdditionJob> {
    if (!/^[0-9a-f-]{36}$/iu.test(jobId)) {
      throw new ConfigurationError([
        "The inventory-addition job id is invalid.",
      ]);
    }
    return this.exclusive(async () =>
      this.lease.runExclusive(async () => {
        const state = await this.loadState();
        const existing = state.jobs.find((job) => job.id === jobId);
        if (existing?.status !== "pending") {
          throw new ApplicationError(
            "REVIEW_REQUIRED",
            "Only an existing pending inventory-addition job can be canceled.",
          );
        }
        const canceled = {
          ...existing,
          status: "canceled" as const,
          updatedAt: this.now().toISOString(),
        };
        await this.saveState({
          version: 1,
          jobs: state.jobs.map((job) => (job.id === jobId ? canceled : job)),
        });
        return canceled;
      }),
    );
  }

  recoverInterrupted(): Promise<number> {
    return this.exclusive(async () =>
      this.lease.runExclusive(async () => {
        const state = await this.loadState();
        const timestamp = this.now().toISOString();
        let recovered = 0;
        const jobs = state.jobs.map((job) => {
          if (job.status !== "applying") return job;
          recovered += 1;
          return {
            ...job,
            status: "review-required" as const,
            updatedAt: timestamp,
            errorCode: "INTERRUPTED_DURING_MUTATION",
          };
        });
        if (recovered > 0) await this.saveState({ version: 1, jobs });
        return recovered;
      }),
    );
  }

  claimNext(): Promise<InventoryAdditionJob | undefined> {
    return this.exclusive(async () =>
      this.lease.runExclusive(async () => {
        const state = await this.loadState();
        if (state.jobs.some((job) => job.status === "applying")) {
          return undefined;
        }
        const now = this.now();
        const next = state.jobs.find(
          (job) =>
            job.status === "pending" &&
            (job.nextAttemptAt === undefined ||
              Date.parse(job.nextAttemptAt) <= now.getTime()),
        );
        if (next === undefined) return undefined;
        const claimed: InventoryAdditionJob = {
          ...next,
          status: "applying",
          updatedAt: now.toISOString(),
          attempts: next.attempts + 1,
        };
        await this.saveState({
          version: 1,
          jobs: state.jobs.map((job) => (job.id === next.id ? claimed : job)),
        });
        return claimed;
      }),
    );
  }

  finish(
    jobId: string,
    status: "submitted" | "failed" | "review-required",
    errorCode?: string,
  ): Promise<void> {
    return this.updateApplying(jobId, {
      status,
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  }

  retryAfterRateLimit(jobId: string, delaySeconds: number): Promise<void> {
    return this.updateApplying(jobId, {
      status: "pending",
      nextAttemptAt: new Date(
        this.now().getTime() + delaySeconds * 1000,
      ).toISOString(),
      errorCode: "RATE_LIMITED",
    });
  }

  private updateApplying(
    jobId: string,
    update: Pick<InventoryAdditionJob, "status"> &
      Partial<Pick<InventoryAdditionJob, "nextAttemptAt" | "errorCode">>,
  ): Promise<void> {
    return this.exclusive(async () =>
      this.lease.runExclusive(async () => {
        const state = await this.loadState();
        const existing = state.jobs.find((job) => job.id === jobId);
        if (existing?.status !== "applying") {
          throw new ApplicationError(
            "PERSISTENCE_ERROR",
            "The claimed inventory-addition job changed unexpectedly.",
          );
        }
        const replacement: InventoryAdditionJob = {
          ...existing,
          ...update,
          updatedAt: this.now().toISOString(),
        };
        await this.saveState({
          version: 1,
          jobs: this.prune(
            state.jobs.map((job) => (job.id === jobId ? replacement : job)),
          ),
        });
      }),
    );
  }

  private async loadState(): Promise<InventoryAdditionQueueState> {
    try {
      return parseQueueState(
        JSON.parse(await readFile(this.stateFile, "utf8")) as unknown,
      );
    } catch (error) {
      if (hasCode(error, "ENOENT")) return { version: 1, jobs: [] };
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        "PERSISTENCE_ERROR",
        "Unable to read the inventory-addition queue.",
        { cause: error },
      );
    }
  }

  private async saveState(state: InventoryAdditionQueueState): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true });
    const temporaryPath = `${this.stateFile}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, this.stateFile);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw new ApplicationError(
        "PERSISTENCE_ERROR",
        "Unable to save the inventory-addition queue.",
        { cause: error },
      );
    }
  }

  private prune(
    jobs: readonly InventoryAdditionJob[],
  ): readonly InventoryAdditionJob[] {
    let terminalCount = jobs.filter((job) =>
      TERMINAL_STATUSES.has(job.status),
    ).length;
    if (terminalCount <= this.historyLimit) return jobs;
    return jobs.filter((job) => {
      if (!TERMINAL_STATUSES.has(job.status)) return true;
      if (terminalCount <= this.historyLimit) return true;
      terminalCount -= 1;
      return false;
    });
  }

  private snapshotFrom(
    state: InventoryAdditionQueueState,
  ): InventoryAdditionQueueSnapshot {
    const counts: Record<InventoryAdditionJobStatus, number> = {
      pending: 0,
      applying: 0,
      submitted: 0,
      failed: 0,
      "review-required": 0,
      superseded: 0,
      canceled: 0,
    };
    for (const job of state.jobs) counts[job.status] += 1;
    return { jobs: [...state.jobs].reverse(), counts };
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operations.then(work, work);
    this.operations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolvePromise();
      },
      { once: true },
    );
  });
}

export class InventoryAdditionWorker {
  private readonly idleDelayMs: number;
  private readonly workerLease: SyncLease;

  constructor(
    private readonly options: {
      readonly queue: InventoryAdditionQueueStore;
      readonly executor: InventoryAdditionExecutor;
      readonly settings: () => Promise<InventoryAdditionQueueConfig>;
      readonly logger: Logger;
      readonly idleDelayMs?: number;
      readonly workerLease?: SyncLease;
    },
  ) {
    this.idleDelayMs = options.idleDelayMs ?? 1000;
    this.workerLease = options.workerLease ?? {
      runExclusive: <T>(work: () => Promise<T>) => work(),
    };
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.workerLease.runExclusive(
      () => this.runExclusive(signal),
      signal,
    );
  }

  private async runExclusive(signal: AbortSignal): Promise<void> {
    const recovered = await this.options.queue.recoverInterrupted();
    if (recovered > 0) {
      this.options.logger.error("inventory-queue.interrupted-jobs", {
        count: recovered,
      });
    }
    while (!signal.aborted) {
      const settings = await this.options.settings();
      if (!settings.enabled) {
        await wait(this.idleDelayMs, signal);
        continue;
      }
      const job = await this.options.queue.claimNext();
      if (job === undefined) {
        await wait(this.idleDelayMs, signal);
        continue;
      }
      const listing = safeIdentifier(additionKey(job.addition));
      this.options.logger.info("inventory-queue.applying", {
        jobId: job.id,
        listing,
        attempt: job.attempts,
      });
      try {
        await this.options.executor.apply(job.addition);
        await this.options.queue.finish(job.id, "submitted");
        this.options.logger.info("inventory-queue.submitted", {
          jobId: job.id,
          listing,
        });
      } catch (error) {
        const errorCode = safeErrorCode(error);
        if (isTcgplayerApiError(error) && error.code === "RATE_LIMITED") {
          await this.options.queue.retryAfterRateLimit(
            job.id,
            settings.rateLimitDelaySeconds,
          );
          this.options.logger.error("inventory-queue.rate-limited", {
            jobId: job.id,
            listing,
            retryAfterSeconds: settings.rateLimitDelaySeconds,
          });
        } else if (
          (isTcgplayerApiError(error) && error.code === "AMBIGUOUS_RESULT") ||
          (error instanceof ApplicationError &&
            error.code === "REVIEW_REQUIRED")
        ) {
          await this.options.queue.finish(job.id, "review-required", errorCode);
          this.options.logger.error("inventory-queue.review-required", {
            jobId: job.id,
            listing,
            errorCode,
          });
        } else {
          await this.options.queue.finish(job.id, "failed", errorCode);
          this.options.logger.error("inventory-queue.failed", {
            jobId: job.id,
            listing,
            errorCode,
          });
        }
      }
      await wait(settings.delaySeconds * 1000, signal);
    }
  }
}

export function createTcgplayerInventoryAdditionExecutor(
  config: AppConfig,
  environment: NodeJS.ProcessEnv = process.env,
): InventoryAdditionExecutor {
  const authCookie = environment[config.provider.authCookieEnv]?.trim();
  const sellerKey = environment[config.provider.sellerKeyEnv]?.trim();
  if (!authCookie || !sellerKey) {
    throw new ConfigurationError([
      `Environment variables ${config.provider.authCookieEnv} and ${config.provider.sellerKeyEnv} are required.`,
    ]);
  }
  const client = createTcgplayerSellerClient({ session: { authCookie } });
  return {
    apply: async (addition) => {
      const [primary, secondary] = await Promise.all([
        client.searchMarketplaceProducts({
          productIds: [addition.productId],
          sellerKey,
          channelId: addition.channelId,
          limit: 24,
        }),
        addition.channelId === 0
          ? client.searchMarketplaceProducts({
              productIds: [addition.productId],
              sellerKey,
              channelId: 1,
              limit: 24,
            })
          : Promise.resolve({ totalProducts: 0, products: [] }),
      ]);
      const current = primary.products
        .flatMap((product) => product.listings)
        .find(
          (listing) =>
            listing.productConditionId === addition.productConditionId &&
            listing.sellerKey === sellerKey &&
            listing.channelId === addition.channelId,
        );
      const currentQuantity = current?.quantity ?? 0;
      if (currentQuantity !== addition.currentQuantity) {
        throw new ApplicationError(
          "REVIEW_REQUIRED",
          "Live quantity changed after preview, so the inventory addition was not submitted.",
        );
      }
      if (current?.customData.customListingId !== undefined) {
        throw new ApplicationError(
          "PROVIDER_ERROR",
          "Custom listings cannot receive automatic inventory additions.",
        );
      }
      const hasSecondaryInventory = secondary.products
        .flatMap((product) => product.listings)
        .some(
          (listing) =>
            listing.productConditionId === addition.productConditionId &&
            listing.sellerKey === sellerKey,
        );
      if (hasSecondaryInventory) {
        throw new ApplicationError(
          "REVIEW_REQUIRED",
          "Secondary-channel inventory appeared after preview, so reserve quantity cannot be preserved safely.",
        );
      }
      await client.addSellerInventory({
        additions: [{ ...addition, currentQuantity }],
      });
    },
  };
}
