import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  TcgplayerApiError,
  type CatalogProductDetails,
  type MarketplaceListing,
  type SellerInventoryAddition,
} from "tcgplayer-private-api";
import {
  createTcgplayerInventoryAdditionExecutor,
  immediateSyncLease,
  InventoryAdditionQueueStore,
  InventoryAdditionService,
  InventoryAdditionWorker,
  parseConfig,
  type InventoryAdditionExecutor,
  type Logger,
} from "../src/index.js";

const product: CatalogProductDetails = {
  productId: 123,
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
          Promise.resolve({ totalProducts: 1, products: [product] }),
        getCatalogProduct: () => Promise.resolve(product),
        searchMarketplaceProducts,
      },
    });

    const preview = await service.preview({
      productId: 123,
      productConditionId: 456,
      addQuantity: 1,
      rules: {
        minimumPrice: 0.35,
        conditionPolicy: "same-or-better",
        priceBasis: "item",
        adjustmentCents: 0,
        estimatedShippingPrice: 0,
        noComparisonFallback: "market",
      },
    });

    expect(preview).toMatchObject({
      queueable: true,
      currentQuantity: 2,
      proposedPrice: 2,
      competitorCondition: "Lightly Played",
    });
    expect(service.takeAddition(preview.id)).toEqual(addition);
  });

  it("uses the configured minimum with a market fallback", async () => {
    const service = new InventoryAdditionService({
      sellerKey: "synthetic-seller",
      client: {
        searchCatalogProducts: () =>
          Promise.resolve({ totalProducts: 1, products: [product] }),
        getCatalogProduct: () =>
          Promise.resolve({ ...product, marketPrice: 0.2 }),
        searchMarketplaceProducts: () => Promise.resolve(searchResult([])),
      },
    });

    const preview = await service.preview({
      productId: 123,
      productConditionId: 456,
      addQuantity: 2,
      rules: {
        minimumPrice: 0.35,
        conditionPolicy: "same",
        priceBasis: "item",
        adjustmentCents: 0,
        estimatedShippingPrice: 0,
        noComparisonFallback: "market",
      },
    });

    expect(preview).toMatchObject({
      proposedPrice: 0.35,
      minimumApplied: true,
      queueable: true,
    });
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
    expect(
      snapshot.jobs.find((job) => job.status === "pending")?.addition,
    ).toMatchObject({
      addQuantity: 3,
      price: 2.25,
    });
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
      await executor.apply(addition);
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
    ).toBe("2");
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
      await expect(executor.apply(addition)).rejects.toMatchObject({
        code: "REVIEW_REQUIRED",
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(requests).toHaveLength(2);
  });
});
