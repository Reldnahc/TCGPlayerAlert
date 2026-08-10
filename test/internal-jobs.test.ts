import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ApplicationError,
  immediateSyncLease,
  EMPTY_INTERNAL_RUN_REPORT,
  InternalJobExecutor,
  InternalJobRunner,
  InternalJobStore,
  InventoryAdditionQueueStore,
  loadConfig,
  nextScheduleOccurrence,
  PriceUpdateQueueStore,
  scheduleWallClockSlot,
  type InternalRun,
  type InventoryAdditionService,
  type RepricingPreview,
  type RepricingPreviewRow,
  type RepricingService,
} from "../src/index.js";

const IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
];

async function fixture(initial = "2026-08-10T12:00:00.000Z") {
  const directory = await mkdtemp(join(tmpdir(), "internal-jobs-"));
  let now = new Date(initial);
  const ids = [...IDS];
  const store = new InternalJobStore({
    stateFile: join(directory, "jobs.json"),
    now: () => now,
    id: () => ids.shift() ?? "00000000-0000-4000-8000-000000000099",
    lease: immediateSyncLease,
  });
  return {
    store,
    setNow: (value: string) => {
      now = new Date(value);
    },
  };
}

describe("internal job schedules", () => {
  it("groups exact scheduled listings by time and merchandise profile", async () => {
    const { store } = await fixture();
    const first = await store.addScheduledListing({
      runAt: "2026-08-11T15:00:00.000Z",
      merchandiseProfileId: "default-merchandise",
      item: {
        productId: 10,
        productConditionId: 20,
        productName: "Synthetic Card",
        quantity: 1,
      },
    });
    const second = await store.addScheduledListing({
      runAt: "2026-08-11T15:00:00.000Z",
      merchandiseProfileId: "default-merchandise",
      item: {
        productId: 10,
        productConditionId: 20,
        productName: "Synthetic Card",
        quantity: 3,
      },
    });

    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({
      name: "List 4 cards",
      nextRunAt: "2026-08-11T15:00:00.000Z",
      payload: {
        type: "list-inventory",
        merchandiseProfileId: "default-merchandise",
        items: [{ productConditionId: 20, quantity: 4 }],
      },
    });
    expect((await store.snapshot()).schedules).toHaveLength(1);
  });

  it("rejects a listing release that is no longer in the future", async () => {
    const { store } = await fixture();

    await expect(
      store.addScheduledListing({
        runAt: "2026-08-10T11:59:59.000Z",
        merchandiseProfileId: "default-merchandise",
        item: {
          productId: 10,
          productConditionId: 20,
          productName: "Synthetic Card",
          quantity: 1,
        },
      }),
    ).rejects.toMatchObject({
      issues: [expect.stringContaining("must be in the future")],
    });
  });

  it("coalesces missed recurring slots and runs only one job at a time", async () => {
    const { store, setNow } = await fixture();
    const schedule = await store.createSchedule({
      name: "Hourly review",
      enabled: true,
      timing: {
        kind: "interval",
        everyMinutes: 60,
        anchorAt: "2026-08-10T12:00:00.000Z",
      },
      payload: {
        type: "reprice-inventory",
        pricingProfileId: "conservative",
        mode: "review",
        scope: "all",
        limits: {
          maximumUpdates: 200,
          maximumDecreasePercent: 20,
          maximumDecreaseAmount: 20,
          maximumIncreasePercent: 100,
          maximumBlockedPercent: 20,
        },
      },
    });
    expect(schedule.nextRunAt).toBe("2026-08-10T13:00:00.000Z");

    setNow("2026-08-10T14:30:00.000Z");
    const run = await store.claimNext();
    expect(run).toMatchObject({
      status: "running",
      scheduledFor: "2026-08-10T13:00:00.000Z",
      attempts: 1,
    });
    await expect(store.claimNext()).resolves.toBeUndefined();
    await store.finishRun(run?.id ?? "", "succeeded", {
      proposed: 0,
      queuedPriceJobs: 0,
      queuedInventoryJobs: 0,
      unchanged: 0,
      skipped: 0,
      reviewRequired: 0,
      truncatedItems: 0,
      items: [],
    });
    expect((await store.snapshot()).schedules[0]?.nextRunAt).toBe(
      "2026-08-10T15:00:00.000Z",
    );
  });

  it("recovers an interrupted calculation as the same queued run", async () => {
    const { store, setNow } = await fixture("2026-08-10T10:00:00.000Z");
    const schedule = await store.addScheduledListing({
      runAt: "2026-08-10T11:00:00.000Z",
      merchandiseProfileId: "default-merchandise",
      item: {
        productId: 10,
        productConditionId: 20,
        productName: "Synthetic Card",
        quantity: 1,
      },
    });
    setNow("2026-08-10T12:00:00.000Z");
    const claimed = await store.claimNext();
    expect(claimed?.scheduleId).toBe(schedule.id);

    await expect(store.recoverInterrupted()).resolves.toBe(1);
    const recovered = await store.claimNext();
    expect(recovered).toMatchObject({ id: claimed?.id, attempts: 2 });
  });

  it("moves a nonexistent daylight-saving time to the first valid minute", () => {
    const timing = {
      kind: "daily" as const,
      timeOfDay: "02:30",
      timeZone: "America/Chicago",
    };
    expect(
      nextScheduleOccurrence(timing, new Date("2026-03-08T07:59:00.000Z")),
    ).toBe("2026-03-08T08:00:00.000Z");
    expect(
      nextScheduleOccurrence(timing, new Date("2026-03-07T09:00:00.000Z")),
    ).toBe("2026-03-08T08:00:00.000Z");
  });

  it("does not run both copies of a repeated daylight-saving slot", () => {
    const timing = {
      kind: "daily" as const,
      timeOfDay: "01:30",
      timeZone: "America/Chicago",
    };
    const first = nextScheduleOccurrence(
      timing,
      new Date("2026-11-01T06:00:00.000Z"),
    );
    expect(first).toBe("2026-11-01T06:30:00.000Z");
    const slot = scheduleWallClockSlot(timing, first ?? "");
    expect(nextScheduleOccurrence(timing, new Date(first ?? ""), slot)).toBe(
      "2026-11-02T07:30:00.000Z",
    );
  });
});

