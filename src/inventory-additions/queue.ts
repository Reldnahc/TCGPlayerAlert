import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  SellerInventoryAddition,
  SellerInventoryRemoval,
} from "tcgplayer-private-api";
import { ApplicationError, ConfigurationError } from "../errors.js";
import { FileSyncLease, type SyncLease } from "../sync-lease.js";

type UnknownRecord = Record<string, unknown>;
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
