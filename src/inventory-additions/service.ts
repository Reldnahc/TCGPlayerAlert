import { randomUUID } from "node:crypto";
import type {
  CatalogProductDetails,
  CatalogProductSku,
  CatalogProductSummary,
  MarketplaceListing,
  MarketplaceProduct,
  SearchMarketplaceProductsResult,
  SellerInventoryAddition,
  TcgplayerSellerClient,
} from "tcgplayer-private-api";
import { ApplicationError, ConfigurationError } from "../errors.js";
import {
  resolveSellerKey,
  type SellerKeySource,
} from "../seller-credentials.js";
import {
  calculateRepricingRow,
  parseRepricingRules,
  TCGPLAYER_CONDITION_ORDER,
  type RepricingConditionPolicy,
  type RepricingRules,
} from "../repricing.js";
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

export interface InventoryAdditionPreviewOptions {
  readonly forceRefresh?: boolean;
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
    .replace(/['â€™]/gu, "")
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

  async preview(
    value: unknown,
    options: InventoryAdditionPreviewOptions = {},
  ): Promise<InventoryAdditionPreview> {
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
    if (options.forceRefresh === true) {
      this.invalidateSelectionData(productId);
    }
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

  private invalidateSelectionData(productId: number): void {
    this.catalogProducts.delete(productId);
    this.selectionSnapshots.delete(String(productId));
    const prefix = `[${String(productId)},`;
    for (const key of this.comparisonSnapshots.keys()) {
      if (key.startsWith(prefix)) this.comparisonSnapshots.delete(key);
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
