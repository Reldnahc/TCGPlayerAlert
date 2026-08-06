import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ApplicationError } from "./errors.js";

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

export interface SyncSummaryState {
  readonly correlationId: string;
  readonly trigger: "manual" | "scheduled";
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly outcome: "running" | "succeeded" | "failed";
  readonly discoveredCount: number;
  readonly processedCount: number;
  readonly errorCode?: string;
}

export interface ApplicationState {
  readonly version: 1;
  readonly baselineCompletedAt?: string;
  readonly orders: Readonly<Record<string, PersistedOrderState>>;
  readonly lastSync?: SyncSummaryState;
}

export function emptyState(): ApplicationState {
  return { version: 1, orders: {} };
}

function isState(value: unknown): value is ApplicationState {
  if (!isRecord(value) || value.version !== 1) return false;
  if (!optionalTimestamp(value.baselineCompletedAt)) return false;
  if (!isRecord(value.orders)) return false;
  if (!Object.values(value.orders).every(isOrderState)) return false;
  return value.lastSync === undefined || isSyncState(value.lastSync);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function optionalTimestamp(value: unknown): boolean {
  return value === undefined || isTimestamp(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
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

function isActionState(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.status === "string" &&
    ACTION_STATUSES.has(value.status as ActionStatus) &&
    Number.isInteger(value.attempts) &&
    Number(value.attempts) >= 0 &&
    isTimestamp(value.updatedAt) &&
    (value.errorCode === undefined || typeof value.errorCode === "string")
  );
}

function isOrderState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    !isTimestamp(value.firstSeenAt) ||
    !isTimestamp(value.lastSeenAt) ||
    typeof value.providerStatus !== "string" ||
    typeof value.workflowStatus !== "string" ||
    !WORKFLOW_STATUSES.has(value.workflowStatus as OrderWorkflowStatus) ||
    !isStringArray(value.matchedRuleIds) ||
    !isRecord(value.ruleReasons) ||
    !Object.values(value.ruleReasons).every(isStringArray) ||
    !isRecord(value.actions) ||
    !Object.values(value.actions).every(isActionState) ||
    (value.errorCode !== undefined && typeof value.errorCode !== "string")
  ) {
    return false;
  }
  return true;
}

function isSyncState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const trigger = value.trigger;
  const outcome = value.outcome;
  return (
    typeof value.correlationId === "string" &&
    (trigger === "manual" || trigger === "scheduled") &&
    isTimestamp(value.startedAt) &&
    optionalTimestamp(value.completedAt) &&
    (outcome === "running" ||
      outcome === "succeeded" ||
      outcome === "failed") &&
    Number.isInteger(value.discoveredCount) &&
    Number(value.discoveredCount) >= 0 &&
    Number.isInteger(value.processedCount) &&
    Number(value.processedCount) >= 0 &&
    (value.errorCode === undefined || typeof value.errorCode === "string")
  );
}

export interface StateStore {
  load(): Promise<ApplicationState>;
  save(state: ApplicationState): Promise<void>;
}

export class JsonStateStore implements StateStore {
  private readonly absolutePath: string;

  constructor(path: string) {
    this.absolutePath = resolve(path);
  }

  async load(): Promise<ApplicationState> {
    try {
      const value = migrateLegacyDryRunState(
        JSON.parse(await readFile(this.absolutePath, "utf8")) as unknown,
      );
      if (!isState(value)) {
        throw new ApplicationError(
          "PERSISTENCE_ERROR",
          "The workflow state schema is unsupported.",
        );
      }
      return recoverInterruptedActions(value);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return emptyState();
      }
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        "PERSISTENCE_ERROR",
        "Unable to read the workflow state.",
        { cause: error },
      );
    }
  }

  async save(state: ApplicationState): Promise<void> {
    const directory = dirname(this.absolutePath);
    const temporaryPath = `${this.absolutePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
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

function migrateLegacyDryRunState(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.orders)) return value;
  const orders = Object.fromEntries(
    Object.entries(value.orders).map(([orderId, order]) => {
      if (!isRecord(order) || !isRecord(order.actions)) return [orderId, order];
      const actions = Object.fromEntries(
        Object.entries(order.actions).map(([actionId, action]) => {
          if (!isRecord(action) || action.status !== "dry-run") {
            return [actionId, action];
          }
          return [actionId, { ...action, status: "pending" }];
        }),
      );
      let workflowStatus = order.workflowStatus;
      if (workflowStatus === "dry-run") {
        workflowStatus = "pending";
      }
      return [
        orderId,
        {
          ...order,
          workflowStatus,
          actions,
        },
      ];
    }),
  );
  return { ...value, orders };
}

export function recoverInterruptedActions(
  state: ApplicationState,
): ApplicationState {
  const orders = Object.fromEntries(
    Object.entries(state.orders).map(([orderId, order]) => {
      const actions = Object.fromEntries(
        Object.entries(order.actions).map(([actionId, action]) => {
          if (action.status !== "running") return [actionId, action];
          return [
            actionId,
            {
              ...action,
              status: "review-required" as const,
              errorCode: "INTERRUPTED_DURING_SIDE_EFFECT",
            },
          ];
        }),
      );
      const hasReview = Object.values(actions).some(
        (action) => action.status === "review-required",
      );
      return [
        orderId,
        hasReview
          ? { ...order, workflowStatus: "review-required" as const, actions }
          : order,
      ];
    }),
  );
  return { ...state, orders };
}
