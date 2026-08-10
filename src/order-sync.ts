import { ApplicationError } from "./errors.js";
import type {
  SyncOptions,
  SyncRunResult,
  SyncTrigger,
} from "./orchestrator.js";
import type { ManagedOrderList, ReadyOrderSource } from "./ready-orders.js";

interface SynchronizationWorkflow {
  run(trigger: SyncTrigger, options?: SyncOptions): Promise<SyncRunResult>;
}

export interface OrderSyncCoordinatorOptions {
  readonly readyOrders: ReadyOrderSource;
  readonly createWorkflow:
    (() => SynchronizationWorkflow) | (() => Promise<SynchronizationWorkflow>);
}

export interface ReadyOrderSynchronizationOptions {
  readonly signal?: AbortSignal;
}

export class OrderSyncCoordinator {
  private readonly readyOrders: ReadyOrderSource;
  private readonly createWorkflow: OrderSyncCoordinatorOptions["createWorkflow"];
  private activeSync: Promise<SyncRunResult> | undefined;

  constructor(options: OrderSyncCoordinatorOptions) {
    this.readyOrders = options.readyOrders;
    this.createWorkflow = options.createWorkflow;
  }

  synchronize(
    trigger: SyncTrigger,
    options: SyncOptions = {},
  ): Promise<SyncRunResult> {
    if (this.activeSync !== undefined) return this.activeSync;
    const sync = this.execute(trigger, options);
    this.activeSync = sync;
    const clear = () => {
      if (this.activeSync === sync) this.activeSync = undefined;
    };
    void sync.then(clear, clear);
    return sync;
  }

  listReadyOrders(): ManagedOrderList | undefined {
    return this.readyOrders.snapshot();
  }

  isSynchronizing(): boolean {
    return this.activeSync !== undefined;
  }

  async synchronizeReadyOrders(
    options: ReadyOrderSynchronizationOptions = {},
  ): Promise<ManagedOrderList> {
    await this.synchronize("manual", {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const snapshot = this.readyOrders.snapshot();
    if (snapshot === undefined) {
      throw new ApplicationError(
        "PROVIDER_ERROR",
        "The ready-to-ship synchronization completed without an order snapshot.",
      );
    }
    return snapshot;
  }

  private async execute(
    trigger: SyncTrigger,
    options: SyncOptions,
  ): Promise<SyncRunResult> {
    const workflow = await this.createWorkflow();
    return workflow.run(trigger, options);
  }
}
