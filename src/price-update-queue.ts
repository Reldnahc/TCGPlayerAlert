import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createTcgplayerSellerClient,
  isTcgplayerApiError,
  type SellerPriceUpdate,
} from "tcgplayer-private-api";
import type { AppConfig, PriceUpdateQueueConfig } from "./config.js";
import {
  ApplicationError,
  ConfigurationError,
  safeErrorCode,
} from "./errors.js";
import type { Logger } from "./logger.js";
import { safeIdentifier } from "./logger.js";
import {
  environmentSellerCredentialAccess,
  type SellerCredentialAccess,
} from "./seller-credentials.js";
import { FileSyncLease, type SyncLease } from "./sync-lease.js";

export type PriceUpdateJobStatus =
  | "pending"
  | "applying"
  | "applied"
  | "failed"
  | "review-required"
  | "superseded"
  | "canceled";

export interface PriceUpdateJob {
  readonly id: string;
  readonly update: SellerPriceUpdate;
  readonly status: PriceUpdateJobStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly attempts: number;
  readonly nextAttemptAt?: string;
  readonly errorCode?: string;
  readonly resubmittedFromJobId?: string;
}

interface PriceUpdateQueueState {
  readonly version: 1;
  readonly jobs: readonly PriceUpdateJob[];
}

export interface PriceUpdateQueueSnapshot {
  readonly jobs: readonly PriceUpdateJob[];
  readonly counts: Readonly<Record<PriceUpdateJobStatus, number>>;
}

export interface PriceUpdateExecutor {
  apply(update: SellerPriceUpdate, signal?: AbortSignal): Promise<void>;
}

export interface PriceUpdateQueueStoreOptions {
  readonly stateFile: string;
  readonly historyLimit: number;
  readonly now?: () => Date;
  readonly lease?: SyncLease;
}

const TERMINAL_STATUSES = new Set<PriceUpdateJobStatus>([
  "applied",
  "failed",
  "superseded",
  "canceled",
]);

export class PriceUpdateQueueStore {
  private readonly stateFile: string;
  private readonly historyLimit: number;
  private readonly now: () => Date;
  private readonly lease: SyncLease;
  private operations: Promise<void> = Promise.resolve();

  constructor(options: PriceUpdateQueueStoreOptions) {
    this.stateFile = resolve(options.stateFile);
    this.historyLimit = options.historyLimit;
    this.now = options.now ?? (() => new Date());
    this.lease =
      options.lease ?? new FileSyncLease(`${this.stateFile}.queue-lock`);
  }

  enqueue(value: unknown): Promise<readonly PriceUpdateJob[]> {
    const updates = parsePriceUpdates(value);
    return this.exclusive(async () =>
      this.lease.runExclusive(async () => {
        const state = await this.loadState();
        const timestamp = this.now().toISOString();
        const keys = new Set(updates.map(listingKey));
        const jobs = state.jobs.map((job) =>
          job.status === "pending" && keys.has(listingKey(job.update))
            ? { ...job, status: "superseded" as const, updatedAt: timestamp }
            : job,
        );
        const created = updates.map((update): PriceUpdateJob => ({
          id: randomUUID(),
          update,
          status: "pending",
          createdAt: timestamp,
          updatedAt: timestamp,
          attempts: 0,
        }));
        await this.saveState({
          version: 1,
          jobs: this.prune([...jobs, ...created]),
        });
        return created;
      }),
    );
  }

  snapshot(): Promise<PriceUpdateQueueSnapshot> {
    return this.exclusive(async () =>
      this.snapshotFrom(await this.loadState()),
    );
  }

  cancel(jobId: string): Promise<PriceUpdateJob> {
    if (!/^[0-9a-f-]{36}$/iu.test(jobId)) {
      throw new ConfigurationError(["The price-update job id is invalid."]);
    }
    return this.exclusive(async () =>
      this.lease.runExclusive(async () => {
        const state = await this.loadState();
        const existing = state.jobs.find((job) => job.id === jobId);
        if (existing === undefined) {
          throw new ApplicationError(
            "PROVIDER_ERROR",
            "The price-update job was not found.",
          );
        }
        if (existing.status !== "pending") {
          throw new ApplicationError(
            "REVIEW_REQUIRED",
            "Only a pending price-update job can be canceled.",
          );
        }
        const timestamp = this.now().toISOString();
        const canceled = {
          ...existing,
          status: "canceled" as const,
          updatedAt: timestamp,
        };
        await this.saveState({
          version: 1,
          jobs: state.jobs.map((job) => (job.id === jobId ? canceled : job)),
        });
        return canceled;
      }),
    );
  }