describe("internal job execution", () => {
  it("claims and completes due work through the single service runner", async () => {
    const { store, setNow } = await fixture("2026-08-10T10:00:00.000Z");
    await store.addScheduledListing({
      runAt: "2026-08-10T11:00:00.000Z",
      merchandiseProfileId: "default-merchandise",
      item: {
        productId: 10,
        productConditionId: 20,
        productName: "Synthetic Card",
        quantity: 1,
      },
    });
    setNow("2026-08-10T12:00:00.000Z");
    const controller = new AbortController();
    const execute = vi.fn(() => {
      controller.abort();
      return Promise.resolve({
        status: "succeeded" as const,
        report: EMPTY_INTERNAL_RUN_REPORT,
      });
    });
    const runner = new InternalJobRunner({
      store,
      executor: { execute } as unknown as InternalJobExecutor,
      logger: { info: vi.fn(), error: vi.fn() },
      workerLease: immediateSyncLease,
      idleDelayMs: 1,
    });

    await runner.run(controller.signal);

    expect(execute).toHaveBeenCalledOnce();
    expect((await store.snapshot()).runs[0]?.status).toBe("succeeded");
  });

  it("returns a retryable read failure to the same run with bounded jitter", async () => {
    const { store, setNow } = await fixture("2026-08-10T10:00:00.000Z");
    await store.addScheduledListing({
      runAt: "2026-08-10T11:00:00.000Z",
      merchandiseProfileId: "default-merchandise",
      item: {
        productId: 10,
        productConditionId: 20,
        productName: "Synthetic Card",
        quantity: 1,
      },
    });
    setNow("2026-08-10T12:00:00.000Z");
    const controller = new AbortController();
    const execute = vi.fn(() =>
      Promise.reject(
        new ApplicationError("PROVIDER_ERROR", "Synthetic retry.", {
          retryable: true,
        }),
      ),
    );
    const runner = new InternalJobRunner({
      store,
      executor: { execute } as unknown as InternalJobExecutor,
      logger: {
        info: vi.fn(),
        error: vi.fn((event: string) => {
          if (event === "internal-jobs.retrying") controller.abort();
        }),
      },
      workerLease: immediateSyncLease,
      idleDelayMs: 1,
      random: () => 0.5,
    });

    await runner.run(controller.signal);

    expect((await store.snapshot()).runs[0]).toMatchObject({
      status: "queued",
      attempts: 1,
      nextAttemptAt: "2026-08-10T12:00:15.000Z",
      errorCode: "PROVIDER_ERROR",
    });
  });

  it("retains every ready proposal in review mode without applying automatic limits", async () => {
    const current = await executionFixture([
      repricingRow({ currentPrice: 40, proposedPrice: 3 }),
    ]);
    const run = repricingRun("review");

    const result = await current.executor.execute(run);

    expect(result).toMatchObject({
      status: "succeeded",
      report: {
        proposed: 1,
        queuedPriceJobs: 0,
        reviewRequired: 0,
        items: [{ outcome: "proposed" }],
      },
    });
    expect(current.takeUpdates).not.toHaveBeenCalled();
    expect((await current.priceQueue.snapshot()).jobs).toHaveLength(0);
  });

  it("requires review instead of dispatching a dangerous automatic decrease", async () => {
    const current = await executionFixture([
      repricingRow({ currentPrice: 40, proposedPrice: 3 }),
    ]);

    const result = await current.executor.execute(repricingRun("automatic"));

    expect(result).toMatchObject({
      status: "review-required",
      report: {
        queuedPriceJobs: 0,
        reviewRequired: 1,
        items: [
          {
            outcome: "review-required",
          },
        ],
      },
    });
    expect(result.report.items[0]?.reason).toContain("safety limit");
    expect((await current.priceQueue.snapshot()).jobs).toHaveLength(0);
  });

  it("dispatches a safe automatic proposal with its stable source run id", async () => {
    const current = await executionFixture([
      repricingRow({ currentPrice: 5, proposedPrice: 4.75 }),
    ]);
    const run = repricingRun("automatic");

    const result = await current.executor.execute(run);
    const jobs = await current.priceQueue.jobsForSourceRun(run.id);

    expect(result).toMatchObject({
      status: "succeeded",
      report: { queuedPriceJobs: 1, reviewRequired: 0 },
    });
    expect(current.takeUpdates).toHaveBeenCalledOnce();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.sourceRunId).toBe(run.id);
  });

  it("recovers an already-dispatched automatic batch without pricing twice", async () => {
    const current = await executionFixture([
      repricingRow({ currentPrice: 5, proposedPrice: 4.75 }),
    ]);
    const run = repricingRun("automatic");
    await current.priceQueue.enqueue(
      {
        updates: [sellerPriceUpdate(4.75)],
      },
      { sourceRunId: run.id },
    );

    const result = await current.executor.execute(run);

    expect(result).toMatchObject({
      status: "succeeded",
      report: { queuedPriceJobs: 1 },
    });
    expect(current.preview).not.toHaveBeenCalled();
    expect((await current.priceQueue.snapshot()).jobs).toHaveLength(1);
  });

  it("prices scheduled exact SKUs freshly and hands the complete batch off once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "internal-listing-run-"));
    const priceQueue = new PriceUpdateQueueStore({
      stateFile: join(directory, "prices.json"),
      historyLimit: 100,
      lease: immediateSyncLease,
    });
    const inventoryQueue = new InventoryAdditionQueueStore({
      stateFile: join(directory, "inventory.json"),
      historyLimit: 100,
      lease: immediateSyncLease,
    });
    const preview = vi.fn<
      (
        value: unknown,
        options?: unknown,
      ) => Promise<{
        id: string;
        queueable: boolean;
        proposedPrice: number;
      }>
    >(() =>
      Promise.resolve({
        id: "preview-1",
        queueable: true,
        proposedPrice: 2.5,
      }),
    );
    const takeAddition = vi.fn(() => ({
      productId: 10,
      productName: "Synthetic Card",
      productConditionId: 20,
      conditionId: 1,
      channelId: 0,
      categoryName: "Magic: The Gathering",
      currentQuantity: 0,
      addQuantity: 2,
      price: 2.5,
      storePriceCustomId: null,
      reserveQuantity: 0,
    }));
    const executor = new InternalJobExecutor({
      repricingService: {} as RepricingService,
      inventoryService: {
        preview,
        takeAddition,
      } as unknown as InventoryAdditionService,
      priceQueue,
      inventoryQueue,
      loadConfig: () => loadConfig("config/local.example.json"),
    });
    const run = listingRun();

    const result = await executor.execute(run);
    const recovered = await executor.execute(run);
    const jobs = await inventoryQueue.jobsForSourceRun(run.id);

    expect(result).toMatchObject({
      status: "succeeded",
      report: { queuedInventoryJobs: 1 },
    });
    expect(recovered.report.queuedInventoryJobs).toBe(1);
    expect(preview).toHaveBeenCalledOnce();
    expect(preview.mock.calls[0]?.[0]).toMatchObject({
      productId: 10,
      productConditionId: 20,
      addQuantity: 2,
      rules: { estimatedShippingPrice: 0 },
    });
    expect(preview.mock.calls[0]?.[1]).toEqual({ forceRefresh: true });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.sourceRunId).toBe(run.id);
  });
});

