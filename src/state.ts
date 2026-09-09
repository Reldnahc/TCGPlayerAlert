import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ApplicationError } from "./errors.js";
import {
  orderRefKey,
  parseConnectionId,
  parseOrderRefKey,
  parseRemoteId,
} from "./marketplaces/identity.js";

const MAXIMUM_WORKFLOW_ORDERS = 100_000;
const MAXIMUM_CONNECTIONS = 1_000;

export type ActionStatus =
  "pending" | "running" | "succeeded" | "failed" | "review-required";

export interface PersistedActionState {
  readonly status: ActionStatus;
  readonly attempts: number;
  readonly updatedAt: string;
  readonly errorCode?: string;
}

export type OrderWorkflowStatus =
  "baseline" | "pending" | "completed" | "failed" | "review-required";

export interface PersistedOrderState {
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly providerStatus: string;
  readonly workflowStatus: OrderWorkflowStatus;
  readonly matchedRuleIds: readonly string[];
  readonly ruleReasons: Readonly<Record<string, readonly string[]>>;
  readonly actions: Readonly<Record<string, PersistedActionState>>;
  readonly errorCode?: string;
}

export type SyncOutcome = "running" | "succeeded" | "partial" | "failed";

export interface ConnectionSyncSummaryState {
  readonly outcome: SyncOutcome;
  readonly discoveredCount: number;
  readonly processedCount: number;
  readonly errorCode?: string;
}

export interface SyncSummaryState {
  readonly correlationId: string;
  readonly trigger: "manual" | "scheduled";
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly outcome: SyncOutcome;
  readonly discoveredCount: number;
  readonly processedCount: number;
  readonly connections: Readonly<Record<string, ConnectionSyncSummaryState>>;
  readonly errorCode?: string;
}

/** Order keys are canonical `orderRefKey` values; baselines are per connection. */
export interface ApplicationState {
  readonly version: 2;
  readonly baselines: Readonly<Record<string, string>>;
  readonly orders: Readonly<Record<string, PersistedOrderState>>;
  readonly lastSync?: SyncSummaryState;
}

export function emptyState(): ApplicationState {
  return { version: 2, baselines: {}, orders: {} };
}

export interface StateStore {
  load(): Promise<ApplicationState>;
  save(state: ApplicationState): Promise<void>;
}

export class JsonStateStore implements StateStore {
  private readonly absolutePath: string;
  private readonly legacyConnectionId: string | undefined;

  constructor(
    path: string,
    options: { readonly legacyConnectionId?: string } = {},
  ) {
    this.absolutePath = resolve(path);
    this.legacyConnectionId =
      options.legacyConnectionId === undefined
        ? undefined
        : parseConnectionId(options.legacyConnectionId);
  }

  async load(): Promise<ApplicationState> {
    try {
      const state = parseApplicationState(
        JSON.parse(await readFile(this.absolutePath, "utf8")) as unknown,
        this.legacyConnectionId,
      );
      return recoverInterruptedActions(state);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return emptyState();
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        "PERSISTENCE_ERROR",
        "Unable to read the workflow state.",
        { cause: error },
      );
    }
  }

  async save(state: ApplicationState): Promise<void> {
    const validated = parseVersionTwoState(state);
    const directory = dirname(this.absolutePath);
    const temporaryPath = `${this.absolutePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(
        temporaryPath,
        `${JSON.stringify(validated, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      await rename(temporaryPath, this.absolutePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw new ApplicationError(
        "PERSISTENCE_ERROR",
        "Unable to persist workflow state atomically.",
        { cause: error },
      );
    }
  }
}

function parseApplicationState(
  value: unknown,
  legacyConnectionId?: string,
): ApplicationState {
  if (!isRecord(value)) throw invalidState();
  if (value.version === 1) {
    if (legacyConnectionId === undefined) throw invalidState();
    return migrateVersionOneState(value, legacyConnectionId);
  }
  if (value.version === 2) return parseVersionTwoState(value);
  throw invalidState();
}

function parseVersionTwoState(value: unknown): ApplicationState {
  if (!isRecord(value) || value.version !== 2) throw invalidState();
  const baselines = parseBaselines(value.baselines);
  const orders = parseOrders(value.orders, true);
  const lastSync =
    value.lastSync === undefined ? undefined : parseSyncState(value.lastSync);
  return {
    version: 2,
    baselines,
    orders,
    ...(lastSync === undefined ? {} : { lastSync }),
  };
}

function migrateVersionOneState(
  value: Record<string, unknown>,
  legacyConnectionId: string,
): ApplicationState {
  if (!optionalTimestamp(value.baselineCompletedAt)) throw invalidState();
  const legacyOrders = parseOrders(value.orders, false);
  const orders = Object.fromEntries(
    Object.entries(legacyOrders).map(([remoteId, order]) => [
      orderRefKey({
        connectionId: legacyConnectionId,
        remoteId: parseRemoteId(remoteId),
      }),
      order,
    ]),
  );
  const legacySync =
    value.lastSync === undefined
      ? undefined
      : parseLegacySyncState(value.lastSync);
  const baseline = value.baselineCompletedAt;
  const baselines =
    typeof baseline === "string" ? { [legacyConnectionId]: baseline } : {};
  return {
    version: 2,
    baselines,
    orders,
    ...(legacySync === undefined
      ? {}
      : {
          lastSync: {
            ...legacySync,
            connections: {
              [legacyConnectionId]: {
                outcome: legacySync.outcome,
                discoveredCount: legacySync.discoveredCount,
                processedCount: legacySync.processedCount,
                ...(legacySync.errorCode === undefined
                  ? {}
                  : { errorCode: legacySync.errorCode }),
              },
            },
          },
        }),
  };
}

function parseBaselines(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) throw invalidState();
  const entries = Object.entries(value);
  if (entries.length > MAXIMUM_CONNECTIONS) throw invalidState();
  const result: Record<string, string> = {};
  for (const [connectionId, completedAt] of entries) {
    try {
      parseConnectionId(connectionId);
    } catch {
      throw invalidState();
    }
    if (!isTimestamp(completedAt)) throw invalidState();
    result[connectionId] = completedAt;
  }
  return result;
}

