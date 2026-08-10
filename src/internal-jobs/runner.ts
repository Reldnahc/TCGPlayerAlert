import { isTcgplayerApiError } from "tcgplayer-private-api";
import type { AppConfig, RepricingProfileConfig } from "../config.js";
import { ApplicationError, safeErrorCode } from "../errors.js";
import type {
  InventoryAdditionQueueStore,
  InventoryAdditionService,
} from "../inventory-additions.js";
import type { Logger } from "../logger.js";
import type { PriceUpdateQueueStore } from "../price-update-queue.js";
import type { RepricingPreviewRow, RepricingService } from "../repricing.js";
import type { SyncLease } from "../sync-lease.js";
import type {
  AutomaticRepricingLimits,
  InternalRun,
  InternalRunReport,
  InternalRunReportItem,
  InternalRunStatus,
} from "./contracts.js";
import type { InternalJobStore } from "./store.js";

const MAXIMUM_RETAINED_REPORT_ITEMS = 2_000;

interface ExecutionResult {
  readonly status: Extract<
    InternalRunStatus,
    "succeeded" | "partial" | "review-required" | "skipped"
  >;
  readonly report: InternalRunReport;
}

export interface InternalJobExecutorOptions {
  readonly repricingService: RepricingService;
  readonly inventoryService: InventoryAdditionService;
  readonly priceQueue: PriceUpdateQueueStore;
  readonly inventoryQueue: InventoryAdditionQueueStore;
  readonly loadConfig: () => Promise<AppConfig>;
}

export class InternalJobExecutor {
  constructor(private readonly options: InternalJobExecutorOptions) {}

  async execute(
    run: InternalRun,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    signal?.throwIfAborted();
    return run.payload.type === "reprice-inventory"
      ? this.executeRepricing(run, signal)
      : this.executeListing(run, signal);
  }

  private async executeRepricing(
    run: InternalRun,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    const payload = run.payload;
    if (payload.type !== "reprice-inventory") {
      throw new ApplicationError(
        "PERSISTENCE_ERROR",
        "The internal run payload does not match its handler.",
      );
    }
    const existing = await this.options.priceQueue.jobsForSourceRun(run.id);
    if (existing.length > 0) {
      return {
        status: "succeeded",
        report: reportFromRecoveredPriceJobs(existing),
      };
    }
    const config = await this.options.loadConfig();
    const profile = config.repricingProfiles.find(
      (candidate) => candidate.id === payload.pricingProfileId,
    );
    if (profile === undefined) {
      return missingProfileResult(
        "The selected pricing profile no longer exists.",
      );
    }
    const preview = await this.options.repricingService.preview(profile, {
      forceRefresh: true,
      ...(signal === undefined ? {} : { signal }),
    });
    const candidates: RepricingPreviewRow[] = [];
    const safeCandidates: RepricingPreviewRow[] = [];
    const reportItems: InternalRunReportItem[] = [];
    let unchanged = 0;
    let skipped = 0;
    let reviewRequired = 0;
    for (const row of preview.rows) {
      if (row.status === "unchanged") {
        unchanged += 1;
        reportItems.push(reportItem(row, "unchanged", row.reason));
        continue;
      }
      if (row.status !== "ready" || !row.queueable) {
        skipped += 1;
        reportItems.push(reportItem(row, "skipped", row.reason));
        continue;
      }
      candidates.push(row);
      const safetyReason =
        payload.mode === "automatic"
          ? automaticSafetyReason(row, payload.limits)
          : undefined;
      if (safetyReason === undefined) {
        safeCandidates.push(row);
        reportItems.push(
          reportItem(row, payload.mode === "review" ? "proposed" : "queued"),
        );
      } else {
        reviewRequired += 1;
        reportItems.push(reportItem(row, "review-required", safetyReason));
      }
    }

    if (payload.mode === "review") {
      return {
        status: "succeeded",
        report: buildReport({
          proposed: candidates.length,
          queuedPriceJobs: 0,
          queuedInventoryJobs: 0,
          unchanged,
          skipped,
          reviewRequired,
          items: reportItems,
        }),
      };
    }

    let stoppedReason: string | undefined;
    if (safeCandidates.length > payload.limits.maximumUpdates) {
      stoppedReason = `The run proposed ${String(safeCandidates.length)} safe updates, exceeding its limit of ${String(payload.limits.maximumUpdates)}.`;
    } else if (
      candidates.length > 0 &&
      (reviewRequired / candidates.length) * 100 >
        payload.limits.maximumBlockedPercent
    ) {
      stoppedReason = `Safety limits blocked more than ${String(payload.limits.maximumBlockedPercent)}% of proposed changes.`;
    }
    if (stoppedReason !== undefined) {
      reviewRequired += safeCandidates.length;
      const safeIds = new Set(safeCandidates.map((row) => row.id));
      const stoppedItems = reportItems.map((item) =>
        safeIds.has(item.key)
          ? {
              ...item,
              outcome: "review-required" as const,
              reason: stoppedReason,
            }
          : item,
      );
      return {
        status: "review-required",
        report: buildReport({
          proposed: candidates.length,
          queuedPriceJobs: 0,
          queuedInventoryJobs: 0,
          unchanged,
          skipped,
          reviewRequired,
          items: stoppedItems,
        }),
      };
    }

    const updates =
      safeCandidates.length === 0
        ? []
        : this.options.repricingService.takeUpdates(preview.id, {
            rowIds: safeCandidates.map((row) => row.id),
          });
    const jobs =
      updates.length === 0
        ? []
        : await this.options.priceQueue.enqueue(
            { updates },
            { sourceRunId: run.id },
          );
    return {
      status:
        reviewRequired > 0 && jobs.length > 0
          ? "partial"
          : reviewRequired > 0
            ? "review-required"
            : "succeeded",
      report: buildReport({
        proposed: candidates.length,
        queuedPriceJobs: jobs.length,
        queuedInventoryJobs: 0,
        unchanged,
        skipped,
        reviewRequired,
        items: reportItems,
      }),
    };
  }

