import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ApplicationError, ConfigurationError } from "../errors.js";
import { FileSyncLease, type SyncLease } from "../sync-lease.js";
import type {
  AutomaticRepricingLimits,
  InternalJobSnapshot,
  InternalRun,
  InternalRunReport,
  InternalRunReportItem,
  InternalRunStatus,
  InternalSchedule,
  InternalScheduleInput,
  InternalSchedulePayload,
  InternalScheduleTiming,
  ScheduledListingInput,
  ScheduledListingItem,
} from "./contracts.js";
import {
  isValidTimeZone,
  nextScheduleOccurrence,
  scheduleWallClockSlot,
} from "./schedule.js";

interface InternalJobState {
  readonly version: 1;
  readonly schedules: readonly InternalSchedule[];
  readonly runs: readonly InternalRun[];
}

export interface InternalJobStoreOptions {
  readonly stateFile: string;
  readonly historyLimit?: number;
  readonly now?: () => Date;
  readonly id?: () => string;
  readonly lease?: SyncLease;
}

const MAXIMUM_STATE_BYTES = 10 * 1024 * 1024;
const MAXIMUM_SCHEDULES = 200;
const MAXIMUM_LISTING_ITEMS = 2_000;
const MAXIMUM_REPORT_ITEMS = 2_000;
const MAXIMUM_RUNS = 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const PROFILE_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const TIME_OF_DAY = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const TERMINAL_RUN_STATUSES = new Set<InternalRunStatus>([
  "succeeded",
  "partial",
  "failed",
  "review-required",
  "canceled",
  "skipped",
]);

export function internalJobStatePath(stateFile: string): string {
  if (stateFile.trim().length === 0) {
    throw new ConfigurationError(["The workflow state path is invalid."]);
  }
  return `${stateFile}.internal-jobs.json`;
}

export class InternalJobStore {
  private readonly stateFile: string;
  private readonly historyLimit: number;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly lease: SyncLease;
  private operations: Promise<void> = Promise.resolve();

  constructor(options: InternalJobStoreOptions) {
    this.stateFile = resolve(options.stateFile);
    this.historyLimit = options.historyLimit ?? 200;
    if (
      !Number.isSafeInteger(this.historyLimit) ||
      this.historyLimit < 10 ||
      this.historyLimit > MAXIMUM_RUNS
    ) {
      throw new ConfigurationError([
        "Internal-job history must retain between 10 and 1,000 runs.",
      ]);
    }
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.lease =
      options.lease ?? new FileSyncLease(`${this.stateFile}.queue-lock`);
  }

  snapshot(): Promise<InternalJobSnapshot> {
    return this.exclusive(async () => {
      const state = await this.loadState();
      return {
        schedules: [...state.schedules].sort((left, right) =>
          compareOptionalDate(left.nextRunAt, right.nextRunAt),
        ),
        runs: [...state.runs].reverse(),
      };
    });
  }

  createSchedule(value: unknown): Promise<InternalSchedule> {
    const input = parseScheduleInput(value);
    return this.exclusive(async () =>
      this.lease.runExclusive(async () => {
        const state = await this.loadState();
        if (state.schedules.length >= MAXIMUM_SCHEDULES) {
          throw new ConfigurationError([
            `At most ${String(MAXIMUM_SCHEDULES)} internal schedules are supported.`,
          ]);
        }
        const now = this.now();
        const schedule = scheduleFromInput(this.id(), input, now);
        await this.saveState({
          version: 1,
          schedules: [...state.schedules, schedule],
          runs: state.runs,
        });
        return schedule;
      }),
    );
  }