function parseOrders(
  value: unknown,
  qualified: boolean,
): Readonly<Record<string, PersistedOrderState>> {
  if (!isRecord(value)) throw invalidState();
  const entries = Object.entries(value);
  if (entries.length > MAXIMUM_WORKFLOW_ORDERS) throw invalidState();
  const result: Record<string, PersistedOrderState> = {};
  for (const [key, raw] of entries) {
    try {
      if (qualified) parseOrderRefKey(key);
      else parseRemoteId(key);
    } catch {
      throw invalidState();
    }
    result[key] = parseOrderState(raw);
  }
  return result;
}

function parseOrderState(value: unknown): PersistedOrderState {
  if (!isRecord(value)) throw invalidState();
  const workflowStatus =
    value.workflowStatus === "dry-run" ? "pending" : value.workflowStatus;
  if (
    !isTimestamp(value.firstSeenAt) ||
    !isTimestamp(value.lastSeenAt) ||
    !safeText(value.providerStatus, 256) ||
    typeof workflowStatus !== "string" ||
    !WORKFLOW_STATUSES.has(workflowStatus as OrderWorkflowStatus) ||
    !isStringArray(value.matchedRuleIds, 1_000, 128) ||
    !isRecord(value.ruleReasons) ||
    Object.keys(value.ruleReasons).length > 1_000 ||
    !Object.values(value.ruleReasons).every((entry) =>
      isStringArray(entry, 1_000, 512),
    ) ||
    !isRecord(value.actions) ||
    Object.keys(value.actions).length > 1_000 ||
    !safeOptionalCode(value.errorCode)
  ) {
    throw invalidState();
  }
  const actions = Object.fromEntries(
    Object.entries(value.actions).map(([actionId, action]) => [
      actionId,
      parseActionState(actionId, action),
    ]),
  );
  return {
    firstSeenAt: value.firstSeenAt,
    lastSeenAt: value.lastSeenAt,
    providerStatus: value.providerStatus,
    workflowStatus: workflowStatus as OrderWorkflowStatus,
    matchedRuleIds: value.matchedRuleIds,
    ruleReasons: value.ruleReasons as Readonly<
      Record<string, readonly string[]>
    >,
    actions,
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode }),
  };
}

function parseActionState(
  actionId: string,
  value: unknown,
): PersistedActionState {
  if (!safeText(actionId, 128) || !isRecord(value)) throw invalidState();
  const status = value.status === "dry-run" ? "pending" : value.status;
  if (
    typeof status !== "string" ||
    !ACTION_STATUSES.has(status as ActionStatus) ||
    !Number.isSafeInteger(value.attempts) ||
    Number(value.attempts) < 0 ||
    !isTimestamp(value.updatedAt) ||
    !safeOptionalCode(value.errorCode)
  ) {
    throw invalidState();
  }
  return {
    status: status as ActionStatus,
    attempts: Number(value.attempts),
    updatedAt: value.updatedAt,
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode }),
  };
}