async function executionFixture(rows: readonly RepricingPreviewRow[]) {
  const directory = await mkdtemp(join(tmpdir(), "internal-repricing-run-"));
  const config = await loadConfig("config/local.example.json");
  const rules = config.repricingProfiles[0];
  if (rules === undefined)
    throw new Error("The fixture pricing profile is missing.");
  const repricingPreview: RepricingPreview = {
    id: "preview-1",
    createdAt: "2026-08-10T12:00:00.000Z",
    expiresAt: "2026-08-10T12:10:00.000Z",
    rules,
    rows,
    counts: {
      ready: rows.filter((row) => row.status === "ready").length,
      unchanged: 0,
      skipped: 0,
    },
    totals: {
      listingCount: rows.length,
      totalQuantity: rows.length,
      currentListingValue: rows.reduce(
        (total, row) => total + row.currentPrice * row.quantity,
        0,
      ),
    },
    marketplaceSnapshot: {
      capturedAt: "2026-08-10T12:00:00.000Z",
      expiresAt: "2026-08-10T12:10:00.000Z",
      source: "fresh",
    },
  };
  const preview = vi.fn(() => Promise.resolve(repricingPreview));
  const takeUpdates = vi.fn(() => [
    sellerPriceUpdate(rows[0]?.proposedPrice ?? 1),
  ]);
  const priceQueue = new PriceUpdateQueueStore({
    stateFile: join(directory, "prices.json"),
    historyLimit: 100,
    lease: immediateSyncLease,
  });
  const inventoryQueue = new InventoryAdditionQueueStore({
    stateFile: join(directory, "inventory.json"),
    historyLimit: 100,
    lease: immediateSyncLease,
  });
  return {
    executor: new InternalJobExecutor({
      repricingService: { preview, takeUpdates } as unknown as RepricingService,
      inventoryService: {} as InventoryAdditionService,
      priceQueue,
      inventoryQueue,
      loadConfig: () => Promise.resolve(config),
    }),
    preview,
    takeUpdates,
    priceQueue,
  };
}