  private async executeListing(
    run: InternalRun,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    const payload = run.payload;
    if (payload.type !== "list-inventory") {
      throw new ApplicationError(
        "PERSISTENCE_ERROR",
        "The internal run payload does not match its handler.",
      );
    }
    const existing = await this.options.inventoryQueue.jobsForSourceRun(run.id);
    if (existing.length > 0) {
      return {
        status: "succeeded",
        report: reportFromRecoveredInventoryJobs(existing),
      };
    }
    const config = await this.options.loadConfig();
    const merchandiseProfile = config.merchandiseProfiles.find(
      (candidate) => candidate.id === payload.merchandiseProfileId,
    );
    if (merchandiseProfile === undefined) {
      return listingProfileMissing(
        run,
        "The selected merchandise profile no longer exists.",
      );
    }
    const pricingProfile = config.repricingProfiles.find(
      (candidate) => candidate.id === merchandiseProfile.pricingProfileId,
    );
    if (pricingProfile === undefined) {
      return listingProfileMissing(
        run,
        "The merchandise profile's pricing profile no longer exists.",
      );
    }
    const additions = [];
    const items: InternalRunReportItem[] = [];
    let reviewRequired = 0;
    for (const item of payload.items) {
      signal?.throwIfAborted();
      try {
        const preview = await this.options.inventoryService.preview(
          {
            productId: item.productId,
            productConditionId: item.productConditionId,
            addQuantity: item.quantity,
            rules: listingRules(
              pricingProfile,
              merchandiseProfile.estimatedShippingPrice,
            ),
          },
          { forceRefresh: true },
        );
        if (!preview.queueable) {
          reviewRequired += 1;
          items.push({
            key: String(item.productConditionId),
            productName: item.productName,
            outcome: "review-required",
            quantity: item.quantity,
            reason: preview.reason,
          });
          continue;
        }
        additions.push(this.options.inventoryService.takeAddition(preview.id));
        items.push({
          key: String(item.productConditionId),
          productName: item.productName,
          outcome: "queued",
          quantity: item.quantity,
          ...(preview.proposedPrice === undefined
            ? {}
            : { proposedPrice: preview.proposedPrice }),
        });
      } catch (error) {
        if (isRetryableJobError(error)) throw error;
        reviewRequired += 1;
        items.push({
          key: String(item.productConditionId),
          productName: item.productName,
          outcome: "review-required",
          quantity: item.quantity,
          reason: `Fresh listing validation failed (${safeErrorCode(error)}).`,
        });
      }
    }
    const jobs = await this.options.inventoryQueue.enqueueScheduled(
      additions,
      run.id,
    );
    return {
      status:
        reviewRequired > 0 && jobs.length > 0
          ? "partial"
          : reviewRequired > 0
            ? "review-required"
            : "succeeded",
      report: buildReport({
        proposed: additions.length,
        queuedPriceJobs: 0,
        queuedInventoryJobs: jobs.length,
        unchanged: 0,
        skipped: 0,
        reviewRequired,
        items,
      }),
    };
  }
}

