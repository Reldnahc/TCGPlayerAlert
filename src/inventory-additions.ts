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
  type MarketplaceProduct,
  type SearchMarketplaceProductsResult,
  type SellerInventoryAddition,
  type SellerInventoryRemoval,
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
import {
  resolveSellerKey,
  type SellerKeySource,
} from "./seller-credentials.js";
import {
  environmentSellerCredentialAccess,
  type SellerCredentialAccess,
} from "./seller-credentials.js";
import {
  calculateRepricingRow,
  parseRepricingRules,
  TCGPLAYER_CONDITION_ORDER,
  type RepricingConditionPolicy,
  type RepricingRules,
} from "./repricing.js";
import { FileSyncLease, type SyncLease } from "./sync-lease.js";

type UnknownRecord = Record<string, unknown>;

const CATALOG_SEARCH_PAGE_SIZE = 24;
const CATALOG_SEARCH_CACHE_TTL_MS = 60_000;
const CATALOG_SEARCH_CACHE_LIMIT = 100;

export interface InventoryPricingRules extends RepricingRules {
  readonly estimatedShippingPrice: number;
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

export type CatalogMatchKind = "exact" | "variant" | "related";

export interface CatalogSearchProduct extends CatalogProductSummary {
  readonly matchKind: CatalogMatchKind;
  readonly matchRank: readonly number[];
}

export interface CatalogSearchResult {
  readonly totalProducts: number;
  readonly productLines: readonly {
    readonly name: string;
    readonly count: number;
  }[];
  readonly sets: readonly { readonly name: string; readonly count: number }[];
  readonly products: readonly CatalogSearchProduct[];
  readonly nextOffset: number;
  readonly hasMore: boolean;
}

interface StoredAdditionPreview {
  readonly expiresAt: number;
  readonly addition?: SellerInventoryAddition;
}

interface StoredCatalogSearch {
  readonly expiresAt: number;
  readonly result: CatalogSearchResult;
}

interface StoredCatalogProduct {
  readonly expiresAt: number;
  readonly value: Promise<CatalogProductDetails>;
}

interface InventorySelectionSnapshot {
  readonly product: CatalogProductDetails;
  readonly primary: SearchMarketplaceProductsResult;
  readonly secondary: SearchMarketplaceProductsResult;
}

interface StoredInventorySelectionSnapshot {
  readonly expiresAt: number;
  readonly value: Promise<InventorySelectionSnapshot>;
}

interface StoredInventoryComparisonSnapshot {
  readonly expiresAt: number;
  readonly value: Promise<SearchMarketplaceProductsResult>;
}

export interface InventoryAdditionServiceOptions {
  readonly client: Pick<
    TcgplayerSellerClient,
    "searchCatalogProducts" | "getCatalogProduct" | "searchMarketplaceProducts"
  >;
  readonly sellerKey: SellerKeySource;
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

function normalizeCatalogName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/['’]/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function editDistance(left: string, right: string): number {
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution =
        (previous[rightIndex - 1] ?? 0) +
        (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        (previous[rightIndex] ?? 0) + 1,
        (current[rightIndex - 1] ?? 0) + 1,
        substitution,
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? 0;
}

function catalogNameRank(
  normalizedQuery: string,
  productName: string,
): readonly number[] {
  const name = normalizeCatalogName(productName);
  if (name === normalizedQuery) return [0, 0];
  if (name.startsWith(normalizedQuery)) {
    return [1, name.length - normalizedQuery.length];
  }
  const containedAt = name.indexOf(normalizedQuery);
  if (containedAt >= 0) {
    return [2, containedAt, name.length - normalizedQuery.length];
  }
  const queryTokens = normalizedQuery.split(" ");
  const nameTokens = new Set(name.split(" "));
  const matchedTokens = queryTokens.filter((token) => nameTokens.has(token));
  if (matchedTokens.length === queryTokens.length) {
    return [3, nameTokens.size - queryTokens.length];
  }
  const maximumLength = Math.max(normalizedQuery.length, name.length, 1);
  return [
    4,
    1 - matchedTokens.length / queryTokens.length,
    editDistance(normalizedQuery, name) / maximumLength,
  ];
}

function compareRank(
  left: readonly number[],
  right: readonly number[],
): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function rankCatalogSearchProducts(
  products: readonly CatalogProductSummary[],
  query: string,
): readonly CatalogSearchProduct[] {
  const normalizedQuery = normalizeCatalogName(query);
  return [
    ...new Map(
      products.map((product) => [product.productId, product]),
    ).values(),
  ]
    .sort((left, right) => {
      const rankDifference = compareRank(
        catalogNameRank(normalizedQuery, left.productName),
        catalogNameRank(normalizedQuery, right.productName),
      );
      return (
        rankDifference ||
        left.productName.localeCompare(right.productName) ||
        left.productLineName.localeCompare(right.productLineName) ||
        left.setName.localeCompare(right.setName) ||
        left.cardNumber.localeCompare(right.cardNumber) ||
        left.productId - right.productId
      );
    })
    .map((product) => {
      const matchRank = catalogNameRank(normalizedQuery, product.productName);
      const category = matchRank[0];
      return {
        ...product,
        matchRank,
        matchKind:
          category === 0
            ? "exact"
            : category === 1 || category === 2 || category === 3
              ? "variant"
              : "related",
      };
    });
}

function parseCatalogProductNumber(query: string): number | undefined {
  const normalized = query.trim();
  if (!/^\d+$/u.test(normalized)) return undefined;
  const productId = Number(normalized);
  if (!Number.isSafeInteger(productId) || productId < 1) {
    throw new ConfigurationError([
      "TCGplayer product number must be a positive integer.",
    ]);
  }
  return productId;
}

function catalogProductSearchResult(
  product: CatalogProductDetails,
  offset: number,
): CatalogSearchResult {
  const products: readonly CatalogSearchProduct[] =
    offset === 0
      ? [
          {
            productId: product.productId,
            imageUrl: product.imageUrl,
            productName: product.productName,
            productLineName: product.productLineName,
            setName: product.setName,
            rarityName: product.rarityName,
            cardNumber: product.cardNumber,
            marketPrice: product.marketPrice,
            sellerListable: product.sellerListable,
            matchKind: "exact",
            matchRank: [0, 0],
          },
        ]
      : [];
  return {
    totalProducts: 1,
    productLines: [{ name: product.productLineName, count: 1 }],
    sets: [{ name: product.setName, count: 1 }],
    products,
    nextOffset: 1,
    hasMore: false,
  };
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
  const estimatedShippingPrice = money(
    source?.estimatedShippingPrice,
    "estimatedShippingPrice",
    0,
    issues,
  );
  if (issues.length > 0) throw new ConfigurationError(issues);
  const repricingRules = parseRepricingRules(value);
  return {
    ...repricingRules,
    estimatedShippingPrice,
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

function newListingPricingRules(rules: InventoryPricingRules): RepricingRules {
  return {
    ...rules,
    allowPriceIncreases: true,
    ranges: rules.ranges.map((range) =>
      range.gapAction === "skip"
        ? { ...range, gapAction: "use-next" as const }
        : range,
    ),
  };
}

function calculateInventoryAdditionPrice(
  product: CatalogProductDetails,
  sku: CatalogProductSku,
  currentQuantity: number,
  comparisonListings: readonly MarketplaceListing[],
  sellerKey: string,
  rules: InventoryPricingRules,
) {
  let shippingPrice = rules.estimatedShippingPrice;
  let result: ReturnType<typeof calculateRepricingRow> | undefined;
  const pricingRules = newListingPricingRules(rules);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const ownListing: MarketplaceListing = {
      listingId: 0,
      productId: product.productId,
      productConditionId: sku.productConditionId,
      conditionId: sku.conditionId,
      condition: sku.condition,
      channelId: 0,
      printing: sku.printing,
      language: sku.language,
      languageId: 0,
      sellerKey,
      sellerName: "Current seller",
      quantity: currentQuantity,
      price: 0,
      shippingPrice,
      customData: {},
    };
    const marketplaceProduct: MarketplaceProduct = {
      productId: product.productId,
      productName: product.productName,
      productLineName: product.productLineName,
      setName: product.setName,
      rarityName: product.rarityName,
      marketPrice: product.marketPrice,
      totalListings: comparisonListings.length,
      listings: [ownListing],
    };
    result = calculateRepricingRow(
      { product: marketplaceProduct, listing: ownListing },
      comparisonListings,
      sellerKey,
      pricingRules,
      "inventory-addition",
    );
    if (!result.queueable) return result;
    const effectiveShipping = roundCurrency(
      effectiveShippingPrice(
        result.proposedPrice,
        rules.estimatedShippingPrice,
      ),
    );
    if (effectiveShipping === shippingPrice) return result;
    shippingPrice = effectiveShipping;
  }
  if (result === undefined) {
    throw new ApplicationError(
      "PROVIDER_ERROR",
      "The inventory price could not be calculated.",
    );
  }
  return result;
}

export class InventoryAdditionService {
  private readonly client: InventoryAdditionServiceOptions["client"];
  private readonly sellerKey: SellerKeySource;
  private activeSellerKey: string | undefined;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly previewLifetimeMs: number;
  private readonly previews = new Map<string, StoredAdditionPreview>();
  private readonly catalogSearches = new Map<string, StoredCatalogSearch>();
  private readonly catalogProducts = new Map<number, StoredCatalogProduct>();
  private readonly selectionSnapshots = new Map<
    string,
    StoredInventorySelectionSnapshot
  >();
  private readonly comparisonSnapshots = new Map<
    string,
    StoredInventoryComparisonSnapshot
  >();

  constructor(options: InventoryAdditionServiceOptions) {
    this.client = options.client;
    this.sellerKey = options.sellerKey;
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.previewLifetimeMs = options.previewLifetimeMs ?? 15 * 60_000;
  }

  async search(
    query: string,
    productLineName?: string,
    offset = 0,
    signal?: AbortSignal,
    setName?: string,
  ): Promise<CatalogSearchResult> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
      throw new ConfigurationError([
        "Catalog search offset must be between 0 and 1000000.",
      ]);
    }
    signal?.throwIfAborted();
    this.removeExpiredCatalogSearches();
    const cacheKey = JSON.stringify([
      query.trim().toLocaleLowerCase("en-US"),
      productLineName?.trim().toLocaleLowerCase("en-US") ?? "",
      setName?.trim().toLocaleLowerCase("en-US") ?? "",
      offset,
    ]);
    const cached = this.catalogSearches.get(cacheKey);
    if (cached !== undefined) return cached.result;
    const productId = parseCatalogProductNumber(query);
    let searchResult: CatalogSearchResult;
    if (productId !== undefined) {
      const product = await this.getProduct(productId);
      searchResult = catalogProductSearchResult(product, offset);
    } else {
      const result = await this.client.searchCatalogProducts(
        {
          query,
          productTypeName: "Cards",
          ...(productLineName === undefined || productLineName.trim() === ""
            ? {}
            : { productLineName }),
          ...(setName === undefined || setName.trim() === ""
            ? {}
            : { setName }),
          offset,
          limit: CATALOG_SEARCH_PAGE_SIZE,
          includeFoilMarketPrices: true,
        },
        signal === undefined ? undefined : { signal },
      );
      const nextOffset = Math.min(
        offset + CATALOG_SEARCH_PAGE_SIZE,
        result.totalProducts,
      );
      searchResult = {
        totalProducts: result.totalProducts,
        productLines: result.productLines,
        sets: result.sets,
        products: rankCatalogSearchProducts(result.products, query),
        nextOffset,
        hasMore: nextOffset < result.totalProducts,
      };
    }
    signal?.throwIfAborted();
    if (this.catalogSearches.size >= CATALOG_SEARCH_CACHE_LIMIT) {
      const oldestKey = this.catalogSearches.keys().next().value;
      if (oldestKey !== undefined) this.catalogSearches.delete(oldestKey);
    }
    this.catalogSearches.set(cacheKey, {
      expiresAt: this.now().getTime() + CATALOG_SEARCH_CACHE_TTL_MS,
      result: searchResult,
    });
    return searchResult;
  }

  getProduct(productId: number): Promise<CatalogProductDetails> {
    this.removeExpiredSelectionData();
    const cached = this.catalogProducts.get(productId);
    if (cached !== undefined) return cached.value;
    const value = this.client.getCatalogProduct({ productId });
    this.catalogProducts.set(productId, {
      expiresAt: this.now().getTime() + this.previewLifetimeMs,
      value,
    });
    void value.catch(() => {
      if (this.catalogProducts.get(productId)?.value === value) {
        this.catalogProducts.delete(productId);
      }
    });
    return value;
  }

  private removeExpiredCatalogSearches(): void {
    const now = this.now().getTime();
    for (const [key, search] of this.catalogSearches) {
      if (search.expiresAt <= now) this.catalogSearches.delete(key);
    }
  }

  async preview(value: unknown): Promise<InventoryAdditionPreview> {
    const sellerKey = this.currentSellerKey();
    this.removeExpiredPreviews();
    this.removeExpiredSelectionData();
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
    const product = await this.getProduct(productId);
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
    const [{ primary, secondary }, comparisons] = await Promise.all([
      this.selectionSnapshot(product),
      this.comparisonSnapshot(product, sku, conditions),
    ]);
    const currentListing = primary.products
      .flatMap((item) => item.listings)
      .find(
        (listing) =>
          listing.productConditionId === productConditionId &&
          listing.sellerKey === sellerKey &&
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
          listing.sellerKey === sellerKey,
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
    const pricing = calculateInventoryAdditionPrice(
      product,
      sku,
      currentQuantity,
      comparisons.products.flatMap((item) => item.listings),
      sellerKey,
      rules,
    );
    if (!pricing.queueable) {
      return this.storePreview(product, sku, addQuantity, rules, {
        currentQuantity,
        minimumApplied: pricing.minimumApplied,
        queueable: false,
        reason: pricing.reason,
      });
    }
    const proposedPrice = pricing.proposedPrice;
    const shippingPrice = roundCurrency(
      effectiveShippingPrice(proposedPrice, rules.estimatedShippingPrice),
    );
    const proposedDeliveredPrice = roundCurrency(proposedPrice + shippingPrice);
    return this.storePreview(product, sku, addQuantity, rules, {
      currentQuantity,
      proposedPrice,
      effectiveShippingPrice: shippingPrice,
      proposedDeliveredPrice,
      ...(pricing.competitorPrice === undefined
        ? {}
        : {
            competitorPrice: pricing.competitorPrice,
            competitorShipping: pricing.competitorShipping,
            competitorCondition: pricing.competitorCondition,
          }),
      minimumApplied: pricing.minimumApplied,
      queueable: product.sellerListable,
      reason: product.sellerListable
        ? pricing.reason
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

  private selectionSnapshot(
    product: CatalogProductDetails,
  ): Promise<InventorySelectionSnapshot> {
    const key = String(product.productId);
    const cached = this.selectionSnapshots.get(key);
    if (cached !== undefined) return cached.value;
    const value = this.loadSelectionSnapshot(product);
    this.selectionSnapshots.set(key, {
      expiresAt: this.now().getTime() + this.previewLifetimeMs,
      value,
    });
    void value.catch(() => {
      if (this.selectionSnapshots.get(key)?.value === value) {
        this.selectionSnapshots.delete(key);
      }
    });
    return value;
  }

  private async loadSelectionSnapshot(
    product: CatalogProductDetails,
  ): Promise<InventorySelectionSnapshot> {
    const [primary, secondary] = await Promise.all([
      this.client.searchMarketplaceProducts({
        productIds: [product.productId],
        sellerKey: this.currentSellerKey(),
        channelId: 0,
        limit: 24,
      }),
      this.client.searchMarketplaceProducts({
        productIds: [product.productId],
        sellerKey: this.currentSellerKey(),
        channelId: 1,
        limit: 24,
      }),
    ]);
    return { product, primary, secondary };
  }

  private comparisonSnapshot(
    product: CatalogProductDetails,
    sku: CatalogProductSku,
    conditions: readonly string[],
  ): Promise<SearchMarketplaceProductsResult> {
    const key = JSON.stringify([
      product.productId,
      sku.printing,
      sku.language,
      conditions,
    ]);
    const cached = this.comparisonSnapshots.get(key);
    if (cached !== undefined) return cached.value;
    const value = this.client.searchMarketplaceProducts({
      productIds: [product.productId],
      conditions,
      printings: [sku.printing],
      languages: [sku.language],
      channelId: 0,
      limit: 24,
    });
    this.comparisonSnapshots.set(key, {
      expiresAt: this.now().getTime() + this.previewLifetimeMs,
      value,
    });
    void value.catch(() => {
      if (this.comparisonSnapshots.get(key)?.value === value) {
        this.comparisonSnapshots.delete(key);
      }
    });
    return value;
  }

  private removeExpiredSelectionData(): void {
    const now = this.now().getTime();
    for (const [productId, product] of this.catalogProducts) {
      if (product.expiresAt <= now) this.catalogProducts.delete(productId);
    }
    for (const [key, snapshot] of this.selectionSnapshots) {
      if (snapshot.expiresAt <= now) this.selectionSnapshots.delete(key);
    }
    for (const [key, snapshot] of this.comparisonSnapshots) {
      if (snapshot.expiresAt <= now) this.comparisonSnapshots.delete(key);
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
      this.catalogSearches.clear();
      this.catalogProducts.clear();
      this.selectionSnapshots.clear();
      this.comparisonSnapshots.clear();
    }
    this.activeSellerKey = sellerKey;
    return sellerKey;
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

interface InventoryAdditionJobBase {
  readonly id: string;
  readonly status: InventoryAdditionJobStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly attempts: number;
  readonly nextAttemptAt?: string;
  readonly errorCode?: string;
  readonly resubmittedFromJobId?: string;
}

export type InventoryAdditionJob =
  | (InventoryAdditionJobBase & {
      readonly operation: "add";
      readonly addition: SellerInventoryAddition;
    })
  | (InventoryAdditionJobBase & {
      readonly operation: "remove";
      readonly removal: SellerInventoryRemoval;
    });

interface InventoryAdditionQueueState {
  readonly version: 1;
  readonly jobs: readonly InventoryAdditionJob[];
}

export interface InventoryAdditionQueueSnapshot {
  readonly jobs: readonly InventoryAdditionJob[];
  readonly counts: Readonly<Record<InventoryAdditionJobStatus, number>>;
}

export interface InventoryAdditionExecutor {
  apply(
    change: SellerInventoryAddition | SellerInventoryRemoval,
    operation: InventoryAdditionJob["operation"],
  ): Promise<void>;
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

function removalKey(removal: SellerInventoryRemoval): string {
  return `${String(removal.productConditionId)}:${String(removal.channelId)}`;
}

function jobKey(job: InventoryAdditionJob): string {
  return job.operation === "add"
    ? additionKey(job.addition)
    : removalKey(job.removal);
}

function jobChange(
  job: InventoryAdditionJob,
): SellerInventoryAddition | SellerInventoryRemoval {
  return job.operation === "add" ? job.addition : job.removal;
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
      Number.MAX_SAFE_INTEGER,
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

function parseRemoval(value: unknown): SellerInventoryRemoval {
  const source = objectValue(value);
  const issues: string[] = [];
  if (source === undefined)
    issues.push("The inventory removal must be an object.");
  const reserveQuantity = money(
    source?.reserveQuantity,
    "removal.reserveQuantity",
    0,
    issues,
  );
  if (reserveQuantity !== 0) {
    issues.push("removal.reserveQuantity must be zero.");
  }
  const removal: SellerInventoryRemoval = {
    productId: whole(
      source?.productId,
      "removal.productId",
      1,
      Number.MAX_SAFE_INTEGER,
      issues,
    ),
    productName: safeText(
      source?.productName,
      "removal.productName",
      1024,
      issues,
    ),
    productConditionId: whole(
      source?.productConditionId,
      "removal.productConditionId",
      1,
      Number.MAX_SAFE_INTEGER,
      issues,
    ),
    conditionId: whole(
      source?.conditionId,
      "removal.conditionId",
      1,
      Number.MAX_SAFE_INTEGER,
      issues,
    ),
    channelId: whole(source?.channelId, "removal.channelId", 0, 0, issues),
    categoryName: safeText(
      source?.categoryName,
      "removal.categoryName",
      256,
      issues,
    ),
    currentQuantity: whole(
      source?.currentQuantity,
      "removal.currentQuantity",
      1,
      10_000_000,
      issues,
    ),
    price: money(source?.price, "removal.price", 0.01, issues),
    storePriceCustomId:
      source?.storePriceCustomId === null
        ? null
        : whole(
            source?.storePriceCustomId,
            "removal.storePriceCustomId",
            0,
            Number.MAX_SAFE_INTEGER,
            issues,
          ),
    reserveQuantity,
  };
  if (issues.length > 0) throw new ConfigurationError(issues);
  return removal;
}

function parseQueueState(value: unknown): InventoryAdditionQueueState {
  const source = objectValue(value);
  if (source?.version !== 1 || !Array.isArray(source.jobs)) {
    throw new ApplicationError(
      "PERSISTENCE_ERROR",
      "The inventory-change queue has an unsupported schema.",
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
      Number(job.attempts) < 0 ||
      (job.resubmittedFromJobId !== undefined &&
        (typeof job.resubmittedFromJobId !== "string" ||
          !/^[0-9a-f-]{36}$/iu.test(job.resubmittedFromJobId)))
    ) {
      throw new ApplicationError(
        "PERSISTENCE_ERROR",
        `Inventory-change job ${String(index)} is invalid.`,
      );
    }
    const operation = job.operation === "remove" ? "remove" : "add";
    const base = {
      id: job.id,
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
      ...(typeof job.resubmittedFromJobId === "string"
        ? { resubmittedFromJobId: job.resubmittedFromJobId }
        : {}),
    };
    return operation === "remove"
      ? { ...base, operation, removal: parseRemoval(job.removal) }
      : { ...base, operation, addition: parseAddition(job.addition) };
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
            job.status === "pending" &&
            job.operation === "add" &&
            additionKey(job.addition) === key,
        );
        const combined =
          previous?.operation !== "add"
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
          job.status === "pending" && jobKey(job) === key
            ? {
                ...job,
                status: "superseded" as const,
                updatedAt: timestamp,
              }
            : job,
        );
        const created: InventoryAdditionJob = {
          id: randomUUID(),
          operation: "add",
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

  enqueueRemoval(value: unknown): Promise<InventoryAdditionJob> {
    const removal = parseRemoval(value);
    return this.exclusive(async () =>
      this.lease.runExclusive(async () => {
        const state = await this.loadState();
        const timestamp = this.now().toISOString();
        const key = removalKey(removal);
        const jobs = state.jobs.map((job) =>
          job.status === "pending" && jobKey(job) === key
            ? {
                ...job,
                status: "superseded" as const,
                updatedAt: timestamp,
              }
            : job,
        );
        const created: InventoryAdditionJob = {
          id: randomUUID(),
          operation: "remove",
          removal,
          status: "pending",
          createdAt: timestamp,
          updatedAt: timestamp,
          attempts: 0,
        };
        await this.saveState({
          version: 1,
          jobs: this.prune([...jobs, created]),
        });
        return created;
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
      throw new ConfigurationError(["The inventory-change job id is invalid."]);
    }
    return this.exclusive(async () =>
      this.lease.runExclusive(async () => {
        const state = await this.loadState();
        const existing = state.jobs.find((job) => job.id === jobId);
        if (existing?.status !== "pending") {
          throw new ApplicationError(
            "REVIEW_REQUIRED",
            "Only an existing pending inventory-change job can be canceled.",
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

  resubmit(jobId: string): Promise<InventoryAdditionJob> {
    if (!/^[0-9a-f-]{36}$/iu.test(jobId)) {
      throw new ConfigurationError(["The inventory-change job id is invalid."]);
    }
    return this.exclusive(async () =>
      this.lease.runExclusive(async () => {
        const state = await this.loadState();
        const existing = state.jobs.find((job) => job.id === jobId);
        if (existing === undefined) {
          throw new ApplicationError(
            "PROVIDER_ERROR",
            "The inventory-change job was not found.",
          );
        }
        if (existing.status !== "failed") {
          throw new ApplicationError(
            "REVIEW_REQUIRED",
            "Only a failed inventory-change job can be resubmitted.",
          );
        }
        if (state.jobs.some((job) => job.resubmittedFromJobId === jobId)) {
          throw new ApplicationError(
            "REVIEW_REQUIRED",
            "This failed inventory-change job has already been resubmitted.",
          );
        }
        const timestamp = this.now().toISOString();
        const created: InventoryAdditionJob = {
          id: randomUUID(),
          ...(existing.operation === "add"
            ? { operation: "add" as const, addition: existing.addition }
            : { operation: "remove" as const, removal: existing.removal }),
          status: "pending",
          createdAt: timestamp,
          updatedAt: timestamp,
          attempts: 0,
          resubmittedFromJobId: jobId,
        };
        await this.saveState({
          version: 1,
          jobs: this.prune([...state.jobs, created]),
        });
        return created;
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

  pauseForAuthentication(jobId: string): Promise<void> {
    return this.updateApplying(jobId, {
      status: "pending",
      nextAttemptAt: this.now().toISOString(),
      errorCode: "AUTHENTICATION_REQUIRED",
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
            "The claimed inventory-change job changed unexpectedly.",
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
        "Unable to read the inventory-change queue.",
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
        "Unable to save the inventory-change queue.",
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
      readonly canProcess?: () => boolean;
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
      if (!settings.enabled || this.options.canProcess?.() === false) {
        await wait(this.idleDelayMs, signal);
        continue;
      }
      const job = await this.options.queue.claimNext();
      if (job === undefined) {
        await wait(this.idleDelayMs, signal);
        continue;
      }
      const listing = safeIdentifier(jobKey(job));
      this.options.logger.info("inventory-queue.applying", {
        jobId: job.id,
        listing,
        attempt: job.attempts,
      });
      try {
        await this.options.executor.apply(jobChange(job), job.operation);
        await this.options.queue.finish(job.id, "submitted");
        this.options.logger.info("inventory-queue.submitted", {
          jobId: job.id,
          listing,
        });
      } catch (error) {
        const errorCode = safeErrorCode(error);
        if (
          isTcgplayerApiError(error) &&
          error.code === "AUTHENTICATION_REQUIRED"
        ) {
          await this.options.queue.pauseForAuthentication(job.id);
          this.options.logger.error("inventory-queue.authentication-required", {
            jobId: job.id,
            listing,
          });
        } else if (
          isTcgplayerApiError(error) &&
          error.code === "RATE_LIMITED"
        ) {
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
  credentials?: SellerCredentialAccess,
  sharedClient?: TcgplayerSellerClient,
): InventoryAdditionExecutor {
  const access =
    credentials ??
    environmentSellerCredentialAccess(
      config.provider.authCookieEnv,
      config.provider.sellerKeyEnv,
      environment,
    );
  const client =
    sharedClient ??
    createTcgplayerSellerClient({
      session: access.session,
      onAuthenticationRequired: access.onAuthenticationRequired,
    });
  return {
    apply: async (change, operation) => {
      const sellerKey = access.sellerKey();
      const [primary, secondary] = await Promise.all([
        client.searchMarketplaceProducts({
          productIds: [change.productId],
          sellerKey,
          channelId: change.channelId,
          limit: 24,
        }),
        change.channelId === 0
          ? client.searchMarketplaceProducts({
              productIds: [change.productId],
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
            listing.productConditionId === change.productConditionId &&
            listing.sellerKey === sellerKey &&
            listing.channelId === change.channelId,
        );
      const currentQuantity = current?.quantity ?? 0;
      if (operation === "remove" && currentQuantity === 0) return;
      if (currentQuantity !== change.currentQuantity) {
        throw new ApplicationError(
          "REVIEW_REQUIRED",
          `Live quantity changed after preview, so the inventory ${operation === "add" ? "addition" : "removal"} was not submitted.`,
        );
      }
      if (current?.customData.customListingId !== undefined) {
        throw new ApplicationError(
          "PROVIDER_ERROR",
          `Custom listings cannot receive automatic inventory ${operation === "add" ? "additions" : "removals"}.`,
        );
      }
      const hasSecondaryInventory = secondary.products
        .flatMap((product) => product.listings)
        .some(
          (listing) =>
            listing.productConditionId === change.productConditionId &&
            listing.sellerKey === sellerKey,
        );
      if (hasSecondaryInventory) {
        throw new ApplicationError(
          "REVIEW_REQUIRED",
          "Secondary-channel inventory appeared after preview, so reserve quantity cannot be preserved safely.",
        );
      }
      if (operation === "add") {
        if (!("addQuantity" in change)) {
          throw new ApplicationError(
            "PERSISTENCE_ERROR",
            "The inventory job operation does not match its payload.",
          );
        }
        await client.addSellerInventory({
          additions: [
            {
              ...change,
              currentQuantity,
            },
          ],
        });
        return;
      }
      if (current === undefined) return;
      if ("addQuantity" in change) {
        throw new ApplicationError(
          "PERSISTENCE_ERROR",
          "The inventory job operation does not match its payload.",
        );
      }
      await client.removeSellerInventory({
        removals: [
          {
            ...change,
            currentQuantity,
            conditionId: current.conditionId,
            price: current.price,
            storePriceCustomId: null,
            reserveQuantity: 0,
          },
        ],
      });
    },
  };
}