  updateSchedule(
    scheduleId: string,
    value: unknown,
  ): Promise<InternalSchedule> {
    requiredUuid(scheduleId, "Internal schedule");
    const input = parseScheduleInput(value);
    return this.exclusive(async () =>
      this.lease.runExclusive(async () => {
        const state = await this.loadState();
        const existing = state.schedules.find(
          (schedule) => schedule.id === scheduleId,
        );
        if (existing === undefined) throw scheduleNotFound();
        if (
          state.runs.some(
            (run) =>
              run.scheduleId === scheduleId &&
              (run.status === "queued" || run.status === "running"),
          )
        ) {
          throw new ApplicationError(
            "REVIEW_REQUIRED",
            "The schedule cannot be edited while one of its runs is active.",
          );
        }
        const now = this.now();
        const replacement: InternalSchedule = {
          ...scheduleFromInput(existing.id, input, now),
          createdAt: existing.createdAt,
          ...(existing.lastRunAt === undefined
            ? {}
            : { lastRunAt: existing.lastRunAt }),
          ...(existing.lastRunId === undefined
            ? {}
            : { lastRunId: existing.lastRunId }),
        };
        await this.saveState({
          version: 1,
          schedules: state.schedules.map((schedule) =>
            schedule.id === scheduleId ? replacement : schedule,
          ),
          runs: state.runs,
        });
        return replacement;
      }),
    );
  }

  deleteSchedule(scheduleId: string): Promise<void> {
    requiredUuid(scheduleId, "Internal schedule");
    return this.exclusive(async () =>
      this.lease.runExclusive(async () => {
        const state = await this.loadState();
        if (!state.schedules.some((schedule) => schedule.id === scheduleId)) {
          throw scheduleNotFound();
        }
        if (
          state.runs.some(
            (run) =>
              run.scheduleId === scheduleId &&
              (run.status === "queued" || run.status === "running"),
          )
        ) {
          throw new ApplicationError(
            "REVIEW_REQUIRED",
            "Cancel the active run before deleting its schedule.",
          );
        }
        await this.saveState({
          version: 1,
          schedules: state.schedules.filter(
            (schedule) => schedule.id !== scheduleId,
          ),
          runs: state.runs,
        });
      }),
    );
  }

  addScheduledListing(value: unknown): Promise<InternalSchedule> {
    const input = parseScheduledListingInput(value);
    return this.exclusive(async () =>
      this.lease.runExclusive(async () => {
        const state = await this.loadState();
        const now = this.now();
        const runAt = new Date(input.runAt).toISOString();
        if (Date.parse(runAt) <= now.getTime()) {
          throw new ConfigurationError([
            "A scheduled listing release time must be in the future.",
          ]);
        }
        const existing = state.schedules.find(
          (schedule) =>
            schedule.enabled &&
            schedule.payload.type === "list-inventory" &&
            schedule.payload.merchandiseProfileId ===
              input.merchandiseProfileId &&
            schedule.timing.kind === "once" &&
            schedule.timing.runAt === runAt,
        );
        if (
          existing === undefined &&
          state.schedules.length >= MAXIMUM_SCHEDULES
        ) {
          throw new ConfigurationError([
            `At most ${String(MAXIMUM_SCHEDULES)} internal schedules are supported.`,
          ]);
        }
        const items = mergeListingItem(
          existing?.payload.type === "list-inventory"
            ? existing.payload.items
            : [],
          input.item,
        );
        const quantity = items.reduce(
          (total, item) => total + item.quantity,
          0,
        );
        const schedule: InternalSchedule = {
          id: existing?.id ?? this.id(),
          name: `List ${String(quantity)} card${quantity === 1 ? "" : "s"}`,
          enabled: true,
          timing: { kind: "once", runAt },
          payload: {
            type: "list-inventory",
            merchandiseProfileId: input.merchandiseProfileId,
            items,
          },
          createdAt: existing?.createdAt ?? now.toISOString(),
          updatedAt: now.toISOString(),
          nextRunAt: runAt,
          ...(existing?.lastRunAt === undefined
            ? {}
            : { lastRunAt: existing.lastRunAt }),
          ...(existing?.lastRunId === undefined
            ? {}
            : { lastRunId: existing.lastRunId }),
        };
        await this.saveState({
          version: 1,
          schedules:
            existing === undefined
              ? [...state.schedules, schedule]
              : state.schedules.map((candidate) =>
                  candidate.id === existing.id ? schedule : candidate,
                ),
          runs: state.runs,
        });
        return schedule;
      }),
    );
  }

