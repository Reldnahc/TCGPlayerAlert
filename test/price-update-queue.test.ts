import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  TcgplayerApiError,
  type SellerPriceUpdate,
} from "tcgplayer-private-api";
import {
  immediateSyncLease,
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
});