function repricingRow(
  prices: Pick<RepricingPreviewRow, "currentPrice" | "proposedPrice">,
): RepricingPreviewRow {
  return {
    id: "row-1",
    productId: 10,
    productConditionId: 20,
    productName: "Synthetic Card",
    productLineName: "Magic: The Gathering",
    setName: "Synthetic Set",
    condition: "Near Mint",
    printing: "Normal",
    language: "English",
    quantity: 1,
    currentShipping: 1.49,
    minimumApplied: false,
    status: "ready",
    reason: "Synthetic proposal.",
    queueable: true,
    ...prices,
  };
}

function sellerPriceUpdate(price: number) {
  return {
    productId: 10,
    productName: "Synthetic Card",
    productConditionId: 20,
    conditionId: 1,
    channelId: 0,
    categoryName: "Magic: The Gathering",
    quantity: 1,
    price,
    storePriceCustomId: null,
    reserveQuantity: 0,
  };
}

function repricingRun(mode: "review" | "automatic"): InternalRun {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    scheduleId: "00000000-0000-4000-8000-000000000011",
    scheduleName: "Synthetic repricing",
    payload: {
      type: "reprice-inventory",
      pricingProfileId: "match-lowest",
      mode,
      scope: "all",
      limits: {
        maximumUpdates: 200,
        maximumDecreasePercent: 20,
        maximumDecreaseAmount: 20,
        maximumIncreasePercent: 100,
        maximumBlockedPercent: 20,
      },
    },
    trigger: "scheduled",
    status: "running",
    scheduledFor: "2026-08-10T12:00:00.000Z",
    createdAt: "2026-08-10T12:00:00.000Z",
    updatedAt: "2026-08-10T12:00:00.000Z",
    attempts: 1,
  };
}

function listingRun(): InternalRun {
  return {
    id: "00000000-0000-4000-8000-000000000020",
    scheduleId: "00000000-0000-4000-8000-000000000021",
    scheduleName: "Synthetic listing",
    payload: {
      type: "list-inventory",
      merchandiseProfileId: "english-singles",
      items: [
        {
          productId: 10,
          productConditionId: 20,
          productName: "Synthetic Card",
          quantity: 2,
        },
      ],
    },
    trigger: "scheduled",
    status: "running",
    scheduledFor: "2026-08-10T12:00:00.000Z",
    createdAt: "2026-08-10T12:00:00.000Z",
    updatedAt: "2026-08-10T12:00:00.000Z",
    attempts: 1,
  };
}
