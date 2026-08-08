import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  TcgplayerApiError,
  type CatalogProductDetails,
  type MarketplaceListing,
  type SellerInventoryAddition,
  type SellerInventoryRemoval,
} from "tcgplayer-private-api";
import {
  createTcgplayerInventoryAdditionExecutor,
  immediateSyncLease,
  InventoryAdditionQueueStore,
  InventoryAdditionService,
  InventoryAdditionWorker,
  parseConfig,
  rankCatalogSearchProducts,
  type InventoryAdditionExecutor,
  type InventoryPricingRules,
  type Logger,
} from "../src/index.js";

const product: CatalogProductDetails = {
  productId: 123,
  imageUrl: "https://product-images.tcgplayer.com/fit-in/200x279/123.jpg",
  productName: "Synthetic Card",
  productLineName: "Synthetic Game",
  setName: "Synthetic Set",
  rarityName: "Rare",
  cardNumber: "42",
  marketPrice: 3.5,
  sellerListable: true,
  skus: [
    {
      productConditionId: 456,
      conditionId: 3,
      condition: "Moderately Played",
      printing: "Normal",
      language: "English",
    },
  ],
};

function listing(
  overrides: Partial<MarketplaceListing> = {},
): MarketplaceListing {
  return {
    listingId: 77,
    productId: 123,
    productConditionId: 789,
    conditionId: 2,
    condition: "Lightly Played",
    channelId: 0,
    printing: "Normal",
    language: "English",
    languageId: 1,
    sellerKey: "competitor",
    sellerName: "Synthetic Competitor",
    quantity: 1,
    price: 2,
    shippingPrice: 0.99,
    customData: {},
    ...overrides,
  };
}

function searchResult(listings: readonly MarketplaceListing[]) {
  return {
    totalProducts: listings.length === 0 ? 0 : 1,
    products:
      listings.length === 0
        ? []
        : [
            {
              productId: 123,
              productName: "Synthetic Card",
              productLineName: "Synthetic Game",
              setName: "Synthetic Set",
              rarityName: "Rare",
              marketPrice: 3.5,
              totalListings: listings.length,
              listings,
            },
          ],
  };
}

function additionPricingRules(
  overrides: Partial<InventoryPricingRules> = {},
): InventoryPricingRules {
  return {
    minimumPrice: 0.35,
    conditionPolicy: "same-or-better",
    priceBasis: "item",
    adjustmentCents: 0,
    allowPriceIncreases: false,
    estimatedShippingPrice: 0,
    ranges: [
      {
        minimumListings: 1,
        priceSource: "lowest",
        percentage: 100,
        gapThresholdPercent: 100,
        gapAction: "follow-lowest",
        supportMode: "adjacent",
        minimumSellerSupport: 1,
        supportWindowPercent: 5,
      },
    ],
    ...overrides,
  };
}

const addition: SellerInventoryAddition = {
  productId: 123,
  productName: "Synthetic Card",
  productConditionId: 456,
  conditionId: 3,
  channelId: 0,
  categoryName: "Synthetic Game",
  currentQuantity: 2,
  addQuantity: 1,
  price: 2,
  storePriceCustomId: null,
  reserveQuantity: 0,
};

const removal: SellerInventoryRemoval = {
  productId: 123,
  productName: "Synthetic Card",
  productConditionId: 456,
  conditionId: 3,
  channelId: 0,
  categoryName: "Synthetic Game",
  currentQuantity: 2,
  price: 2,
  storePriceCustomId: null,
  reserveQuantity: 0,
};

const logger: Logger = {
  info: vi.fn(),
  error: vi.fn(),
};

async function queueFixture(now = new Date("2026-08-04T12:00:00.000Z")) {
  const directory = await mkdtemp(join(tmpdir(), "tcgplayer-inventory-queue-"));
  const path = join(directory, "queue.json");
  return {
    path,
    queue: new InventoryAdditionQueueStore({
      stateFile: path,
      historyLimit: 25,
      now: () => now,
      lease: immediateSyncLease,
    }),
  };
}