export interface InternalJobRunnerOptions {
  readonly store: InternalJobStore;
  readonly executor: InternalJobExecutor;
  readonly logger: Logger;
  readonly canProcess?: () => boolean;
  readonly idleDelayMs?: number;
  readonly workerLease?: SyncLease;
  readonly random?: () => number;
}

export class InternalJobRunner {
  private readonly idleDelayMs: number;
  private readonly workerLease: SyncLease;
  private readonly random: () => number;

  constructor(private readonly options: InternalJobRunnerOptions) {
    this.idleDelayMs = options.idleDelayMs ?? 1_000;
    this.workerLease = options.workerLease ?? {
      runExclusive: <T>(work: () => Promise<T>) => work(),
    };
    this.random = options.random ?? Math.random;
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.workerLease.runExclusive(
      () => this.runExclusive(signal),
      signal,
    );
  }

  private async runExclusive(signal: AbortSignal): Promise<void> {
    const recovered = await this.options.store.recoverInterrupted();
    if (recovered > 0) {
      this.options.logger.info("internal-jobs.recovered", { count: recovered });
    }
    while (!signal.aborted) {
      if (this.options.canProcess?.() === false) {
        await wait(this.idleDelayMs, signal);
        continue;
      }
      const run = await this.options.store.claimNext();
      if (run === undefined) {
        await wait(this.idleDelayMs, signal);
        continue;
      }
      this.options.logger.info("internal-jobs.running", {
        runId: run.id,
        type: run.payload.type,
        attempt: run.attempts,
      });
      try {
        const result = await this.options.executor.execute(run, signal);
        await this.options.store.finishRun(
          run.id,
          result.status,
          result.report,
        );
        this.options.logger.info("internal-jobs.completed", {
          runId: run.id,
          type: run.payload.type,
          status: result.status,
        });
      } catch (error) {
        if (wasAborted(signal)) break;
        const errorCode = safeErrorCode(error);
        if (run.attempts < 3 && isRetryableJobError(error)) {
          const delay = retryDelay(error, run.attempts, this.random);
          await this.options.store.retryRun(run.id, delay, errorCode);
          this.options.logger.error("internal-jobs.retrying", {
            runId: run.id,
            type: run.payload.type,
            errorCode,
            delayMilliseconds: delay,
          });
        } else {
          await this.options.store.finishRun(
            run.id,
            "failed",
            undefined,
            errorCode,
          );
          this.options.logger.error("internal-jobs.failed", {
            runId: run.id,
            type: run.payload.type,
            errorCode,
          });
        }
      }
    }
  }
}

function automaticSafetyReason(
  row: RepricingPreviewRow,
  limits: AutomaticRepricingLimits,
): string | undefined {
  const difference = row.proposedPrice - row.currentPrice;
  const percent =
    row.currentPrice === 0
      ? 0
      : (Math.abs(difference) / row.currentPrice) * 100;
  if (
    difference < 0 &&
    (percent > limits.maximumDecreasePercent ||
      Math.abs(difference) > limits.maximumDecreaseAmount)
  ) {
    return `The proposed decrease exceeds this schedule's ${String(limits.maximumDecreasePercent)}% or $${limits.maximumDecreaseAmount.toFixed(2)} safety limit.`;
  }
  if (difference > 0 && percent > limits.maximumIncreasePercent) {
    return `The proposed increase exceeds this schedule's ${String(limits.maximumIncreasePercent)}% safety limit.`;
  }
  return undefined;
}