  resubmit(jobId: string): Promise<PriceUpdateJob> {
    if (!/^[0-9a-f-]{36}$/iu.test(jobId)) {
      throw new ConfigurationError(["The price-update job id is invalid."]);
    }
    return this.exclusive(async () =>
      this.lease.runExclusive(async () => {
        const state = await this.loadState();
        const existing = state.jobs.find((job) => job.id === jobId);
        if (existing === undefined) {
          throw new ApplicationError(
            "PROVIDER_ERROR",
            "The price-update job was not found.",
          );
        }
        if (existing.status !== "failed") {
          throw new ApplicationError(
            "REVIEW_REQUIRED",
            "Only a failed price-update job can be resubmitted.",
          );
        }
        if (state.jobs.some((job) => job.resubmittedFromJobId === jobId)) {
          throw new ApplicationError(
            "REVIEW_REQUIRED",
            "This failed price-update job has already been resubmitted.",
          );
        }
        const timestamp = this.now().toISOString();
        const key = listingKey(existing.update);
        const jobs = state.jobs.map((job) =>
          job.status === "pending" && listingKey(job.update) === key
            ? { ...job, status: "superseded" as const, updatedAt: timestamp }
            : job,
        );
        const created: PriceUpdateJob = {
          id: randomUUID(),
          update: existing.update,
          status: "pending",
          createdAt: timestamp,
          updatedAt: timestamp,
          attempts: 0,
          resubmittedFromJobId: jobId,
        };
        await this.saveState({
          version: 1,
          jobs: this.prune([...jobs, created]),
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

  claimNext(): Promise<PriceUpdateJob | undefined> {
    return this.exclusive(async () =>
      this.lease.runExclusive(async () => {
        const state = await this.loadState();
        if (state.jobs.some((job) => job.status === "applying"))
          return undefined;
        const now = this.now();
        const next = state.jobs.find(
          (job) =>
            job.status === "pending" &&
            (job.nextAttemptAt === undefined ||
              Date.parse(job.nextAttemptAt) <= now.getTime()),
        );
        if (next === undefined) return undefined;
        const claimed: PriceUpdateJob = {
          id: next.id,
          update: next.update,
          status: "applying",
          createdAt: next.createdAt,
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
    status: "applied" | "failed" | "review-required",
    errorCode?: string,
  ): Promise<void> {
    return this.updateApplying(jobId, {
      status,
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  }

  retryAfterRateLimit(jobId: string, delaySeconds: number): Promise<void> {
    const nextAttemptAt = new Date(
      this.now().getTime() + delaySeconds * 1000,
    ).toISOString();
    return this.updateApplying(jobId, {
      status: "pending",
      nextAttemptAt,
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
    update: Pick<PriceUpdateJob, "status"> &
      Partial<Pick<PriceUpdateJob, "nextAttemptAt" | "errorCode">>,
  ): Promise<void> {
    return this.exclusive(async () =>
      this.lease.runExclusive(async () => {
        const state = await this.loadState();
        const existing = state.jobs.find((job) => job.id === jobId);
        if (existing?.status !== "applying") {
          throw new ApplicationError(
            "PERSISTENCE_ERROR",
            "The claimed price-update job changed unexpectedly.",
          );
        }
        const replacement: PriceUpdateJob = {
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

  private async loadState(): Promise<PriceUpdateQueueState> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.stateFile, "utf8")) as unknown;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return { version: 1, jobs: [] };
      throw new ApplicationError(
        "PERSISTENCE_ERROR",
        "Unable to read the price-update queue.",
        { cause: error },
      );
    }
    return parseQueueState(value);
  }

  private async saveState(state: PriceUpdateQueueState): Promise<void> {
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
        "Unable to save the price-update queue.",
        { cause: error },
      );
    }
  }

  private prune(jobs: readonly PriceUpdateJob[]): readonly PriceUpdateJob[] {
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

  private snapshotFrom(state: PriceUpdateQueueState): PriceUpdateQueueSnapshot {
    const counts: Record<PriceUpdateJobStatus, number> = {
      pending: 0,
      applying: 0,
      applied: 0,
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

export interface PriceUpdateWorkerOptions {
  readonly queue: PriceUpdateQueueStore;
  readonly executor: PriceUpdateExecutor;
  readonly settings: () => Promise<PriceUpdateQueueConfig>;
  readonly logger: Logger;
  readonly idleDelayMs?: number;
  readonly workerLease?: SyncLease;
  readonly canProcess?: () => boolean;
}

export class PriceUpdateWorker {
  private readonly idleDelayMs: number;
  private readonly workerLease: SyncLease;

  constructor(private readonly options: PriceUpdateWorkerOptions) {
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
      this.options.logger.error("price-queue.interrupted-jobs", {
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
      const listing = safeIdentifier(listingKey(job.update));
      this.options.logger.info("price-queue.applying", {
        jobId: job.id,
        listing,
        attempt: job.attempts,
      });
      try {
        await this.options.executor.apply(job.update, signal);
        await this.options.queue.finish(job.id, "applied");
        this.options.logger.info("price-queue.applied", {
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
          this.options.logger.error("price-queue.authentication-required", {
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
          this.options.logger.error("price-queue.rate-limited", {
            jobId: job.id,
            listing,
            retryAfterSeconds: settings.rateLimitDelaySeconds,
          });
        } else if (
          isTcgplayerApiError(error) &&
          error.code === "AMBIGUOUS_RESULT"
        ) {
          await this.options.queue.finish(job.id, "review-required", errorCode);
          this.options.logger.error("price-queue.review-required", {
            jobId: job.id,
            listing,
            errorCode,
          });
        } else {
          await this.options.queue.finish(job.id, "failed", errorCode);
          this.options.logger.error("price-queue.failed", {
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

export function createTcgplayerPriceUpdateExecutor(
  config: AppConfig,
  environment: NodeJS.ProcessEnv = process.env,
  credentials?: SellerCredentialAccess,
): PriceUpdateExecutor {
  const access =
    credentials ??
    environmentSellerCredentialAccess(
      config.provider.authCookieEnv,
      config.provider.sellerKeyEnv,
      environment,
    );
  const client = createTcgplayerSellerClient({
    session: access.session,
    onAuthenticationRequired: access.onAuthenticationRequired,
  });
  return {
    apply: async (update, signal) => {
      const sellerKey = access.sellerKey();
      const requestOptions = signal === undefined ? undefined : { signal };
      const [currentResult, secondaryResult] = await Promise.all([
        client.searchMarketplaceProducts(
          {
            productIds: [update.productId],
            sellerKey,
            channelId: update.channelId,
            limit: 24,
          },
          requestOptions,
        ),
        update.channelId === 0
          ? client.searchMarketplaceProducts(
              {
                productIds: [update.productId],
                sellerKey,
                channelId: 1,
                limit: 24,
              },
              requestOptions,
            )
          : Promise.resolve({ totalProducts: 0, products: [] }),
      ]);
      const currentListing = currentResult.products
        .flatMap((product) => product.listings)
        .find(
          (listing) =>
            listing.productConditionId === update.productConditionId &&
            listing.sellerKey === sellerKey &&
            listing.channelId === update.channelId,
        );
      if (currentListing === undefined || currentListing.quantity < 1) {
        throw new ApplicationError(
          "PROVIDER_ERROR",
          "The listing is no longer live, so its queued price was not submitted.",
        );
      }
      if (currentListing.customData.customListingId !== undefined) {
        throw new ApplicationError(
          "PROVIDER_ERROR",
          "Custom listings cannot be repriced automatically.",
        );
      }
      const hasSecondaryInventory = secondaryResult.products
        .flatMap((product) => product.listings)
        .some(
          (listing) =>
            listing.productConditionId === update.productConditionId &&
            listing.sellerKey === sellerKey,
        );
      if (hasSecondaryInventory) {
        throw new ApplicationError(
          "PROVIDER_ERROR",
          "The listing now has secondary-channel inventory, so reserve quantity cannot be preserved safely.",
        );
      }
      if (currentListing.price === update.price) return;
      await client.updateSellerPrices(
        {
          updates: [
            {
              ...update,
              conditionId: currentListing.conditionId,
              channelId: currentListing.channelId,
              quantity: currentListing.quantity,
            },
          ],
        },
        requestOptions,
      );
    },
  };
}

export function parsePriceUpdates(
  value: unknown,
): readonly SellerPriceUpdate[] {
  const source = objectValue(value);
  const candidates = Array.isArray(source?.updates) ? source.updates : [value];
  if (candidates.length === 0) {
    throw new ConfigurationError(["Provide at least one price update."]);
  }
  const issues: string[] = [];
  const updates = candidates.map((candidate, index) =>
    parsePriceUpdate(candidate, index, issues),
  );
  const keys = updates.map(listingKey);
  if (new Set(keys).size !== keys.length) {
    issues.push(
      "A batch cannot contain the same SKU and channel more than once.",
    );
  }
  if (issues.length > 0) throw new ConfigurationError(issues);
  return updates;
}

function parsePriceUpdate(
  value: unknown,
  index: number,
  issues: string[],
): SellerPriceUpdate {
  const source = objectValue(value);
  const path = `updates[${String(index)}]`;
  if (source === undefined) issues.push(`${path} must be an object.`);
  const price = decimal(
    source?.price,
    `${path}.price`,
    0.01,
    1_000_000,
    issues,
  );
  const priceInCents = price * 100;
  if (Math.abs(priceInCents - Math.round(priceInCents)) > 1e-9) {
    issues.push(`${path}.price must have at most two decimal places.`);
  }
  return {
    productId: whole(source?.productId, `${path}.productId`, 1, issues),
    productName: safeText(
      source?.productName,
      `${path}.productName`,
      1024,
      issues,
    ),
    productConditionId: whole(
      source?.productConditionId,
      `${path}.productConditionId`,
      1,
      issues,
    ),
    conditionId: whole(source?.conditionId, `${path}.conditionId`, 1, issues),
    channelId: whole(source?.channelId, `${path}.channelId`, 0, issues),
    categoryName: safeText(
      source?.categoryName,
      `${path}.categoryName`,
      256,
      issues,
    ),
    quantity: whole(
      source?.quantity,
      `${path}.quantity`,
      0,
      issues,
      10_000_000,
    ),
    price,
    storePriceCustomId:
      source?.storePriceCustomId === null
        ? null
        : whole(
            source?.storePriceCustomId,
            `${path}.storePriceCustomId`,
            0,
            issues,
          ),
    reserveQuantity: decimal(
      source?.reserveQuantity,
      `${path}.reserveQuantity`,
      0,
      10_000_000,
      issues,
    ),
  };
}

function parseQueueState(value: unknown): PriceUpdateQueueState {
  const source = objectValue(value);
  if (source?.version !== 1 || !Array.isArray(source.jobs)) {
    throw new ApplicationError(
      "PERSISTENCE_ERROR",
      "The price-update queue has an unsupported schema.",
    );
  }
  const statuses = new Set<PriceUpdateJobStatus>([
    "pending",
    "applying",
    "applied",
    "failed",
    "review-required",
    "superseded",
    "canceled",
  ]);
  const jobs = source.jobs.map((value, index): PriceUpdateJob => {
    const job = objectValue(value);
    const status = job?.status;
    if (
      typeof job?.id !== "string" ||
      typeof status !== "string" ||
      !statuses.has(status as PriceUpdateJobStatus) ||
      typeof job.createdAt !== "string" ||
      typeof job.updatedAt !== "string" ||
      !Number.isInteger(job.attempts) ||
      (job.resubmittedFromJobId !== undefined &&
        (typeof job.resubmittedFromJobId !== "string" ||
          !/^[0-9a-f-]{36}$/iu.test(job.resubmittedFromJobId)))
    ) {
      throw new ApplicationError(
        "PERSISTENCE_ERROR",
        `Price-update queue job ${String(index)} is invalid.`,
      );
    }
    const update = parsePriceUpdates(job.update)[0];
    if (update === undefined) {
      throw new ApplicationError(
        "PERSISTENCE_ERROR",
        "A queue job has no update.",
      );
    }
    return {
      id: job.id,
      update,
      status: status as PriceUpdateJobStatus,
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
  });
  return { version: 1, jobs };
}

function listingKey(update: SellerPriceUpdate): string {
  return `${String(update.productConditionId)}:${String(update.channelId)}`;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeText(
  value: unknown,
  path: string,
  maximum: number,
  issues: string[],
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    containsControlCharacter(value)
  ) {
    issues.push(`${path} must be a non-empty safe string.`);
    return "";
  }
  return value.trim();
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function whole(
  value: unknown,
  path: string,
  minimum: number,
  issues: string[],
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    issues.push(
      `${path} must be a whole number from ${String(minimum)} through ${String(maximum)}.`,
    );
    return minimum;
  }
  return Number(value);
}

function decimal(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  issues: string[],
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    issues.push(
      `${path} must be from ${String(minimum)} through ${String(maximum)}.`,
    );
    return minimum;
  }
  return value;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  if (milliseconds <= 0) return;
  await new Promise<void>((resolvePromise) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolvePromise();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}
