import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import type { FulfillmentDocument, FulfillmentOrder } from "./domain.js";
import { safeErrorCode } from "./errors.js";
import type { OrderDocumentService } from "./fulfillment/documents.js";
import type { Logger } from "./logger.js";
import { safeIdentifier } from "./logger.js";
import type { LocalInventoryService } from "./local-inventory.js";
import {
  parseOrderDetail,
  type OrderDetail,
  type OrderSummary,
  type ProviderIssue,
} from "./marketplaces/contracts.js";
import { orderRefKey, sameOrderRef } from "./marketplaces/identity.js";
import { AggregateOrderQueryError } from "./marketplaces/order-query.js";
import type { QualifiedReadyOrderSource } from "./shipment-scanner.js";
import type { MarketplaceConnectionRegistry } from "./marketplaces/registry.js";
import { evaluateRules } from "./rules.js";
import type {
  ApplicationState,
  ConnectionSyncSummaryState,
  OrderWorkflowStatus,
  PersistedActionState,
  PersistedOrderState,
  StateStore,
  SyncOutcome,
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
  readonly outcome: Exclude<SyncOutcome, "running">;
  readonly baselineEstablished: boolean;
  readonly discoveredCount: number;
  readonly processedCount: number;
  readonly failedCount: number;
  readonly reviewRequiredCount: number;
  readonly issues: readonly ProviderIssue[];
  readonly connections: Readonly<Record<string, ConnectionSyncSummaryState>>;
}

export interface WorkflowDependencies {
  readonly config: AppConfig | (() => AppConfig | Promise<AppConfig>);
  readonly registry: MarketplaceConnectionRegistry;
  readonly readyOrders: QualifiedReadyOrderSource;
  readonly stateStore: StateStore;
  readonly actions:
    | Readonly<Record<string, WorkflowAction>>
    | ((config: AppConfig) => Readonly<Record<string, WorkflowAction>>);
  readonly documents: OrderDocumentService;
  readonly localInventory?: Pick<LocalInventoryService, "deductSale">;
  readonly logger: Logger;
  readonly syncLease?: SyncLease;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

/** Provider-neutral synchronization, reconciliation, rules, and actions. */
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

  isSynchronizing(): boolean {
    return this.activeRun !== undefined;
  }

  private async execute(
    trigger: SyncTrigger,
    options: SyncOptions,
  ): Promise<SyncRunResult> {
    const config = await this.configuration();
    const actions =
      typeof this.dependencies.actions === "function"
        ? this.dependencies.actions(config)
        : this.dependencies.actions;
    const correlationId = this.createId();
    const startedAt = this.timestamp();
    const writer = new WorkflowStateWriter(
      await this.dependencies.stateStore.load(),
      this.dependencies.stateStore,
    );
    const eligibleConnectionIds = this.dependencies.registry
      .list()
      .filter((connection) => connection.facets.orderPages !== undefined)
      .map((connection) => connection.descriptor.connectionId);
    await writer.update((state) => ({
      ...state,
      lastSync: {
        correlationId,
        trigger,
        startedAt,
        outcome: "running",
        discoveredCount: 0,
        processedCount: 0,
        connections: Object.fromEntries(
          eligibleConnectionIds.map((connectionId) => [
            connectionId,
            {
              outcome: "running",
              discoveredCount: 0,
              processedCount: 0,
            },
          ]),
        ),
      },
    }));
    this.dependencies.logger.info("sync.started", { correlationId, trigger });

    let snapshot;
    try {
      snapshot = await this.dependencies.readyOrders.refresh(options.signal);
    } catch (error) {
      options.signal?.throwIfAborted();
      const issues =
        error instanceof AggregateOrderQueryError ? error.issues : [];
      const connectionStates = Object.fromEntries(
        eligibleConnectionIds.map((connectionId) => {
          const issue = issues.find(
            (candidate) => candidate.connectionId === connectionId,
          );
          return [
            connectionId,
            {
              outcome: "failed" as const,
              discoveredCount: 0,
              processedCount: 0,
              errorCode: issue?.code ?? safeErrorCode(error),
            },
          ];
        }),
      );
      await this.completeState(writer, {
        correlationId,
        trigger,
        startedAt,
        outcome: "failed",
        discoveredCount: 0,
        processedCount: 0,
        connections: connectionStates,
        errorCode:
          error instanceof AggregateOrderQueryError
            ? error.code
            : safeErrorCode(error),
      });
      this.dependencies.logger.error("sync.failed", {
        correlationId,
        errorCode: safeErrorCode(error),
      });
      throw error;
    }

    const ordersByConnection = new Map<string, OrderSummary[]>();
    for (const order of snapshot.orders) {
      const values = ordersByConnection.get(order.ref.connectionId) ?? [];
      values.push(order);
      ordersByConnection.set(order.ref.connectionId, values);
    }
    const successfulIds = new Set(snapshot.successfulConnectionIds);
    const failedConnections = Object.fromEntries(
      snapshot.issues.map((issue) => [
        issue.connectionId,
        {
          outcome: "failed" as const,
          discoveredCount: 0,
          processedCount: 0,
          errorCode: issue.code,
        },
      ]),
    );
    const connectionResults = await Promise.all(
      [...successfulIds].map((connectionId) =>
        this.processConnection(
          writer,
          connectionId,
          ordersByConnection.get(connectionId) ?? [],
          actions,
          config,
          options,
          correlationId,
        ),
      ),
    );
    const connections = {
      ...failedConnections,
      ...Object.fromEntries(
        connectionResults.map((result) => [result.connectionId, result.state]),
      ),
    };
    const issues = [
      ...snapshot.issues,
      ...connectionResults.flatMap((result) => result.issues),
    ];
    const discoveredCount = connectionResults.reduce(
      (total, result) => total + result.state.discoveredCount,
      0,
    );
    const processedCount = connectionResults.reduce(
      (total, result) => total + result.state.processedCount,
      0,
    );
    const baselineEstablished = connectionResults.some(
      (result) => result.baselineEstablished,
    );
    const outcome: "succeeded" | "partial" =
      issues.length > 0 ||
      Object.values(connections).some((state) => state.outcome !== "succeeded")
        ? "partial"
        : "succeeded";
    await this.completeState(writer, {
      correlationId,
      trigger,
      startedAt,
      outcome,
      discoveredCount,
      processedCount,
      connections,
    });
    const state = await writer.read();
    const result = resultFromState({
      correlationId,
      outcome,
      baselineEstablished,
      discoveredCount,
      processedCount,
      issues,
      connections,
      state,
    });
    this.dependencies.logger.info("sync.completed", {
      correlationId,
      outcome,
      discoveredCount,
      processedCount,
      issueCount: issues.length,
    });
    return result;
  }