  requestRun(scheduleId: string): Promise<InternalRun> {
    requiredUuid(scheduleId, "Internal schedule");
    return this.exclusive(async () =>
      this.lease.runExclusive(async () => {
        const state = await this.loadState();
        const schedule = state.schedules.find(
          (candidate) => candidate.id === scheduleId,
        );
        if (schedule === undefined) throw scheduleNotFound();
        if (
          state.runs.some(
            (run) =>
              run.scheduleId === scheduleId &&
              (run.status === "queued" || run.status === "running"),
          )
        ) {
          throw new ApplicationError(
            "REVIEW_REQUIRED",
            "This schedule already has an active run.",
          );
        }
        const now = this.now().toISOString();
        const run = createRun(this.id(), schedule, "manual", now, now);
        await this.saveState({
          version: 1,
          schedules: state.schedules,
          runs: this.pruneRuns([...state.runs, run]),
        });
        return run;
      }),
    );
  }

  cancelRun(runId: string): Promise<InternalRun> {
    requiredUuid(runId, "Internal run");
    return this.exclusive(async () =>
      this.lease.runExclusive(async () => {
        const state = await this.loadState();
        const existing = state.runs.find((run) => run.id === runId);
        if (existing?.status !== "queued") {
          throw new ApplicationError(
            "REVIEW_REQUIRED",
            "Only a queued internal run can be canceled.",
          );
        }
        const now = this.now().toISOString();
        const canceled: InternalRun = {
          ...existing,
          status: "canceled",
          updatedAt: now,
          completedAt: now,
        };
        await this.saveState({
          version: 1,
          schedules: state.schedules,
          runs: state.runs.map((run) => (run.id === runId ? canceled : run)),
        });
        return canceled;
      }),
    );
  }

  recoverInterrupted(): Promise<number> {
    return this.exclusive(async () =>
      this.lease.runExclusive(async () => {
        const state = await this.loadState();
        const now = this.now().toISOString();
        let recovered = 0;
        const runs = state.runs.map((run): InternalRun => {
          if (run.status !== "running") return run;
          recovered += 1;
          return {
            ...run,
            status: "queued",
            updatedAt: now,
            nextAttemptAt: now,
            errorCode: "RECOVERED_AFTER_RESTART",
          };
        });
        if (recovered > 0) {
          await this.saveState({ ...state, runs });
        }
        return recovered;
      }),
    );
  }

  claimNext(): Promise<InternalRun | undefined> {
    return this.exclusive(async () =>
      this.lease.runExclusive(async () => {
        const state = await this.loadState();
        if (state.runs.some((run) => run.status === "running"))
          return undefined;
        const now = this.now();
        const queued = state.runs.find(
          (run) =>
            run.status === "queued" &&
            (run.nextAttemptAt === undefined ||
              Date.parse(run.nextAttemptAt) <= now.getTime()),
        );
        if (queued !== undefined) {
          const claimed = claimRun(queued, now);
          await this.saveState({
            ...state,
            runs: state.runs.map((run) =>
              run.id === queued.id ? claimed : run,
            ),
          });
          return claimed;
        }
        const due = [...state.schedules]
          .filter(
            (schedule) =>
              schedule.enabled &&
              schedule.nextRunAt !== undefined &&
              Date.parse(schedule.nextRunAt) <= now.getTime(),
          )
          .sort((left, right) =>
            String(left.nextRunAt).localeCompare(String(right.nextRunAt)),
          )[0];
        if (due === undefined) return undefined;
        const scheduledFor = due.nextRunAt ?? now.toISOString();
        const run = claimRun(
          createRun(
            this.id(),
            due,
            "scheduled",
            scheduledFor,
            now.toISOString(),
          ),
          now,
        );
        const nextRunAt = advanceSchedule(due, now, scheduledFor);
        const schedule: InternalSchedule = {
          ...due,
          enabled: due.timing.kind === "once" ? false : due.enabled,
          updatedAt: now.toISOString(),
          lastRunAt: now.toISOString(),
          lastRunId: run.id,
          ...(nextRunAt === undefined ? {} : { nextRunAt }),
        };
        if (nextRunAt === undefined) {
          delete (schedule as { nextRunAt?: string }).nextRunAt;
        }
        await this.saveState({
          version: 1,
          schedules: state.schedules.map((candidate) =>
            candidate.id === due.id ? schedule : candidate,
          ),
          runs: this.pruneRuns([...state.runs, run]),
        });
        return run;
      }),
    );
  }

