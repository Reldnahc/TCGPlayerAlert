import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import type {
  FulfillmentDocument,
  FulfillmentOrder,
  OrderProvider,
} from "./domain.js";
import { safeErrorCode } from "./errors.js";
import type { Logger } from "./logger.js";
import { safeIdentifier } from "./logger.js";
import { evaluateRules } from "./rules.js";
import type {
  ApplicationState,
  OrderWorkflowStatus,
  PersistedActionState,
  PersistedOrderState,
  StateStore,
} from "./state.js";
import type { WorkflowAction } from "./actions.js";
import { immediateSyncLease, type SyncLease } from "./sync-lease.js";

export type SyncTrigger = "manual" | "scheduled";

export interface SyncOptions {
  readonly processBacklog?: boolean;
  readonly signal?: AbortSignal;
}

export interface SyncRunResult {
  readonly correlationId: string;
  readonly baselineEstablished: boolean;
  readonly discoveredCount: number;
  readonly processedCount: number;
  readonly failedCount: number;
  readonly reviewRequiredCount: number;
}

export interface WorkflowDependencies {
  readonly config: AppConfig;
  readonly provider: OrderProvider;
  readonly stateStore: StateStore;
  readonly actions: Readonly<Record<string, WorkflowAction>>;
  readonly logger: Logger;
  readonly syncLease?: SyncLease;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export class FulfillmentWorkflow {
  private activeRun: Promise<SyncRunResult> | undefined;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly syncLease: SyncLease;

  constructor(private readonly dependencies: WorkflowDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.createId = dependencies.createId ?? randomUUID;
    this.syncLease = dependencies.syncLease ?? immediateSyncLease;
  }

  run(trigger: SyncTrigger, options: SyncOptions = {}): Promise<SyncRunResult> {
    if (this.activeRun !== undefined) {
      this.dependencies.logger.info("sync.coalesced", { trigger });
      return this.activeRun;
    }
    const run = this.syncLease.runExclusive(
      () => this.execute(trigger, options),
      options.signal,
    );
    this.activeRun = run;
    const clear = () => {
      if (this.activeRun === run) this.activeRun = undefined;
    };
    void run.then(clear, clear);
    return run;
  }

  private async execute(
    trigger: SyncTrigger,
    options: SyncOptions,
  ): Promise<SyncRunResult> {
    const correlationId = this.createId();
    const startedAt = this.timestamp();
    let state = await this.dependencies.stateStore.load();
    let discoveredCount = 0;
    let processedCount = 0;
    this.dependencies.logger.info("sync.started", { correlationId, trigger });
    state = {
      ...state,
      lastSync: {
        correlationId,
        trigger,
        startedAt,
        outcome: "running",
        discoveredCount: 0,
        processedCount: 0,
      },
    };
    await this.dependencies.stateStore.save(state);

    try {
      const discovered = await this.dependencies.provider.discoverReadyToShip(
        options.signal,
      );
      discoveredCount = discovered.length;
      const firstSync = state.baselineCompletedAt === undefined;
      if (firstSync && options.processBacklog !== true) {
        const observedAt = this.timestamp();
        const orders = { ...state.orders };
        for (const order of discovered) {
          orders[order.id] = baselineOrder(order.status, observedAt);
        }
        state = {
          ...state,
          baselineCompletedAt: observedAt,
          orders,
          lastSync: completedSync(
            correlationId,
            trigger,
            startedAt,
            observedAt,
            discoveredCount,
            0,
          ),
        };
        await this.dependencies.stateStore.save(state);
        this.dependencies.logger.info("sync.baseline-established", {
          correlationId,
          discoveredCount,
        });
        return resultFromState(correlationId, true, discoveredCount, 0, state);
      }

      const observedAt = this.timestamp();
      const orders = { ...state.orders };
      for (const discoveredOrder of discovered) {
        const existing = orders[discoveredOrder.id];
        orders[discoveredOrder.id] =
          existing === undefined
            ? pendingOrder(discoveredOrder.status, observedAt)
            : {
                ...existing,
                lastSeenAt: observedAt,
                providerStatus: discoveredOrder.status,
              };
      }
      state = {
        ...state,
        ...(firstSync ? { baselineCompletedAt: observedAt } : {}),
        orders,
      };
      await this.dependencies.stateStore.save(state);

      for (const discoveredOrder of discovered) {
        const current = state.orders[discoveredOrder.id];
        if (
          current === undefined ||
          !shouldProcess(
            current.workflowStatus,
            this.dependencies.config.dryRun,
            options.processBacklog === true,
          )
        ) {
          continue;
        }
        state = await this.processOrder(
          state,
          discoveredOrder.id,
          options.signal,
          correlationId,
        );
        processedCount += 1;
      }

      const completedAt = this.timestamp();
      state = {
        ...state,
        lastSync: completedSync(
          correlationId,
          trigger,
          startedAt,
          completedAt,
          discoveredCount,
          processedCount,
        ),
      };
      await this.dependencies.stateStore.save(state);
      const result = resultFromState(
        correlationId,
        false,
        discoveredCount,
        processedCount,
        state,
      );
      this.dependencies.logger.info("sync.completed", { ...result });
      return result;
    } catch (error) {
      const errorCode = safeErrorCode(error);
      state = {
        ...state,
        lastSync: {
          correlationId,
          trigger,
          startedAt,
          completedAt: this.timestamp(),
          outcome: "failed",
          discoveredCount,
          processedCount,
          errorCode,
        },
      };
      await this.dependencies.stateStore.save(state);
      this.dependencies.logger.error("sync.failed", {
        correlationId,
        errorCode,
      });
      throw error;
    }
  }

  private async processOrder(
    state: ApplicationState,
    orderId: string,
    signal: AbortSignal | undefined,
    correlationId: string,
  ): Promise<ApplicationState> {
    let order: FulfillmentOrder;
    try {
      order = await this.dependencies.provider.confirmOrder(orderId, signal);
    } catch (error) {
      const errorCode = safeErrorCode(error);
      this.dependencies.logger.error("order.confirmation-failed", {
        correlationId,
        order: safeIdentifier(orderId),
        errorCode,
      });
      return this.saveOrder(state, orderId, {
        ...requiredOrder(state, orderId),
        workflowStatus: "failed",
        errorCode,
      });
    }
    const evaluations = evaluateRules(order, this.dependencies.config.rules);
    const matched = evaluations.filter((evaluation) => evaluation.matched);
    const actionIds = [
      ...new Set(matched.flatMap((evaluation) => evaluation.actionIds)),
    ];
    const existing = requiredOrder(state, orderId);
    const actions = { ...existing.actions };
    const timestamp = this.timestamp();
    for (const actionId of actionIds) {
      actions[actionId] ??= {
        status: "pending",
        attempts: 0,
        updatedAt: timestamp,
      };
    }
    state = await this.saveOrder(state, orderId, {
      ...withoutOrderError(existing),
      workflowStatus: actionIds.length === 0 ? "completed" : "pending",
      matchedRuleIds: matched.map((evaluation) => evaluation.ruleId),
      ruleReasons: Object.fromEntries(
        evaluations.map((evaluation) => [
          evaluation.ruleId,
          evaluation.reasons,
        ]),
      ),
      actions,
    });
    let packingSlip: FulfillmentDocument | undefined;
    for (const actionId of actionIds) {
      const action = this.dependencies.actions[actionId];
      if (action === undefined) continue;
      const actionState = requiredOrder(state, orderId).actions[actionId];
      if (
        actionState === undefined ||
        actionState.status === "succeeded" ||
        actionState.status === "review-required" ||
        (actionState.status === "dry-run" && this.dependencies.config.dryRun) ||
        (actionState.status === "failed" &&
          actionState.attempts >=
            this.dependencies.config.actionMaximumAttempts)
      ) {
        continue;
      }
      const running: PersistedActionState = {
        status: "running",
        attempts: actionState.attempts + 1,
        updatedAt: this.timestamp(),
      };
      state = await this.saveAction(state, orderId, actionId, running);
      if (this.dependencies.config.dryRun) {
        state = await this.saveAction(state, orderId, actionId, {
          ...running,
          status: "dry-run",
          updatedAt: this.timestamp(),
        });
        continue;
      }
      try {
        if (action.requiresPackingSlip && packingSlip === undefined) {
          packingSlip = await this.dependencies.provider.getPackingSlip(
            orderId,
            signal,
          );
        }
        await action.execute({
          order,
          idempotencyKey: `${this.dependencies.provider.id}:${orderId}:${actionId}`,
          ...(packingSlip === undefined ? {} : { packingSlip }),
          ...(signal === undefined ? {} : { signal }),
        });
        state = await this.saveAction(state, orderId, actionId, {
          ...running,
          status: "succeeded",
          updatedAt: this.timestamp(),
        });
      } catch (error) {
        const errorCode = safeErrorCode(error);
        const status =
          errorCode === "PRINT_AMBIGUOUS" ? "review-required" : "failed";
        state = await this.saveAction(state, orderId, actionId, {
          ...running,
          status,
          updatedAt: this.timestamp(),
          errorCode,
        });
        this.dependencies.logger.error("action.failed", {
          correlationId,
          order: safeIdentifier(orderId),
          actionId,
          errorCode,
        });
      }
    }
    const current = requiredOrder(state, orderId);
    const relevantActions = actionIds
      .map((actionId) => current.actions[actionId])
      .filter((value): value is PersistedActionState => value !== undefined);
    const workflowStatus = statusFromActions(
      relevantActions,
      this.dependencies.config.dryRun,
    );
    return this.saveOrder(state, orderId, {
      ...withoutOrderError(current),
      workflowStatus,
    });
  }

  private async saveAction(
    state: ApplicationState,
    orderId: string,
    actionId: string,
    action: PersistedActionState,
  ): Promise<ApplicationState> {
    const order = requiredOrder(state, orderId);
    return this.saveOrder(state, orderId, {
      ...order,
      actions: { ...order.actions, [actionId]: action },
    });
  }

  private async saveOrder(
    state: ApplicationState,
    orderId: string,
    order: PersistedOrderState,
  ): Promise<ApplicationState> {
    const next = { ...state, orders: { ...state.orders, [orderId]: order } };
    await this.dependencies.stateStore.save(next);
    return next;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function baselineOrder(status: string, timestamp: string): PersistedOrderState {
  return {
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    providerStatus: status,
    workflowStatus: "baseline",
    matchedRuleIds: [],
    ruleReasons: {},
    actions: {},
  };
}

function pendingOrder(status: string, timestamp: string): PersistedOrderState {
  return { ...baselineOrder(status, timestamp), workflowStatus: "pending" };
}

function requiredOrder(
  state: ApplicationState,
  orderId: string,
): PersistedOrderState {
  const order = state.orders[orderId];
  if (order === undefined)
    throw new Error("Workflow invariant: order state is missing.");
  return order;
}

function withoutOrderError(order: PersistedOrderState): PersistedOrderState {
  return {
    firstSeenAt: order.firstSeenAt,
    lastSeenAt: order.lastSeenAt,
    providerStatus: order.providerStatus,
    workflowStatus: order.workflowStatus,
    matchedRuleIds: order.matchedRuleIds,
    ruleReasons: order.ruleReasons,
    actions: order.actions,
  };
}

function shouldProcess(
  status: OrderWorkflowStatus,
  dryRun: boolean,
  processBacklog: boolean,
): boolean {
  if (status === "baseline") return processBacklog;
  if (status === "pending" || status === "failed") return true;
  return status === "dry-run" && !dryRun;
}

function statusFromActions(
  actions: readonly PersistedActionState[],
  dryRun: boolean,
): OrderWorkflowStatus {
  if (actions.some((action) => action.status === "review-required"))
    return "review-required";
  if (
    actions.some(
      (action) =>
        action.status === "failed" ||
        action.status === "pending" ||
        action.status === "running",
    )
  )
    return "failed";
  if (dryRun && actions.some((action) => action.status === "dry-run"))
    return "dry-run";
  return "completed";
}

function completedSync(
  correlationId: string,
  trigger: SyncTrigger,
  startedAt: string,
  completedAt: string,
  discoveredCount: number,
  processedCount: number,
) {
  return {
    correlationId,
    trigger,
    startedAt,
    completedAt,
    outcome: "succeeded" as const,
    discoveredCount,
    processedCount,
  };
}

function resultFromState(
  correlationId: string,
  baselineEstablished: boolean,
  discoveredCount: number,
  processedCount: number,
  state: ApplicationState,
): SyncRunResult {
  const orders = Object.values(state.orders);
  return {
    correlationId,
    baselineEstablished,
    discoveredCount,
    processedCount,
    failedCount: orders.filter((order) => order.workflowStatus === "failed")
      .length,
    reviewRequiredCount: orders.filter(
      (order) => order.workflowStatus === "review-required",
    ).length,
  };
}