  private async processConnection(
    writer: WorkflowStateWriter,
    connectionId: string,
    discovered: readonly OrderSummary[],
    actions: Readonly<Record<string, WorkflowAction>>,
    config: AppConfig,
    options: SyncOptions,
    correlationId: string,
  ): Promise<{
    readonly connectionId: string;
    readonly state: ConnectionSyncSummaryState;
    readonly issues: readonly ProviderIssue[];
    readonly baselineEstablished: boolean;
  }> {
    const current = await writer.read();
    const firstSync = current.baselines[connectionId] === undefined;
    const observedAt = this.timestamp();
    await writer.update((state) => {
      const orders = { ...state.orders };
      for (const order of discovered) {
        const key = orderRefKey(order.ref);
        const existing = orders[key];
        orders[key] =
          existing === undefined
            ? firstSync && options.processBacklog !== true
              ? baselineOrder(order.providerStatus, observedAt)
              : pendingOrder(order.providerStatus, observedAt)
            : {
                ...existing,
                lastSeenAt: observedAt,
                providerStatus: order.providerStatus,
              };
      }
      return {
        ...state,
        baselines: { ...state.baselines, [connectionId]: observedAt },
        orders,
      };
    });
    if (firstSync && options.processBacklog !== true) {
      this.dependencies.logger.info("sync.baseline-established", {
        correlationId,
        connectionId,
        discoveredCount: discovered.length,
      });
      return {
        connectionId,
        state: {
          outcome: "succeeded",
          discoveredCount: discovered.length,
          processedCount: 0,
        },
        issues: [],
        baselineEstablished: true,
      };
    }

    let processedCount = 0;
    const issues: ProviderIssue[] = [];
    for (const summary of discovered) {
      const state = await writer.read();
      const key = orderRefKey(summary.ref);
      const order = state.orders[key];
      if (
        order === undefined ||
        !shouldProcess(order.workflowStatus, options.processBacklog === true)
      ) {
        continue;
      }
      const issue = await this.processOrder(
        writer,
        summary,
        actions,
        config,
        options.signal,
        correlationId,
      );
      processedCount += 1;
      if (issue !== undefined) issues.push(issue);
    }
    return {
      connectionId,
      state: {
        outcome: issues.length === 0 ? "succeeded" : "partial",
        discoveredCount: discovered.length,
        processedCount,
        ...(issues[0] === undefined ? {} : { errorCode: issues[0].code }),
      },
      issues,
      baselineEstablished: false,
    };
  }