describe("inventory additions", () => {
  it("loads and ranks one catalog page with product-line and set facets", async () => {
    const related = { ...product, productId: 1, productName: "Synthetic Box" };
    const variant = {
      ...product,
      productId: 2,
      productName: "Synthetic Card [Extended Art]",
    };
    const exact = { ...product, productId: 3 };
    const searchCatalogProducts = vi.fn(
      (input: { offset?: number; productLineName?: string }) => {
        void input;
        return Promise.resolve({
          totalProducts: 100,
          productLines: [{ name: "Synthetic Game", count: 3 }],
          sets: [{ name: "Synthetic Set", count: 3 }],
          products: [related, variant, exact],
        });
      },
    );
    const service = new InventoryAdditionService({
      sellerKey: "synthetic-seller",
      client: {
        searchCatalogProducts,
        getCatalogProduct: () => Promise.resolve(product),
        searchMarketplaceProducts: () => Promise.resolve(searchResult([])),
      },
    });

    const result = await service.search("Synthetic Card", "Synthetic Game");

    expect(searchCatalogProducts.mock.calls.map(([input]) => input)).toEqual([
      {
        query: "Synthetic Card",
        productLineName: "Synthetic Game",
        productTypeName: "Cards",
        offset: 0,
        limit: 24,
        includeFoilMarketPrices: true,
      },
    ]);
    expect(result).toMatchObject({
      totalProducts: 100,
      productLines: [{ name: "Synthetic Game", count: 3 }],
      sets: [{ name: "Synthetic Set", count: 3 }],
      nextOffset: 24,
      hasMore: true,
      products: [
        { productId: 3, matchKind: "exact" },
        { productId: 2, matchKind: "variant" },
        { productId: 1, matchKind: "related" },
      ],
    });
    await expect(
      service.search("Synthetic Card", undefined, -1),
    ).rejects.toMatchObject({
      issues: ["Catalog search offset must be between 0 and 1000000."],
    });
  });

  it("loads a bare TCGplayer product number directly and caches the product", async () => {
    const searchCatalogProducts = vi.fn(() =>
      Promise.resolve({
        totalProducts: 0,
        productLines: [],
        sets: [],
        products: [],
      }),
    );
    const getCatalogProduct = vi.fn(
      ({ productId }: { readonly productId: number }) =>
        Promise.resolve({ ...product, productId }),
    );
    const service = new InventoryAdditionService({
      sellerKey: "synthetic-seller",
      client: {
        searchCatalogProducts,
        getCatalogProduct,
        searchMarketplaceProducts: () => Promise.resolve(searchResult([])),
      },
    });

    const first = await service.search("123");
    const cached = await service.search("123");

    expect(cached).toBe(first);
    expect(getCatalogProduct).toHaveBeenCalledOnce();
    expect(getCatalogProduct).toHaveBeenCalledWith({ productId: 123 });
    expect(searchCatalogProducts).not.toHaveBeenCalled();
    expect(first).toMatchObject({
      totalProducts: 1,
      productLines: [{ name: "Synthetic Game", count: 1 }],
      sets: [{ name: "Synthetic Set", count: 1 }],
      nextOffset: 1,
      hasMore: false,
      products: [
        {
          productId: 123,
          productName: "Synthetic Card",
          matchKind: "exact",
          matchRank: [0, 0],
        },
      ],
    });
    expect(first.products[0]).not.toHaveProperty("skus");
    await expect(service.search("0")).rejects.toMatchObject({
      issues: ["TCGplayer product number must be a positive integer."],
    });
  });

  it("normalizes punctuation and keeps exact products above variants", () => {
    const ranked = rankCatalogSearchProducts(
      [
        {
          ...product,
          productId: 2,
          productName: "Professor's Research [Professor Oak]",
        },
        { ...product, productId: 1, productName: "Professors Research" },
      ],
      "Professor's Research",
    );

    expect(
      ranked.map(({ productId, matchKind }) => ({ productId, matchKind })),
    ).toEqual([
      { productId: 1, matchKind: "exact" },
      { productId: 2, matchKind: "variant" },
    ]);
  });

  it("ranks typo and partial-name matches by likeness", () => {
    const ranked = rankCatalogSearchProducts(
      [
        { ...product, productId: 3, productName: "Bolt Hound" },
        { ...product, productId: 2, productName: "Light of Hope" },
        { ...product, productId: 1, productName: "Lightning Bolt" },
        { ...product, productId: 4, productName: "Bolt of Lightning" },
      ],
      "Lightnig Bolt",
    );

    expect(ranked.map((candidate) => candidate.productId)).toEqual([
      1, 4, 3, 2,
    ]);
    expect(ranked[0]).toMatchObject({
      matchKind: "related",
      matchRank: [4, 0.5, 1 / 14],
    });
    expect(
      rankCatalogSearchProducts(
        [{ ...product, productName: "Bolt of Lightning" }],
        "Lightning Bolt",
      )[0],
    ).toMatchObject({ matchKind: "variant", matchRank: [3, 1] });
  });

  it("stops after enough exact matches and briefly caches identical searches", async () => {
    let now = new Date("2026-08-04T12:00:00.000Z");
    const signal = new AbortController().signal;
    const exactProducts = Array.from({ length: 8 }, (_, index) => ({
      ...product,
      productId: index + 1,
      setName: `Synthetic Set ${String(index + 1)}`,
    }));
    const searchCatalogProducts = vi.fn(
      (
        _input: { offset?: number },
        options?: { readonly signal?: AbortSignal },
      ) => {
        expect(options?.signal).toBe(signal);
        return Promise.resolve({
          totalProducts: 100,
          productLines: [],
          sets: [],
          products: exactProducts,
        });
      },
    );
    const service = new InventoryAdditionService({
      sellerKey: "synthetic-seller",
      now: () => now,
      client: {
        searchCatalogProducts,
        getCatalogProduct: () => Promise.resolve(product),
        searchMarketplaceProducts: () => Promise.resolve(searchResult([])),
      },
    });

    const first = await service.search("Synthetic Card", undefined, 0, signal);
    const cached = await service.search("Synthetic Card", undefined, 0, signal);

    expect(first).toMatchObject({ nextOffset: 24, hasMore: true });
    expect(cached).toBe(first);
    expect(searchCatalogProducts).toHaveBeenCalledOnce();

    now = new Date("2026-08-04T12:01:00.001Z");
    await service.search("Synthetic Card", undefined, 0, signal);
    expect(searchCatalogProducts).toHaveBeenCalledTimes(2);
  });

  it("loads only one additional page after the initial search", async () => {
    const searchCatalogProducts = vi.fn((input: { offset?: number }) =>
      Promise.resolve({
        totalProducts: 200,
        productLines: [],
        sets: [],
        products: [
          {
            ...product,
            productId: input.offset ?? 8,
            productName: "Synthetic Box",
          },
        ],
      }),
    );
    const service = new InventoryAdditionService({
      sellerKey: "synthetic-seller",
      client: {
        searchCatalogProducts,
        getCatalogProduct: () => Promise.resolve(product),
        searchMarketplaceProducts: () => Promise.resolve(searchResult([])),
      },
    });

    const result = await service.search("Synthetic Card", undefined, 72);

    expect(searchCatalogProducts).toHaveBeenCalledOnce();
    expect(searchCatalogProducts.mock.calls[0]?.[0]).toMatchObject({
      offset: 72,
      limit: 24,
    });
    expect(result).toMatchObject({ nextOffset: 96, hasMore: true });
  });

  it("applies a set filter without scanning additional pages", async () => {
    const searchCatalogProducts = vi.fn((input: { setName?: string }) =>
      Promise.resolve({
        totalProducts: 1,
        productLines: [{ name: "Synthetic Game", count: 1 }],
        sets: [{ name: "Synthetic Set", count: 1 }],
        products: [
          {
            ...product,
            productId: 120,
            setName: input.setName ?? "Synthetic Set",
          },
        ],
      }),
    );
    const service = new InventoryAdditionService({
      sellerKey: "synthetic-seller",
      client: {
        searchCatalogProducts,
        getCatalogProduct: () => Promise.resolve(product),
        searchMarketplaceProducts: () => Promise.resolve(searchResult([])),
      },
    });

    const result = await service.search(
      "Synthetic Card",
      undefined,
      0,
      undefined,
      "Synthetic Set",
    );

    expect(searchCatalogProducts).toHaveBeenCalledOnce();
    expect(searchCatalogProducts.mock.calls[0]?.[0]).toMatchObject({
      productTypeName: "Cards",
      setName: "Synthetic Set",
      offset: 0,
    });
    expect(result).toMatchObject({ nextOffset: 1, hasMore: false });
    expect(result.products[0]).toMatchObject({
      productId: 120,
      matchKind: "exact",
    });
  });

  it("previews an exact SKU and prices it against a better condition", async () => {
    const searchMarketplaceProducts = vi.fn(
      (input: { sellerKey?: string; channelId?: number }) => {
        if (input.sellerKey === "synthetic-seller" && input.channelId === 0) {
          return Promise.resolve(
            searchResult([
              listing({
                productConditionId: 456,
                conditionId: 3,
                condition: "Moderately Played",
                sellerKey: "synthetic-seller",
                sellerName: "Synthetic Seller",
                quantity: 2,
                price: 3,
              }),
            ]),
          );
        }
        if (input.sellerKey === "synthetic-seller") {
          return Promise.resolve(searchResult([]));
        }
        return Promise.resolve(searchResult([listing()]));
      },
    );
    const service = new InventoryAdditionService({
      sellerKey: "synthetic-seller",
      id: () => "00000000-0000-4000-8000-000000000001",
      now: () => new Date("2026-08-04T12:00:00.000Z"),
      client: {
        searchCatalogProducts: () =>
          Promise.resolve({
            totalProducts: 1,
            productLines: [],
            sets: [],
            products: [product],
          }),
        getCatalogProduct: () => Promise.resolve(product),
        searchMarketplaceProducts,
      },
    });

    const preview = await service.preview({
      productId: 123,
      productConditionId: 456,
      addQuantity: 1,
      rules: additionPricingRules(),
    });

    expect(preview).toMatchObject({
      queueable: true,
      currentQuantity: 2,
      proposedPrice: 2,
      competitorCondition: "Lightly Played",
    });
    expect(service.takeAddition(preview.id)).toEqual(addition);
  });

  it("reuses the selected SKU snapshot when quantity and pricing inputs change", async () => {
    let now = new Date("2026-08-04T12:00:00.000Z");
    const getCatalogProduct = vi.fn(() => Promise.resolve(product));
    const searchMarketplaceProducts = vi.fn((input: { sellerKey?: string }) =>
      Promise.resolve(
        input.sellerKey === "synthetic-seller"
          ? searchResult([])
          : searchResult([listing()]),
      ),
    );
    const service = new InventoryAdditionService({
      sellerKey: "synthetic-seller",
      now: () => now,
      client: {
        searchCatalogProducts: () =>
          Promise.resolve({
            totalProducts: 1,
            productLines: [],
            sets: [],
            products: [product],
          }),
        getCatalogProduct,
        searchMarketplaceProducts,
      },
    });
    const rules = additionPricingRules();

    await service.getProduct(product.productId);
    const first = await service.preview({
      productId: product.productId,
      productConditionId: 456,
      addQuantity: 1,
      rules,
    });
    const recalculated = await service.preview({
      productId: product.productId,
      productConditionId: 456,
      addQuantity: 4,
      rules: { ...rules, adjustmentCents: 25 },
    });

    expect(first).toMatchObject({ addQuantity: 1, proposedPrice: 2 });
    expect(recalculated).toMatchObject({
      addQuantity: 4,
      proposedPrice: 1.75,
    });
    expect(getCatalogProduct).toHaveBeenCalledOnce();
    expect(searchMarketplaceProducts).toHaveBeenCalledTimes(3);

    await service.preview({
      productId: product.productId,
      productConditionId: 456,
      addQuantity: 4,
      rules: { ...rules, conditionPolicy: "same" },
    });
    await service.preview({
      productId: product.productId,
      productConditionId: 456,
      addQuantity: 5,
      rules: { ...rules, conditionPolicy: "same" },
    });
    expect(searchMarketplaceProducts).toHaveBeenCalledTimes(4);

    now = new Date("2026-08-04T12:15:00.001Z");
    await service.preview({
      productId: product.productId,
      productConditionId: 456,
      addQuantity: 5,
      rules: { ...rules, conditionPolicy: "same" },
    });
    expect(getCatalogProduct).toHaveBeenCalledTimes(2);
    expect(searchMarketplaceProducts).toHaveBeenCalledTimes(7);
  });

  it("uses the configured minimum with a market fallback", async () => {
    const service = new InventoryAdditionService({
      sellerKey: "synthetic-seller",
      client: {
        searchCatalogProducts: () =>
          Promise.resolve({
            totalProducts: 1,
            productLines: [],
            sets: [],
            products: [product],
          }),
        getCatalogProduct: () =>
          Promise.resolve({ ...product, marketPrice: 0.2 }),
        searchMarketplaceProducts: () => Promise.resolve(searchResult([])),
      },
    });

    const preview = await service.preview({
      productId: 123,
      productConditionId: 456,
      addQuantity: 2,
      rules: additionPricingRules({
        conditionPolicy: "same",
        ranges: [
          {
            minimumListings: 0,
            priceSource: "market",
            percentage: 100,
            gapThresholdPercent: 100,
            gapAction: "follow-lowest",
          },
        ],
      }),
    });

    expect(preview).toMatchObject({
      proposedPrice: 0.35,
      minimumApplied: true,
      queueable: true,
    });
  });

  it("uses the merchandise pricing profile's Magic rarity floor", async () => {
    const magicRare = {
      ...product,
      productLineName: "Magic: The Gathering",
      rarityName: "Rare",
      marketPrice: 0.2,
    };
    const service = new InventoryAdditionService({
      sellerKey: "synthetic-seller",
      client: {
        searchCatalogProducts: () =>
          Promise.resolve({
            totalProducts: 1,
            productLines: [],
            sets: [],
            products: [magicRare],
          }),
        getCatalogProduct: () => Promise.resolve(magicRare),
        searchMarketplaceProducts: () => Promise.resolve(searchResult([])),
      },
    });

    const preview = await service.preview({
      productId: 123,
      productConditionId: 456,
      addQuantity: 2,
      rules: additionPricingRules({
        conditionPolicy: "same",
        gamePricingModules: [
          {
            type: "magic-rarity-floor",
            enabled: true,
            floors: [{ rarity: "Rare", minimumPrice: 0.75 }],
          },
        ],
        ranges: [
          {
            minimumListings: 0,
            priceSource: "market",
            percentage: 100,
            gapThresholdPercent: 100,
            gapAction: "follow-lowest",
          },
        ],
      }),
    });

    expect(preview).toMatchObject({
      proposedPrice: 0.75,
      minimumApplied: true,
      queueable: true,
    });
    expect(preview.reason).toContain("Magic Rare minimum of $0.75");
  });

  it("raises seller shipping to the minimum without lowering a competitor's higher rate", async () => {
    const service = new InventoryAdditionService({
      sellerKey: "synthetic-seller",
      client: {
        searchCatalogProducts: () =>
          Promise.resolve({
            totalProducts: 1,
            productLines: [],
            sets: [],
            products: [product],
          }),
        getCatalogProduct: () => Promise.resolve(product),
        searchMarketplaceProducts: (input) =>
          Promise.resolve(
            input.sellerKey === "synthetic-seller"
              ? searchResult([])
              : searchResult([listing({ price: 2, shippingPrice: 1.99 })]),
          ),
      },
    });

    const preview = await service.preview({
      productId: 123,
      productConditionId: 456,
      addQuantity: 1,
      rules: additionPricingRules({
        priceBasis: "delivered",
        estimatedShippingPrice: 0.99,
      }),
    });

    expect(preview).toMatchObject({
      proposedPrice: 2.5,
      effectiveShippingPrice: 1.49,
      proposedDeliveredPrice: 3.99,
      competitorShipping: 1.99,
      queueable: true,
    });
    expect(preview.reason).not.toContain("shipping is normalized");
  });

  it("uses the pricing profile's gap rule when pricing a new listing", async () => {
    const service = new InventoryAdditionService({
      sellerKey: "synthetic-seller",
      client: {
        searchCatalogProducts: () =>
          Promise.resolve({
            totalProducts: 1,
            productLines: [],
            sets: [],
            products: [product],
          }),
        getCatalogProduct: () => Promise.resolve(product),
        searchMarketplaceProducts: (input) =>
          Promise.resolve(
            input.sellerKey === "synthetic-seller"
              ? searchResult([])
              : searchResult([
                  listing({ sellerKey: "seller-a", price: 1 }),
                  listing({ sellerKey: "seller-b", price: 2 }),
                ]),
          ),
      },
    });

    const preview = await service.preview({
      productId: 123,
      productConditionId: 456,
      addQuantity: 1,
      rules: additionPricingRules({
        ranges: [
          {
            minimumListings: 2,
            priceSource: "lowest",
            percentage: 100,
            gapThresholdPercent: 50,
            gapAction: "use-next",
            supportMode: "adjacent",
          },
        ],
      }),
    });

    expect(preview).toMatchObject({
      proposedPrice: 2,
      competitorPrice: 2,
      queueable: true,
    });
    expect(preview.reason).toContain("uses 100% of the next listing");
  });

  it("lists from the supported seller band when an inventory rule would wait", async () => {
    const service = new InventoryAdditionService({
      sellerKey: "synthetic-seller",
      client: {
        searchCatalogProducts: () =>
          Promise.resolve({
            totalProducts: 1,
            productLines: [],
            sets: [],
            products: [product],
          }),
        getCatalogProduct: () => Promise.resolve(product),
        searchMarketplaceProducts: (input) =>
          Promise.resolve(
            input.sellerKey === "synthetic-seller"
              ? searchResult([])
              : searchResult([
                  listing({ sellerKey: "isolated", price: 30 }),
                  listing({ sellerKey: "band-a", price: 32 }),
                  listing({ sellerKey: "band-b", price: 33 }),
                ]),
          ),
      },
    });

    const preview = await service.preview({
      productId: 123,
      productConditionId: 456,
      addQuantity: 1,
      rules: additionPricingRules({
        ranges: [
          {
            minimumListings: 3,
            priceSource: "lowest",
            percentage: 100,
            gapThresholdPercent: 3,
            gapAction: "skip",
            supportMode: "cluster",
            minimumSellerSupport: 2,
            supportWindowPercent: 5,
          },
        ],
      }),
    });

    expect(preview).toMatchObject({
      proposedPrice: 32,
      competitorPrice: 32,
      queueable: true,
      rules: { ranges: [{ gapAction: "skip" }] },
    });
    expect(preview.reason).toContain("supported by 2 sellers");
  });

  it("lists with the profile's conservative fallback when no seller band exists", async () => {
    const service = new InventoryAdditionService({
      sellerKey: "synthetic-seller",
      client: {
        searchCatalogProducts: () =>
          Promise.resolve({
            totalProducts: 1,
            productLines: [],
            sets: [],
            products: [product],
          }),
        getCatalogProduct: () => Promise.resolve(product),
        searchMarketplaceProducts: (input) =>
          Promise.resolve(
            input.sellerKey === "synthetic-seller"
              ? searchResult([])
              : searchResult([
                  listing({ sellerKey: "seller-a", price: 1 }),
                  listing({ sellerKey: "seller-b", price: 2 }),
                ]),
          ),
      },
    });

    const preview = await service.preview({
      productId: 123,
      productConditionId: 456,
      addQuantity: 1,
      rules: additionPricingRules({
        sparseMarketFallback: "higher-of-market-and-lowest",
        ranges: [
          {
            minimumListings: 2,
            priceSource: "lowest",
            percentage: 100,
            gapThresholdPercent: 3,
            gapAction: "use-next",
            supportMode: "cluster",
            minimumSellerSupport: 2,
            supportWindowPercent: 5,
          },
        ],
      }),
    });

    expect(preview).toMatchObject({
      proposedPrice: 3.5,
      queueable: true,
    });
    expect(preview.reason).toContain("higher of market and lowest fallback");
  });

  it("combines pending additions for the same SKU without losing quantity", async () => {
    const { path, queue } = await queueFixture();
    await queue.enqueue(addition);
    await queue.enqueue({ ...addition, addQuantity: 2, price: 2.25 });
    const reloaded = new InventoryAdditionQueueStore({
      stateFile: path,
      historyLimit: 25,
      lease: immediateSyncLease,
    });

    const snapshot = await reloaded.snapshot();

    expect(snapshot.counts).toMatchObject({ pending: 1, superseded: 1 });
    const pending = snapshot.jobs.find((job) => job.status === "pending");
    if (pending?.operation !== "add")
      throw new Error("Missing pending addition");
    expect(pending.addition).toMatchObject({
      addQuantity: 3,
      price: 2.25,
    });
  });

  it("queues an exact-SKU removal and supersedes a pending addition", async () => {
    const { path, queue } = await queueFixture();
    const pendingAddition = (await queue.enqueue(addition))[0];
    const queuedRemoval = await queue.enqueueRemoval(removal);
    const reloaded = new InventoryAdditionQueueStore({
      stateFile: path,
      historyLimit: 25,
      lease: immediateSyncLease,
    });

    const snapshot = await reloaded.snapshot();

    expect(pendingAddition).toBeDefined();
    expect(queuedRemoval).toMatchObject({
      operation: "remove",
      removal,
      status: "pending",
    });
    expect(snapshot.counts).toMatchObject({ pending: 1, superseded: 1 });
    expect(snapshot.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: pendingAddition?.id,
          operation: "add",
          status: "superseded",
        }),
        expect.objectContaining({
          id: queuedRemoval.id,
          operation: "remove",
          status: "pending",
        }),
      ]),
    );
  });

  it("resubmits a failed addition once without duplicating its quantity", async () => {
    const { queue } = await queueFixture();
    const original = (await queue.enqueue(addition))[0];
    if (original === undefined)
      throw new Error("The queue did not create a job.");
    await queue.claimNext();
    await queue.finish(original.id, "failed", "PROVIDER_ERROR");

    const resubmitted = await queue.resubmit(original.id);
    const snapshot = await queue.snapshot();

    expect(resubmitted).toMatchObject({
      addition,
      status: "pending",
      attempts: 0,
      resubmittedFromJobId: original.id,
    });
    expect(resubmitted.id).not.toBe(original.id);
    if (resubmitted.operation !== "add") {
      throw new Error("Expected an addition job");
    }
    expect(resubmitted.addition.addQuantity).toBe(addition.addQuantity);
    expect(snapshot.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: original.id, status: "failed" }),
        expect.objectContaining({
          id: resubmitted.id,
          status: "pending",
          resubmittedFromJobId: original.id,
        }),
      ]),
    );
    await expect(queue.resubmit(original.id)).rejects.toThrow(
      "already been resubmitted",
    );
    await expect(queue.resubmit(resubmitted.id)).rejects.toThrow(
      "Only a failed inventory-change job",
    );
  });

  it("stops an ambiguous inventory request for review", async () => {
    const { queue } = await queueFixture();
    await queue.enqueue(addition);
    const controller = new AbortController();
    const apply = vi.fn(() => {
      controller.abort();
      throw new TcgplayerApiError("AMBIGUOUS_RESULT", "Synthetic ambiguity.");
    });
    const executor: InventoryAdditionExecutor = { apply };
    const worker = new InventoryAdditionWorker({
      queue,
      executor,
      settings: () =>
        Promise.resolve({
          enabled: true,
          stateFile: "unused.json",
          delaySeconds: 0,
          rateLimitDelaySeconds: 300,
          historyLimit: 25,
        }),
      logger,
      idleDelayMs: 1,
    });

    await worker.run(controller.signal);

    expect(apply).toHaveBeenCalledOnce();
    expect((await queue.snapshot()).jobs[0]).toMatchObject({
      status: "review-required",
      attempts: 1,
      errorCode: "AMBIGUOUS_RESULT",
    });
  });

  it("keeps a claimed inventory change pending when authentication expires", async () => {
    const { queue } = await queueFixture();
    await queue.enqueue(addition);
    const controller = new AbortController();
    const worker = new InventoryAdditionWorker({
      queue,
      executor: {
        apply: vi.fn(() => {
          controller.abort();
          throw new TcgplayerApiError(
            "AUTHENTICATION_REQUIRED",
            "Synthetic expired session.",
          );
        }),
      },
      settings: () =>
        Promise.resolve({
          enabled: true,
          stateFile: "unused.json",
          delaySeconds: 0,
          rateLimitDelaySeconds: 300,
          historyLimit: 25,
        }),
      logger,
      idleDelayMs: 1,
    });

    await worker.run(controller.signal);

    expect((await queue.snapshot()).jobs[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      errorCode: "AUTHENTICATION_REQUIRED",
    });
  });

  it("refreshes live quantity before submitting the relative addition", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const stringBody = (body: BodyInit | null | undefined): string => {
      if (typeof body !== "string") throw new Error("Expected a string body.");
      return body;
    };
    const requestText = (input: URL | RequestInfo): string =>
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input;
    const fetchImplementation: typeof fetch = async (input, init) => {
      await Promise.resolve();
      requests.push({
        url: requestText(input),
        ...(init === undefined ? {} : { init }),
      });
      if (requestText(input).includes("mp-search-api")) {
        const body = JSON.parse(stringBody(init?.body)) as {
          listingSearch: { filters: { term: { channelId: number } } };
        };
        const listings =
          body.listingSearch.filters.term.channelId === 0
            ? [
                listing({
                  productConditionId: 456,
                  conditionId: 3,
                  condition: "Moderately Played",
                  sellerKey: "seller_test",
                  sellerName: "Synthetic Seller",
                  quantity: 2,
                  price: 3,
                }),
              ]
            : [];
        return new Response(
          JSON.stringify({
            errors: [],
            results: [
              {
                totalResults: listings.length === 0 ? 0 : 1,
                results: searchResult(listings).products,
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 204 });
    };
    vi.stubGlobal("fetch", fetchImplementation);
    const config = parseConfig(
      JSON.parse(
        await readFile("config/local.example.json", "utf8"),
      ) as unknown,
    );
    const executor = createTcgplayerInventoryAdditionExecutor(config, {
      TCGPLAYER_AUTH_COOKIE: "synthetic-cookie",
      TCGPLAYER_SELLER_KEY: "seller_test",
    });

    try {
      await executor.apply(addition, "add");
    } finally {
      vi.unstubAllGlobals();
    }

    expect(requests).toHaveLength(3);
    const form = new URLSearchParams(stringBody(requests[2]?.init?.body));
    expect(form.get("productQuantityPrices[0][AddToQuantity]")).toBe("1");
    expect(
      form.get(
        "productQuantityPrices[0][ConditionQuantityPrices][0][Quantity]",
      ),
    ).toBe("3");
    expect(
      form.get("productQuantityPrices[0][ConditionQuantityPrices][0][Price]"),
    ).toBe("2.00");
  });

  it("refreshes live quantity before submitting an exact removal", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const requestText = (input: URL | RequestInfo): string =>
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input;
    const fetchImplementation: typeof fetch = async (input, init) => {
      await Promise.resolve();
      const url = requestText(input);
      requests.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.includes("mp-search-api")) {
        if (typeof init?.body !== "string") {
          throw new Error("Expected a string marketplace-search body.");
        }
        const body = JSON.parse(init.body) as {
          listingSearch: { filters: { term: { channelId: number } } };
        };
        const listings =
          body.listingSearch.filters.term.channelId === 0
            ? [
                listing({
                  productConditionId: 456,
                  conditionId: 3,
                  condition: "Moderately Played",
                  sellerKey: "seller_test",
                  sellerName: "Synthetic Seller",
                  quantity: 2,
                  price: 2,
                }),
              ]
            : [];
        return new Response(
          JSON.stringify({
            errors: [],
            results: [
              {
                totalResults: listings.length === 0 ? 0 : 1,
                results: searchResult(listings).products,
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 204 });
    };
    vi.stubGlobal("fetch", fetchImplementation);
    const config = parseConfig(
      JSON.parse(
        await readFile("config/local.example.json", "utf8"),
      ) as unknown,
    );
    const executor = createTcgplayerInventoryAdditionExecutor(config, {
      TCGPLAYER_AUTH_COOKIE: "synthetic-cookie",
      TCGPLAYER_SELLER_KEY: "seller_test",
    });

    try {
      await executor.apply(removal, "remove");
    } finally {
      vi.unstubAllGlobals();
    }

    expect(requests).toHaveLength(3);
    const mutationBody = requests[2]?.init?.body;
    if (typeof mutationBody !== "string") {
      throw new Error("Expected a string inventory-removal body.");
    }
    const form = new URLSearchParams(mutationBody);
    expect(form.get("productQuantityPrices[0][AddToQuantity]")).toBe("0");
    expect(
      form.get(
        "productQuantityPrices[0][ConditionQuantityPrices][0][Quantity]",
      ),
    ).toBe("0");
    expect(
      form.get("productQuantityPrices[0][ConditionQuantityPrices][0][Price]"),
    ).toBe("2.00");
  });

  it("does not submit when live quantity changed after preview", async () => {
    const requests: string[] = [];
    const requestText = (input: URL | RequestInfo): string =>
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input;
    const fetchImplementation: typeof fetch = async (input, init) => {
      await Promise.resolve();
      const url = requestText(input);
      requests.push(url);
      if (!url.includes("mp-search-api")) {
        throw new Error("The mutation endpoint must not be called.");
      }
      if (typeof init?.body !== "string") {
        throw new Error("Expected a string marketplace-search body.");
      }
      const body = JSON.parse(init.body) as {
        listingSearch: { filters: { term: { channelId: number } } };
      };
      const listings =
        body.listingSearch.filters.term.channelId === 0
          ? [
              listing({
                productConditionId: 456,
                conditionId: 3,
                condition: "Moderately Played",
                sellerKey: "seller_test",
                sellerName: "Synthetic Seller",
                quantity: 3,
                price: 3,
              }),
            ]
          : [];
      return new Response(
        JSON.stringify({
          errors: [],
          results: [
            {
              totalResults: listings.length === 0 ? 0 : 1,
              results: searchResult(listings).products,
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    };
    vi.stubGlobal("fetch", fetchImplementation);
    const config = parseConfig(
      JSON.parse(
        await readFile("config/local.example.json", "utf8"),
      ) as unknown,
    );
    const executor = createTcgplayerInventoryAdditionExecutor(config, {
      TCGPLAYER_AUTH_COOKIE: "synthetic-cookie",
      TCGPLAYER_SELLER_KEY: "seller_test",
    });

    try {
      await expect(executor.apply(addition, "add")).rejects.toMatchObject({
        code: "REVIEW_REQUIRED",
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(requests).toHaveLength(2);
  });
});