  finishRun(
    runId: string,
    status: Extract<
      InternalRunStatus,
      "succeeded" | "partial" | "failed" | "review-required" | "skipped"
    >,
    report?: InternalRunReport,
    errorCode?: string,
  ): Promise<InternalRun> {
    requiredUuid(runId, "Internal run");
    const parsedReport = report === undefined ? undefined : parseReport(report);
    const parsedErrorCode =
      errorCode === undefined
        ? undefined
        : safeText(errorCode, "Error code", 128);
    return this.exclusive(async () =>
      this.lease.runExclusive(async () => {
        const state = await this.loadState();
        const existing = state.runs.find((run) => run.id === runId);
        if (existing?.status !== "running") {
          throw new ApplicationError(
            "PERSISTENCE_ERROR",
            "The claimed internal run changed unexpectedly.",
          );
        }
        const now = this.now().toISOString();
        const completed: InternalRun = {
          ...existing,
          status,
          updatedAt: now,
          completedAt: now,
          ...(parsedReport === undefined ? {} : { report: parsedReport }),
          ...(parsedErrorCode === undefined
            ? {}
            : { errorCode: parsedErrorCode }),
        };
        await this.saveState({
          version: 1,
          schedules: state.schedules,
          runs: state.runs.map((run) => (run.id === runId ? completed : run)),
        });
        return completed;
      }),
    );
  }

  retryRun(
    runId: string,
    delayMilliseconds: number,
    errorCode: string,
  ): Promise<InternalRun> {
    requiredUuid(runId, "Internal run");
    if (
      !Number.isSafeInteger(delayMilliseconds) ||
      delayMilliseconds < 0 ||
      delayMilliseconds > 86_400_000
    ) {
      throw new ConfigurationError(["Internal run retry delay is invalid."]);
    }
    const parsedErrorCode = safeText(errorCode, "Error code", 128);
    return this.exclusive(async () =>
      this.lease.runExclusive(async () => {
        const state = await this.loadState();
        const existing = state.runs.find((run) => run.id === runId);
        if (existing?.status !== "running") {
          throw new ApplicationError(
            "PERSISTENCE_ERROR",
            "The claimed internal run changed unexpectedly.",
          );
        }
        const now = this.now();
        const queued: InternalRun = {
          ...existing,
          status: "queued",
          updatedAt: now.toISOString(),
          nextAttemptAt: new Date(
            now.getTime() + delayMilliseconds,
          ).toISOString(),
          errorCode: parsedErrorCode,
        };
        await this.saveState({
          version: 1,
          schedules: state.schedules,
          runs: state.runs.map((run) => (run.id === runId ? queued : run)),
        });
        return queued;
      }),
    );
  }