function reportItem(
  row: RepricingPreviewRow,
  outcome: InternalRunReportItem["outcome"],
  reason?: string,
): InternalRunReportItem {
  return {
    key: row.id,
    productName: row.productName,
    outcome,
    quantity: row.quantity,
    currentPrice: row.currentPrice,
    proposedPrice: row.proposedPrice,
    ...(reason === undefined ? {} : { reason }),
  };
}

function buildReport(
  report: Omit<InternalRunReport, "truncatedItems">,
): InternalRunReport {
  return {
    ...report,
    items: report.items.slice(0, MAXIMUM_RETAINED_REPORT_ITEMS),
    truncatedItems: Math.max(
      0,
      report.items.length - MAXIMUM_RETAINED_REPORT_ITEMS,
    ),
  };
}

function missingProfileResult(reason: string): ExecutionResult {
  return {
    status: "review-required",
    report: buildReport({
      proposed: 0,
      queuedPriceJobs: 0,
      queuedInventoryJobs: 0,
      unchanged: 0,
      skipped: 0,
      reviewRequired: 1,
      items: [
        {
          key: "profile",
          productName: "Pricing profile",
          outcome: "review-required",
          reason,
        },
      ],
    }),
  };
}

function listingProfileMissing(
  run: InternalRun,
  reason: string,
): ExecutionResult {
  if (run.payload.type !== "list-inventory")
    return missingProfileResult(reason);
  return {
    status: "review-required",
    report: buildReport({
      proposed: 0,
      queuedPriceJobs: 0,
      queuedInventoryJobs: 0,
      unchanged: 0,
      skipped: 0,
      reviewRequired: run.payload.items.length,
      items: run.payload.items.map((item) => ({
        key: String(item.productConditionId),
        productName: item.productName,
        outcome: "review-required" as const,
        quantity: item.quantity,
        reason,
      })),
    }),
  };
}

function listingRules(
  profile: RepricingProfileConfig,
  estimatedShippingPrice: number,
) {
  return { ...profile, estimatedShippingPrice };
}

function reportFromRecoveredPriceJobs(
  jobs: Awaited<ReturnType<PriceUpdateQueueStore["jobsForSourceRun"]>>,
): InternalRunReport {
  return buildReport({
    proposed: jobs.length,
    queuedPriceJobs: jobs.length,
    queuedInventoryJobs: 0,
    unchanged: 0,
    skipped: 0,
    reviewRequired: 0,
    items: jobs.map((job) => ({
      key: String(job.update.productConditionId),
      productName: job.update.productName,
      outcome: "queued" as const,
      quantity: job.update.quantity,
      proposedPrice: job.update.price,
      reason: "Recovered the mutation jobs already dispatched by this run.",
    })),
  });
}

function reportFromRecoveredInventoryJobs(
  jobs: Awaited<ReturnType<InventoryAdditionQueueStore["jobsForSourceRun"]>>,
): InternalRunReport {
  return buildReport({
    proposed: jobs.length,
    queuedPriceJobs: 0,
    queuedInventoryJobs: jobs.length,
    unchanged: 0,
    skipped: 0,
    reviewRequired: 0,
    items: jobs.map((job) => {
      const change = job.operation === "add" ? job.addition : job.removal;
      return {
        key: String(change.productConditionId),
        productName: change.productName,
        outcome: "queued" as const,
        quantity: job.operation === "add" ? job.addition.addQuantity : 0,
        proposedPrice: change.price,
        reason: "Recovered the mutation jobs already dispatched by this run.",
      };
    }),
  });
}

function isRetryableJobError(error: unknown): boolean {
  return (
    (isTcgplayerApiError(error) &&
      (error.retryable ||
        error.code === "AUTHENTICATION_REQUIRED" ||
        error.code === "RATE_LIMITED")) ||
    (error instanceof ApplicationError && error.retryable)
  );
}

function retryDelay(
  error: unknown,
  attempts: number,
  random: () => number,
): number {
  const base =
    isTcgplayerApiError(error) && error.code === "RATE_LIMITED"
      ? 300_000
      : isTcgplayerApiError(error) && error.code === "AUTHENTICATION_REQUIRED"
        ? 60_000
        : Math.min(300_000, 15_000 * 2 ** Math.max(0, attempts - 1));
  const unit = Math.max(0, Math.min(1, random()));
  return Math.min(300_000, Math.round(base * (0.8 + unit * 0.4)));
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolvePromise();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function wasAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}