  private async processOrder(
    writer: WorkflowStateWriter,
    summary: OrderSummary,
    actionsById: Readonly<Record<string, WorkflowAction>>,
    config: AppConfig,
    signal: AbortSignal | undefined,
    correlationId: string,
  ): Promise<ProviderIssue | undefined> {
    const ref = summary.ref;
    const key = orderRefKey(ref);
    let detail: OrderDetail;
    try {
      const reader = this.dependencies.registry.facet(
        ref.connectionId,
        "orderDetails",
      );
      detail = parseOrderDetail(await reader.getOrder(ref, signal));
      if (!sameOrderRef(detail.ref, ref)) throw new Error("wrong order detail");
    } catch (error) {
      signal?.throwIfAborted();
      const errorCode = safeErrorCode(error);
      this.dependencies.logger.error("order.confirmation-failed", {
        correlationId,
        order: safeIdentifier(key),
        errorCode,
      });
      await writer.update((state) => ({
        ...state,
        orders: {
          ...state.orders,
          [key]: {
            ...requiredOrder(state, key),
            workflowStatus: "failed",
            errorCode,
          },
        },
      }));
      return {
        connectionId: ref.connectionId,
        operation: "get-order",
        code: "ORDER_DETAIL_FAILED",
        retryable: true,
      };
    }

    try {
      const deduction = await this.dependencies.localInventory?.deductSale({
        ref: detail.ref,
        lines: detail.lines,
      });
      if (
        deduction !== undefined &&
        deduction.outcome !== "tracking-disabled"
      ) {
        this.dependencies.logger.info("local-inventory.sale-deducted", {
          correlationId,
          order: safeIdentifier(key),
          outcome: deduction.outcome,
          requestedQuantity: deduction.requestedQuantity,
          deductedQuantity: deduction.deductedQuantity,
          unmatchedQuantity: deduction.unmatchedQuantity,
          shortageQuantity: deduction.shortageQuantity,
        });
      }
    } catch (error) {
      signal?.throwIfAborted();
      const errorCode = safeErrorCode(error);
      this.dependencies.logger.error("local-inventory.sale-deduction-failed", {
        correlationId,
        order: safeIdentifier(key),
        errorCode,
      });
      await writer.update((state) => ({
        ...state,
        orders: {
          ...state.orders,
          [key]: {
            ...requiredOrder(state, key),
            workflowStatus: "failed",
            errorCode,
          },
        },
      }));
      return {
        connectionId: ref.connectionId,
        operation: "local-inventory",
        code: "LOCAL_INVENTORY_DEDUCTION_FAILED",
        retryable: true,
      };
    }

    const order = workflowOrder(detail, summary);
    const evaluations = evaluateRules(order, config.rules);
    const matched = evaluations.filter((evaluation) => evaluation.matched);
    const actionIds = [
      ...new Set(matched.flatMap((evaluation) => evaluation.actionIds)),
    ].filter((actionId) => actionsById[actionId] !== undefined);
    const timestamp = this.timestamp();
    await writer.update((state) => {
      const existing = requiredOrder(state, key);
      const actions = { ...existing.actions };
      for (const actionId of actionIds) {
        actions[actionId] ??= {
          status: "pending",
          attempts: 0,
          updatedAt: timestamp,
        };
      }
      return {
        ...state,
        orders: {
          ...state.orders,
          [key]: {
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
          },
        },
      };
    });

    let packingSlip: FulfillmentDocument | undefined;
    for (const actionId of actionIds) {
      const action = actionsById[actionId];
      if (action === undefined) continue;
      const state = await writer.read();
      const actionState = requiredOrder(state, key).actions[actionId];
      if (
        actionState === undefined ||
        actionState.status === "succeeded" ||
        actionState.status === "review-required" ||
        (actionState.status === "failed" &&
          actionState.attempts >= config.actionMaximumAttempts)
      ) {
        continue;
      }
      const running: PersistedActionState = {
        status: "running",
        attempts: actionState.attempts + 1,
        updatedAt: this.timestamp(),
      };
      await saveAction(writer, key, actionId, running);
      try {
        if (action.requiresPackingSlip && packingSlip === undefined) {
          const document = await this.dependencies.documents.getPackingSlip(
            ref,
            signal,
          );
          packingSlip = {
            kind: "packing-slip",
            mediaType: "application/pdf",
            fileName: document.fileName,
            bytes: document.bytes,
          };
        }
        await action.execute({
          order,
          idempotencyKey: `${key}:${actionId}`,
          ...(packingSlip === undefined ? {} : { packingSlip }),
          ...(signal === undefined ? {} : { signal }),
        });
        await saveAction(writer, key, actionId, {
          ...running,
          status: "succeeded",
          updatedAt: this.timestamp(),
        });
      } catch (error) {
        signal?.throwIfAborted();
        const errorCode = safeErrorCode(error);
        const status =
          errorCode === "PRINT_AMBIGUOUS" ? "review-required" : "failed";
        await saveAction(writer, key, actionId, {
          ...running,
          status,
          updatedAt: this.timestamp(),
          errorCode,
        });
        this.dependencies.logger.error("action.failed", {
          correlationId,
          order: safeIdentifier(key),
          actionId,
          errorCode,
        });
      }
    }
    await writer.update((state) => {
      const current = requiredOrder(state, key);
      const relevantActions = actionIds
        .map((actionId) => current.actions[actionId])
        .filter((value): value is PersistedActionState => value !== undefined);
      return {
        ...state,
        orders: {
          ...state.orders,
          [key]: {
            ...withoutOrderError(current),
            workflowStatus: statusFromActions(relevantActions),
          },
        },
      };
    });
    return undefined;
  }

