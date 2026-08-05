import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  TcgplayerApiError,
  type SellerPriceUpdate,
} from "tcgplayer-private-api";
import {
  immediateSyncLease,
  createTcgplayerPriceUpdateExecutor,
  parseConfig,
  PriceUpdateQueueStore,
  PriceUpdateWorker,
  type Logger,
  type PriceUpdateExecutor,
} from "../src/index.js";

const syntheticUpdate: SellerPriceUpdate = {
  productId: 123,
  productName: "Synthetic Card",
  productConditionId: 456,
  conditionId: 1,
  channelId: 0,
  categoryName: "Synthetic Game",
  quantity: 7,
  price: 12.34,
  storePriceCustomId: null,
  reserveQuantity: 2,
};

const logger: Logger = {
  info: vi.fn(),
  error: vi.fn(),
};

async function queueFixture(now = new Date("2026-08-03T12:00:00.000Z")) {
  const directory = await mkdtemp(join(tmpdir(), "tcgplayer-price-queue-"));
  return {
    path: join(directory, "queue.json"),
    queue: new PriceUpdateQueueStore({
      stateFile: join(directory, "queue.json"),
      historyLimit: 25,
      now: () => now,
      lease: immediateSyncLease,
    }),
  };
}

function settings() {
  return Promise.resolve({
    enabled: true,
    stateFile: "unused.json",
    delaySeconds: 1,
    rateLimitDelaySeconds: 300,
    historyLimit: 25,
  });
}