  private async loadState(): Promise<InternalJobState> {
    try {
      const text = await readFile(this.stateFile, "utf8");
      if (Buffer.byteLength(text, "utf8") > MAXIMUM_STATE_BYTES) {
        throw persistenceError("The internal-job state file is too large.");
      }
      return parseState(JSON.parse(text) as unknown);
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return { version: 1, schedules: [], runs: [] };
      }
      if (error instanceof ApplicationError) throw error;
      throw persistenceError("Unable to read internal-job state.", error);
    }
  }

  private async saveState(state: InternalJobState): Promise<void> {
    const validated = parseState(state);
    const text = `${JSON.stringify(validated, null, 2)}\n`;
    if (Buffer.byteLength(text, "utf8") > MAXIMUM_STATE_BYTES) {
      throw persistenceError("The internal-job state file is too large.");
    }
    await mkdir(dirname(this.stateFile), { recursive: true });
    const temporaryPath = `${this.stateFile}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, text, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, this.stateFile);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw persistenceError("Unable to save internal-job state.", error);
    }
  }

  private pruneRuns(runs: readonly InternalRun[]): readonly InternalRun[] {
    let terminalCount = runs.filter((run) =>
      TERMINAL_RUN_STATUSES.has(run.status),
    ).length;
    if (terminalCount <= this.historyLimit) return runs;
    return runs.filter((run) => {
      if (!TERMINAL_RUN_STATUSES.has(run.status)) return true;
      if (terminalCount <= this.historyLimit) return true;
      terminalCount -= 1;
      return false;
    });
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

function scheduleFromInput(
  id: string,
  input: InternalScheduleInput,
  now: Date,
): InternalSchedule {
  const timestamp = now.toISOString();
  const nextRunAt = nextScheduleOccurrence(input.timing, now);
  return {
    id,
    ...input,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(nextRunAt === undefined ? {} : { nextRunAt }),
  };
}

function advanceSchedule(
  schedule: InternalSchedule,
  now: Date,
  scheduledFor: string,
): string | undefined {
  if (schedule.timing.kind === "once") return undefined;
  return nextScheduleOccurrence(
    schedule.timing,
    now,
    scheduleWallClockSlot(schedule.timing, scheduledFor),
  );
}

function createRun(
  id: string,
  schedule: InternalSchedule,
  trigger: InternalRun["trigger"],
  scheduledFor: string,
  createdAt: string,
): InternalRun {
  return {
    id,
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    payload: schedule.payload,
    trigger,
    status: "queued",
    scheduledFor,
    createdAt,
    updatedAt: createdAt,
    attempts: 0,
  };
}

function claimRun(run: InternalRun, now: Date): InternalRun {
  return {
    ...run,
    status: "running",
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    attempts: run.attempts + 1,
  };
}

function mergeListingItem(
  existing: readonly ScheduledListingItem[],
  addition: ScheduledListingItem,
): readonly ScheduledListingItem[] {
  const match = existing.find(
    (item) => item.productConditionId === addition.productConditionId,
  );
  if (
    match !== undefined &&
    (match.productId !== addition.productId ||
      match.productName !== addition.productName)
  ) {
    throw new ConfigurationError([
      "The scheduled SKU conflicts with an existing card in this batch.",
    ]);
  }
  const quantity = (match?.quantity ?? 0) + addition.quantity;
  if (quantity > 10_000_000) {
    throw new ConfigurationError([
      "The combined scheduled quantity exceeds the supported limit.",
    ]);
  }
  const items =
    match === undefined
      ? [...existing, addition]
      : existing.map((item) =>
          item.productConditionId === addition.productConditionId
            ? { ...item, quantity }
            : item,
        );
  if (items.length > MAXIMUM_LISTING_ITEMS) {
    throw new ConfigurationError([
      `A scheduled listing batch supports at most ${String(MAXIMUM_LISTING_ITEMS)} exact SKUs.`,
    ]);
  }
  return items;
}

function parseState(value: unknown): InternalJobState {
  const source = objectValue(value);
  if (
    source?.version !== 1 ||
    !Array.isArray(source.schedules) ||
    !Array.isArray(source.runs) ||
    source.schedules.length > MAXIMUM_SCHEDULES ||
    source.runs.length > MAXIMUM_RUNS
  ) {
    throw persistenceError("The internal-job state schema is unsupported.");
  }
  try {
    const schedules = source.schedules.map(parseStoredSchedule);
    if (
      new Set(schedules.map((schedule) => schedule.id)).size !==
      schedules.length
    )
      throw new Error("duplicate schedule");
    const runs = source.runs.map(parseStoredRun);
    if (new Set(runs.map((run) => run.id)).size !== runs.length) {
      throw new Error("duplicate run");
    }
    return { version: 1, schedules, runs };
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw persistenceError(
      "The internal-job state contains invalid data.",
      error,
    );
  }
}

function parseStoredSchedule(value: unknown): InternalSchedule {
  const source = requiredObject(value, "Stored schedule");
  const input = parseScheduleInput(source);
  const id = requiredUuid(source.id, "Stored schedule");
  const createdAt = isoTimestamp(
    source.createdAt,
    "Stored schedule created time",
  );
  const updatedAt = isoTimestamp(
    source.updatedAt,
    "Stored schedule updated time",
  );
  return {
    id,
    ...input,
    createdAt,
    updatedAt,
    ...(source.nextRunAt === undefined
      ? {}
      : { nextRunAt: isoTimestamp(source.nextRunAt, "Stored next run") }),
    ...(source.lastRunAt === undefined
      ? {}
      : { lastRunAt: isoTimestamp(source.lastRunAt, "Stored last run") }),
    ...(source.lastRunId === undefined
      ? {}
      : { lastRunId: requiredUuid(source.lastRunId, "Stored last run") }),
  };
}

function parseStoredRun(value: unknown): InternalRun {
  const source = requiredObject(value, "Stored run");
  const status = source.status;
  const statuses = new Set<InternalRunStatus>([
    "queued",
    "running",
    "succeeded",
    "partial",
    "failed",
    "review-required",
    "canceled",
    "skipped",
  ]);
  if (
    typeof status !== "string" ||
    !statuses.has(status as InternalRunStatus)
  ) {
    throw new Error("invalid run status");
  }
  const trigger = source.trigger;
  if (trigger !== "scheduled" && trigger !== "manual") {
    throw new Error("invalid run trigger");
  }
  const scheduleId = requiredUuid(source.scheduleId, "Stored run schedule");
  const attempts = wholeNumber(source.attempts, "Stored run attempts", 0, 100);
  return {
    id: requiredUuid(source.id, "Stored run"),
    scheduleId,
    scheduleName: safeText(source.scheduleName, "Stored schedule name", 128),
    payload: parsePayload(source.payload),
    trigger,
    status: status as InternalRunStatus,
    scheduledFor: isoTimestamp(source.scheduledFor, "Stored scheduled time"),
    createdAt: isoTimestamp(source.createdAt, "Stored run created time"),
    updatedAt: isoTimestamp(source.updatedAt, "Stored run updated time"),
    attempts,
    ...(source.startedAt === undefined
      ? {}
      : { startedAt: isoTimestamp(source.startedAt, "Stored run start time") }),
    ...(source.completedAt === undefined
      ? {}
      : {
          completedAt: isoTimestamp(
            source.completedAt,
            "Stored run completion time",
          ),
        }),
    ...(source.nextAttemptAt === undefined
      ? {}
      : {
          nextAttemptAt: isoTimestamp(
            source.nextAttemptAt,
            "Stored run retry time",
          ),
        }),
    ...(source.report === undefined
      ? {}
      : { report: parseReport(source.report) }),
    ...(source.errorCode === undefined
      ? {}
      : { errorCode: safeText(source.errorCode, "Stored error code", 128) }),
  };
}

function parseScheduleInput(value: unknown): InternalScheduleInput {
  const source = requiredObject(value, "Schedule");
  return {
    name: safeText(source.name, "Schedule name", 128),
    enabled: requiredBoolean(source.enabled, "Schedule enabled"),
    timing: parseTiming(source.timing),
    payload: parsePayload(source.payload),
  };
}

function parseScheduledListingInput(value: unknown): ScheduledListingInput {
  const source = requiredObject(value, "Scheduled listing");
  return {
    runAt: isoTimestamp(source.runAt, "Scheduled listing time"),
    merchandiseProfileId: profileId(
      source.merchandiseProfileId,
      "Merchandise profile",
    ),
    item: parseListingItem(source.item, "Scheduled listing item"),
  };
}

function parseTiming(value: unknown): InternalScheduleTiming {
  const source = requiredObject(value, "Schedule timing");
  if (source.kind === "once") {
    return { kind: "once", runAt: isoTimestamp(source.runAt, "Run time") };
  }
  if (source.kind === "interval") {
    return {
      kind: "interval",
      everyMinutes: wholeNumber(
        source.everyMinutes,
        "Schedule interval",
        15,
        43_200,
      ),
      anchorAt: isoTimestamp(source.anchorAt, "Schedule interval anchor"),
    };
  }
  if (source.kind === "daily" || source.kind === "weekly") {
    const timeOfDay = safeText(source.timeOfDay, "Schedule time", 5);
    if (!TIME_OF_DAY.test(timeOfDay)) {
      throw new ConfigurationError([
        "Schedule time must use 24-hour HH:mm format.",
      ]);
    }
    const timeZone = safeText(source.timeZone, "Schedule timezone", 128);
    if (!isValidTimeZone(timeZone)) {
      throw new ConfigurationError(["Schedule timezone is invalid."]);
    }
    if (source.kind === "daily") return { kind: "daily", timeOfDay, timeZone };
    const weekdayValues: readonly unknown[] = Array.isArray(source.weekdays)
      ? (source.weekdays as readonly unknown[])
      : [];
    if (
      weekdayValues.length === 0 ||
      weekdayValues.length > 7 ||
      weekdayValues.some(
        (weekday) =>
          typeof weekday !== "number" ||
          !Number.isSafeInteger(weekday) ||
          weekday < 0 ||
          weekday > 6,
      ) ||
      new Set(weekdayValues).size !== weekdayValues.length
    ) {
      throw new ConfigurationError([
        "Weekly schedules require distinct weekdays from 0 through 6.",
      ]);
    }
    return {
      kind: "weekly",
      weekdays: weekdayValues.map(Number).sort(),
      timeOfDay,
      timeZone,
    };
  }
  throw new ConfigurationError(["Schedule timing is unsupported."]);
}

function parsePayload(value: unknown): InternalSchedulePayload {
  const source = requiredObject(value, "Schedule payload");
  if (source.type === "reprice-inventory") {
    if (source.mode !== "review" && source.mode !== "automatic") {
      throw new ConfigurationError([
        "Repricing mode must be review or automatic.",
      ]);
    }
    if (source.scope !== "all") {
      throw new ConfigurationError([
        "Only the complete eligible inventory scope is currently supported.",
      ]);
    }
    return {
      type: "reprice-inventory",
      pricingProfileId: profileId(source.pricingProfileId, "Pricing profile"),
      mode: source.mode,
      scope: "all",
      limits: parseLimits(source.limits),
    };
  }
  if (source.type === "list-inventory") {
    if (
      !Array.isArray(source.items) ||
      source.items.length === 0 ||
      source.items.length > MAXIMUM_LISTING_ITEMS
    ) {
      throw new ConfigurationError([
        `A listing schedule requires 1-${String(MAXIMUM_LISTING_ITEMS)} items.`,
      ]);
    }
    const items = source.items.map((item, index) =>
      parseListingItem(item, `Listing item ${String(index + 1)}`),
    );
    if (
      new Set(items.map((item) => item.productConditionId)).size !==
      items.length
    ) {
      throw new ConfigurationError([
        "A listing schedule cannot repeat the same exact SKU.",
      ]);
    }
    return {
      type: "list-inventory",
      merchandiseProfileId: profileId(
        source.merchandiseProfileId,
        "Merchandise profile",
      ),
      items,
    };
  }
  throw new ConfigurationError(["Internal job type is unsupported."]);
}

function parseLimits(value: unknown): AutomaticRepricingLimits {
  const source = requiredObject(value, "Automatic repricing limits");
  return {
    maximumUpdates: wholeNumber(
      source.maximumUpdates,
      "Maximum updates",
      1,
      10_000,
    ),
    maximumDecreasePercent: finiteNumber(
      source.maximumDecreasePercent,
      "Maximum decrease percent",
      0,
      100,
    ),
    maximumDecreaseAmount: money(
      source.maximumDecreaseAmount,
      "Maximum decrease amount",
    ),
    maximumIncreasePercent: finiteNumber(
      source.maximumIncreasePercent,
      "Maximum increase percent",
      0,
      10_000,
    ),
    maximumBlockedPercent: finiteNumber(
      source.maximumBlockedPercent,
      "Maximum blocked percent",
      0,
      100,
    ),
  };
}

function parseListingItem(value: unknown, label: string): ScheduledListingItem {
  const source = requiredObject(value, label);
  return {
    productId: wholeNumber(
      source.productId,
      `${label} product`,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    productConditionId: wholeNumber(
      source.productConditionId,
      `${label} SKU`,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    productName: safeText(source.productName, `${label} name`, 512),
    quantity: wholeNumber(source.quantity, `${label} quantity`, 1, 10_000_000),
  };
}

function parseReport(value: unknown): InternalRunReport {
  const source = requiredObject(value, "Internal run report");
  if (
    !Array.isArray(source.items) ||
    source.items.length > MAXIMUM_REPORT_ITEMS
  ) {
    throw new ConfigurationError([
      `An internal run report supports at most ${String(MAXIMUM_REPORT_ITEMS)} retained items.`,
    ]);
  }
  return {
    proposed: wholeNumber(source.proposed, "Proposed count", 0, 10_000_000),
    queuedPriceJobs: wholeNumber(
      source.queuedPriceJobs,
      "Queued price-job count",
      0,
      10_000_000,
    ),
    queuedInventoryJobs: wholeNumber(
      source.queuedInventoryJobs,
      "Queued inventory-job count",
      0,
      10_000_000,
    ),
    unchanged: wholeNumber(source.unchanged, "Unchanged count", 0, 10_000_000),
    skipped: wholeNumber(source.skipped, "Skipped count", 0, 10_000_000),
    reviewRequired: wholeNumber(
      source.reviewRequired,
      "Review-required count",
      0,
      10_000_000,
    ),
    truncatedItems: wholeNumber(
      source.truncatedItems,
      "Truncated report count",
      0,
      10_000_000,
    ),
    items: source.items.map(parseReportItem),
  };
}

function parseReportItem(value: unknown): InternalRunReportItem {
  const source = requiredObject(value, "Internal report item");
  const outcome = source.outcome;
  const outcomes = new Set([
    "queued",
    "proposed",
    "unchanged",
    "skipped",
    "review-required",
  ]);
  if (typeof outcome !== "string" || !outcomes.has(outcome)) {
    throw new ConfigurationError(["Internal report outcome is invalid."]);
  }
  return {
    key: safeText(source.key, "Internal report item key", 256),
    productName: safeText(source.productName, "Internal report item name", 512),
    outcome: outcome as InternalRunReportItem["outcome"],
    ...(source.quantity === undefined
      ? {}
      : {
          quantity: wholeNumber(
            source.quantity,
            "Report quantity",
            0,
            10_000_000,
          ),
        }),
    ...(source.currentPrice === undefined
      ? {}
      : {
          currentPrice: money(source.currentPrice, "Report current price", 0),
        }),
    ...(source.proposedPrice === undefined
      ? {}
      : {
          proposedPrice: money(
            source.proposedPrice,
            "Report proposed price",
            0,
          ),
        }),
    ...(source.reason === undefined
      ? {}
      : { reason: safeText(source.reason, "Internal report reason", 1_024) }),
  };
}

function requiredObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  const source = objectValue(value);
  if (source === undefined) {
    throw new ConfigurationError([`${label} must be an object.`]);
  }
  return source;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new ConfigurationError([`${label} must be true or false.`]);
  }
  return value;
}

function profileId(value: unknown, label: string): string {
  const result = safeText(value, label, 64);
  if (!PROFILE_ID.test(result)) {
    throw new ConfigurationError([`${label} is invalid.`]);
  }
  return result;
}

function requiredUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new ConfigurationError([`${label} id is invalid.`]);
  }
  return value;
}

function safeText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    containsControlCharacter(value)
  ) {
    throw new ConfigurationError([
      `${label} must contain 1-${String(maximum)} safe characters.`,
    ]);
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

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new ConfigurationError([`${label} is invalid.`]);
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new ConfigurationError([`${label} must be an ISO timestamp.`]);
  }
  return value;
}

function wholeNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ConfigurationError([
      `${label} must be an integer between ${String(minimum)} and ${String(maximum)}.`,
    ]);
  }
  return value;
}

function finiteNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ConfigurationError([
      `${label} must be between ${String(minimum)} and ${String(maximum)}.`,
    ]);
  }
  return value;
}

function money(value: unknown, label: string, minimum = 0.01): number {
  const result = finiteNumber(value, label, minimum, 1_000_000);
  if (Math.abs(result * 100 - Math.round(result * 100)) > 1e-9) {
    throw new ConfigurationError([`${label} must have at most two decimals.`]);
  }
  return result;
}

function compareOptionalDate(left?: string, right?: string): number {
  if (left === undefined) return right === undefined ? 0 : 1;
  if (right === undefined) return -1;
  return left.localeCompare(right);
}

function scheduleNotFound(): ApplicationError {
  return new ApplicationError(
    "PROVIDER_ERROR",
    "The internal schedule was not found.",
  );
}

function hasCode(value: unknown, code: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    value.code === code
  );
}

function persistenceError(message: string, cause?: unknown): ApplicationError {
  return new ApplicationError("PERSISTENCE_ERROR", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}