function parseSyncState(value: unknown): SyncSummaryState {
  const common = parseSyncCommon(value, true);
  const source = value as Record<string, unknown>;
  if (!isRecord(source.connections)) throw invalidState();
  const entries = Object.entries(source.connections);
  if (entries.length > MAXIMUM_CONNECTIONS) throw invalidState();
  const connections: Record<string, ConnectionSyncSummaryState> = {};
  for (const [connectionId, entry] of entries) {
    try {
      parseConnectionId(connectionId);
    } catch {
      throw invalidState();
    }
    connections[connectionId] = parseConnectionSyncState(entry);
  }
  return { ...common, connections };
}

function parseLegacySyncState(
  value: unknown,
): Omit<SyncSummaryState, "connections"> {
  return parseSyncCommon(value, false);
}

function parseSyncCommon(
  value: unknown,
  allowPartial: boolean,
): Omit<SyncSummaryState, "connections"> {
  if (!isRecord(value)) throw invalidState();
  const outcome = value.outcome;
  if (
    !safeText(value.correlationId, 128) ||
    (value.trigger !== "manual" && value.trigger !== "scheduled") ||
    !isTimestamp(value.startedAt) ||
    !optionalTimestamp(value.completedAt) ||
    (outcome !== "running" &&
      outcome !== "succeeded" &&
      outcome !== "failed" &&
      !(allowPartial && outcome === "partial")) ||
    !nonNegativeInteger(value.discoveredCount) ||
    !nonNegativeInteger(value.processedCount) ||
    !safeOptionalCode(value.errorCode)
  ) {
    throw invalidState();
  }
  return {
    correlationId: value.correlationId,
    trigger: value.trigger,
    startedAt: value.startedAt,
    ...(typeof value.completedAt === "string"
      ? { completedAt: value.completedAt }
      : {}),
    outcome,
    discoveredCount: value.discoveredCount,
    processedCount: value.processedCount,
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode }),
  };
}

function parseConnectionSyncState(value: unknown): ConnectionSyncSummaryState {
  if (!isRecord(value)) throw invalidState();
  if (
    value.outcome !== "running" &&
    value.outcome !== "succeeded" &&
    value.outcome !== "partial" &&
    value.outcome !== "failed"
  ) {
    throw invalidState();
  }
  if (
    !nonNegativeInteger(value.discoveredCount) ||
    !nonNegativeInteger(value.processedCount) ||
    !safeOptionalCode(value.errorCode)
  ) {
    throw invalidState();
  }
  return {
    outcome: value.outcome,
    discoveredCount: value.discoveredCount,
    processedCount: value.processedCount,
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode }),
  };
}

export function recoverInterruptedActions(
  state: ApplicationState,
): ApplicationState {
  const orders = Object.fromEntries(
    Object.entries(state.orders).map(([key, order]) => {
      const actions = Object.fromEntries(
        Object.entries(order.actions).map(([actionId, action]) => [
          actionId,
          action.status === "running"
            ? {
                ...action,
                status: "review-required" as const,
                errorCode: "INTERRUPTED_DURING_SIDE_EFFECT",
              }
            : action,
        ]),
      );
      const hasReview = Object.values(actions).some(
        (action) => action.status === "review-required",
      );
      return [
        key,
        hasReview
          ? { ...order, workflowStatus: "review-required" as const, actions }
          : { ...order, actions },
      ];
    }),
  );
  return { ...state, orders };
}

const ACTION_STATUSES = new Set<ActionStatus>([
  "pending",
  "running",
  "succeeded",
  "failed",
  "review-required",
]);
const WORKFLOW_STATUSES = new Set<OrderWorkflowStatus>([
  "baseline",
  "pending",
  "completed",
  "failed",
  "review-required",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function optionalTimestamp(value: unknown): boolean {
  return value === undefined || isTimestamp(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isStringArray(
  value: unknown,
  maximumEntries: number,
  maximumLength: number,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximumEntries &&
    value.every((entry) => safeText(entry, maximumLength))
  );
}

function safeOptionalCode(value: unknown): value is string | undefined {
  return value === undefined || safeText(value, 128);
}

function safeText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !/\p{Cc}/u.test(value) &&
    value !== "__proto__" &&
    value !== "constructor" &&
    value !== "prototype"
  );
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function invalidState(): ApplicationError {
  return new ApplicationError(
    "PERSISTENCE_ERROR",
    "The workflow state schema is unsupported or unsafe.",
  );
}