describe("price-update queue", () => {
  it("persists jobs and supersedes an older pending price for the same listing", async () => {
    const fixture = await queueFixture();
    const [first] = await fixture.queue.enqueue(syntheticUpdate);
    const [second] = await fixture.queue.enqueue({
      ...syntheticUpdate,
      price: 13.25,
    });
    const reloaded = new PriceUpdateQueueStore({
      stateFile: fixture.path,
      historyLimit: 25,
      lease: immediateSyncLease,
    });

    const snapshot = await reloaded.snapshot();

    expect(snapshot.counts).toMatchObject({ pending: 1, superseded: 1 });
    expect(snapshot.jobs.find((job) => job.id === first?.id)?.status).toBe(
      "superseded",
    );
    expect(
      snapshot.jobs.find((job) => job.id === second?.id)?.update.price,
    ).toBe(13.25);
  });

  it("rejects malformed updates before writing a job", async () => {
    const { queue } = await queueFixture();

    expect(() => queue.enqueue({ ...syntheticUpdate, price: 12.345 })).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
    );
    expect((await queue.snapshot()).jobs).toHaveLength(0);
  });

  it("processes one claimed update and records the accepted result", async () => {
    const { queue } = await queueFixture();
    await queue.enqueue(syntheticUpdate);
    const controller = new AbortController();
    const apply = vi.fn(() => {
      controller.abort();
      return Promise.resolve();
    });
    const executor: PriceUpdateExecutor = { apply };
    const worker = new PriceUpdateWorker({
      queue,
      executor,
      settings,
      logger,
      idleDelayMs: 1,
    });

    await worker.run(controller.signal);

    expect(apply).toHaveBeenCalledOnce();
    expect((await queue.snapshot()).jobs[0]).toMatchObject({
      status: "applied",
      attempts: 1,
    });
  });

  it("starts the next job immediately after the previous request finishes", async () => {
    const { queue } = await queueFixture();
    await queue.enqueue({
      updates: [
        syntheticUpdate,
        {
          ...syntheticUpdate,
          productConditionId: 789,
          price: 13.25,
        },
      ],
    });
    const controller = new AbortController();
    let inFlight = 0;
    let maximumInFlight = 0;
    const applied: number[] = [];
    const executor: PriceUpdateExecutor = {
      apply: async (update) => {
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        applied.push(update.productConditionId);
        await Promise.resolve();
        inFlight -= 1;
        if (applied.length === 2) controller.abort();
      },
    };
    const worker = new PriceUpdateWorker({
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

    expect(applied).toEqual([456, 789]);
    expect(maximumInFlight).toBe(1);
    expect((await queue.snapshot()).counts.applied).toBe(2);
  });

  it("stops an ambiguous update for review without retrying it", async () => {
    const { queue } = await queueFixture();
    await queue.enqueue(syntheticUpdate);
    const controller = new AbortController();
    const apply = vi.fn(() => {
      controller.abort();
      throw new TcgplayerApiError("AMBIGUOUS_RESULT", "Synthetic ambiguity.");
    });
    const executor: PriceUpdateExecutor = { apply };
    const worker = new PriceUpdateWorker({
      queue,
      executor,
      settings,
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

  it("delays a definitively rejected rate-limited request", async () => {
    const { queue } = await queueFixture();
    await queue.enqueue(syntheticUpdate);
    const controller = new AbortController();
    const executor: PriceUpdateExecutor = {
      apply: vi.fn(() => {
        controller.abort();
        throw new TcgplayerApiError("RATE_LIMITED", "Synthetic rate limit.");
      }),
    };
    const worker = new PriceUpdateWorker({
      queue,
      executor,
      settings,
      logger,
      idleDelayMs: 1,
    });

    await worker.run(controller.signal);

    expect((await queue.snapshot()).jobs[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      errorCode: "RATE_LIMITED",
      nextAttemptAt: "2026-08-03T12:05:00.000Z",
    });
  });

  it("marks a job left applying by an interrupted process for review", async () => {
    const { queue } = await queueFixture();
    await queue.enqueue(syntheticUpdate);
    await queue.claimNext();

    expect(await queue.recoverInterrupted()).toBe(1);
    expect((await queue.snapshot()).jobs[0]).toMatchObject({
      status: "review-required",
      errorCode: "INTERRUPTED_DURING_MUTATION",
    });
  });

  it("refreshes live quantity and waits until the submitted price is visible", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    let updateSubmitted = false;
    let confirmationSearches = 0;
    const requestText = (input: URL | RequestInfo): string =>
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input;
    const bodyText = (body: BodyInit | null | undefined): string => {
      if (typeof body !== "string") throw new Error("Expected a string body");
      return body;
    };
    const fetchImplementation: typeof fetch = async (input, init) => {
      await Promise.resolve();
      requests.push({
        url: requestText(input),
        ...(init === undefined ? {} : { init }),
      });
      if (requestText(input).includes("mp-search-api")) {
        const body = JSON.parse(bodyText(init?.body)) as {
          listingSearch: { filters: { term: { channelId: number } } };
        };
        const isPrimaryChannel =
          body.listingSearch.filters.term.channelId === 0;
        if (isPrimaryChannel && updateSubmitted) confirmationSearches += 1;
        const listings = isPrimaryChannel
          ? [
              {
                listingId: 11,
                productId: 123,
                productConditionId: 456,
                conditionId: 1,
                condition: "Near Mint",
                channelId: 0,
                printing: "Normal",
                language: "English",
                languageId: 1,
                sellerKey: "seller_test",
                sellerName: "Synthetic Seller",
                quantity: 3,
                price:
                  updateSubmitted && confirmationSearches >= 2 ? 12.34 : 10,
                shippingPrice: 0.99,
                customData: {},
              },
            ]
          : [];
        return new Response(
          JSON.stringify({
            errors: [],
            results: [
              {
                totalResults: listings.length === 0 ? 0 : 1,
                results:
                  listings.length === 0
                    ? []
                    : [
                        {
                          productId: 123,
                          productName: "Synthetic Card",
                          productLineName: "Synthetic Game",
                          setName: "Synthetic Set",
                          rarityName: "Rare",
                          marketPrice: 11,
                          totalListings: 5,
                          listings,
                        },
                      ],
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      updateSubmitted = true;
      return new Response(null, { status: 204 });
    };
    vi.stubGlobal("fetch", fetchImplementation);
    const config = parseConfig(
      JSON.parse(
        await readFile("config/local.example.json", "utf8"),
      ) as unknown,
    );
    const executor = createTcgplayerPriceUpdateExecutor(
      config,
      {
        TCGPLAYER_AUTH_COOKIE: "synthetic-cookie",
        TCGPLAYER_SELLER_KEY: "seller_test",
      },
      { confirmationDelaysMs: [0, 0] },
    );

    try {
      await executor.apply(syntheticUpdate);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(requests).toHaveLength(5);
    expect(requests[2]?.url).toBe(
      "https://store.tcgplayer.com/admin/pricing/updateinventory",
    );
    const form = new URLSearchParams(bodyText(requests[2]?.init?.body));
    expect(form.get("type")).toBe("Pricing");
    expect(form.get("isStaged")).toBe("false");
    expect(
      form.get(
        "productQuantityPrices[0][ConditionQuantityPrices][0][Quantity]",
      ),
    ).toBe("3");
    expect(
      form.get("productQuantityPrices[0][ConditionQuantityPrices][0][Price]"),
    ).toBe("12.34");
    expect(confirmationSearches).toBe(2);
  });
});