  private completeState(
    writer: WorkflowStateWriter,
    summary: Omit<NonNullable<ApplicationState["lastSync"]>, "completedAt">,
  ): Promise<ApplicationState> {
    return writer.update((state) => ({
      ...state,
      lastSync: { ...summary, completedAt: this.timestamp() },
    }));
  }

  private configuration(): Promise<AppConfig> {
    return Promise.resolve(
      typeof this.dependencies.config === "function"
        ? this.dependencies.config()
        : this.dependencies.config,
    );
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

class WorkflowStateWriter {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private state: ApplicationState,
    private readonly store: StateStore,
  ) {}

  async read(): Promise<ApplicationState> {
    await this.tail;
    return this.state;
  }

  update(
    transform: (state: ApplicationState) => ApplicationState,
  ): Promise<ApplicationState> {
    let result: ApplicationState | undefined;
    const operation = async () => {
      const next = transform(this.state);
      await this.store.save(next);
      this.state = next;
      result = next;
    };
    this.tail = this.tail.then(operation, operation);
    return this.tail.then(() => {
      if (result === undefined) throw new Error("Workflow state write failed.");
      return result;
    });
  }
}

function workflowOrder(
  detail: OrderDetail,
  summary: OrderSummary,
): FulfillmentOrder {
  return {
    ref: detail.ref,
    provider: detail.ref.connectionId,
    id: detail.ref.remoteId,
    placedAt: detail.createdAt,
    status: detail.providerStatusCode ?? detail.providerStatus,
    channel: detail.orderChannel ?? summary.orderChannel ?? "",
    fulfillment: detail.orderFulfillment ?? summary.orderFulfillment ?? "",
    shippingType: detail.shippingMethod,
    totalAmount: detail.totals.total.minorUnits / 100,
    buyerPaid: detail.buyerPaid ?? summary.buyerPaid ?? false,
    shippingAddress: detail.shippingAddress,
    items: detail.lines.map((line) => ({
      name: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice.minorUnits / 100,
    })),
  };
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
  key: string,
): PersistedOrderState {
  const order = state.orders[key];
  if (order === undefined) {
    throw new Error("Workflow invariant: order state is missing.");
  }
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
  processBacklog: boolean,
): boolean {
  if (status === "baseline") return processBacklog;
  return status === "pending" || status === "failed";
}

function statusFromActions(
  actions: readonly PersistedActionState[],
): OrderWorkflowStatus {
  if (actions.some((action) => action.status === "review-required")) {
    return "review-required";
  }
  if (
    actions.some(
      (action) =>
        action.status === "failed" ||
        action.status === "pending" ||
        action.status === "running",
    )
  ) {
    return "failed";
  }
  return "completed";
}

function saveAction(
  writer: WorkflowStateWriter,
  key: string,
  actionId: string,
  action: PersistedActionState,
): Promise<ApplicationState> {
  return writer.update((state) => {
    const order = requiredOrder(state, key);
    return {
      ...state,
      orders: {
        ...state.orders,
        [key]: {
          ...order,
          actions: { ...order.actions, [actionId]: action },
        },
      },
    };
  });
}

function resultFromState(input: {
  readonly correlationId: string;
  readonly outcome: "succeeded" | "partial";
  readonly baselineEstablished: boolean;
  readonly discoveredCount: number;
  readonly processedCount: number;
  readonly issues: readonly ProviderIssue[];
  readonly connections: Readonly<Record<string, ConnectionSyncSummaryState>>;
  readonly state: ApplicationState;
}): SyncRunResult {
  const orders = Object.values(input.state.orders);
  return {
    correlationId: input.correlationId,
    outcome: input.outcome,
    baselineEstablished: input.baselineEstablished,
    discoveredCount: input.discoveredCount,
    processedCount: input.processedCount,
    failedCount: orders.filter((order) => order.workflowStatus === "failed")
      .length,
    reviewRequiredCount: orders.filter(
      (order) => order.workflowStatus === "review-required",
    ).length,
    issues: input.issues,
    connections: input.connections,
  };
}
