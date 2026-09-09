import {
  ORDER_ACTION_IDS,
  type ActionAvailability,
  type AddTrackingCommand,
  type MarkShippedCommand,
  type MutationResult,
  type OrderActionId,
  type OrderLifecycle,
} from "./contracts.js";
import type { ConnectionHealthService } from "./health.js";
import {
  MarketplaceValidationError,
  parseProviderOrderRef,
} from "./identity.js";
import type { MarketplaceConnectionRegistry } from "./registry.js";
import { safeErrorCode } from "../errors.js";

export interface OrderActionPolicyInput {
  readonly lifecycle: OrderLifecycle;
  readonly hasShippingAddress: boolean;
  readonly supported: Readonly<Partial<Record<OrderActionId, boolean>>>;
  /**
   * When present, these are the stable actions allowed by the provider for the
   * current order. This is entity state, not static provider capability.
   */
  readonly providerAllowed?: ReadonlySet<OrderActionId>;
}

export interface OrderQueryInvalidator {
  invalidate(connectionId?: string): void;
}

interface ShipmentAttemptNotification {
  readonly ref: AddTrackingCommand["ref"];
  readonly outcome: MutationResult["outcome"] | "failed";
  readonly errorCode?: string;
}

const READY_ACTIONS = new Set<OrderActionId>(["add-tracking", "mark-shipped"]);

export function resolveOrderActions(
  input: OrderActionPolicyInput,
): Readonly<Record<OrderActionId, ActionAvailability>> {
  return Object.freeze(
    Object.fromEntries(
      ORDER_ACTION_IDS.map((actionId) => [
        actionId,
        resolveAction(actionId, input),
      ]),
    ) as Record<OrderActionId, ActionAvailability>,
  );
}

export class MarketplaceOrderActionService {
  constructor(
    private readonly options: {
      readonly registry: MarketplaceConnectionRegistry;
      readonly health: ConnectionHealthService;
      readonly queries?: OrderQueryInvalidator;
      readonly onOrderRemoved?: (
        ref: AddTrackingCommand["ref"],
      ) => Promise<void>;
      readonly onShipmentAttempt?: (
        attempt: ShipmentAttemptNotification,
      ) => void | Promise<void>;
    },
  ) {}

  async addTracking(
    input: AddTrackingCommand,
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    const ref = parseProviderOrderRef(input.ref);
    await this.assertWritable(ref.connectionId, signal);
    const result = await this.options.registry
      .facet(ref.connectionId, "fulfillment")
      .addTracking({ ref, trackingNumber: input.trackingNumber }, signal);
    this.assertMutationRef(result, ref.connectionId, ref.remoteId);
    this.options.queries?.invalidate(ref.connectionId);
    return result;
  }

  async markShipped(
    input: MarkShippedCommand,
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    const ref = parseProviderOrderRef(input.ref);
    let result: MutationResult;
    try {
      await this.assertWritable(ref.connectionId, signal);
      result = await this.options.registry
        .facet(ref.connectionId, "fulfillment")
        .markShipped({ ref }, signal);
      this.assertMutationRef(result, ref.connectionId, ref.remoteId);
    } catch (error) {
      signal?.throwIfAborted();
      this.notifyShipmentAttempt({
        ref,
        outcome: "failed",
        errorCode: safeErrorCode(error),
      });
      throw error;
    }
    this.options.queries?.invalidate(ref.connectionId);
    try {
      await this.options.onOrderRemoved?.(ref);
    } catch {
      // Local cache/progress cleanup cannot turn an authoritative provider
      // response into a failed mutation or make an unsafe retry possible.
      this.options.queries?.invalidate(ref.connectionId);
    }
    this.notifyShipmentAttempt({ ref, outcome: result.outcome });
    return result;
  }

  private async assertWritable(
    connectionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const health = await this.options.health.check(connectionId, {
      ...(signal === undefined ? {} : { signal }),
    });
    if (health.state !== "connected" && health.state !== "degraded") {
      throw new MarketplaceValidationError(
        "The marketplace connection is unavailable for mutations.",
      );
    }
  }

  private assertMutationRef(
    result: MutationResult,
    connectionId: string,
    remoteId: string,
  ): void {
    const actual = parseProviderOrderRef(result.ref);
    if (actual.connectionId !== connectionId || actual.remoteId !== remoteId) {
      throw new MarketplaceValidationError(
        "The provider returned a mutation for the wrong order.",
      );
    }
  }

  private notifyShipmentAttempt(attempt: ShipmentAttemptNotification): void {
    try {
      void Promise.resolve(this.options.onShipmentAttempt?.(attempt)).catch(
        () => undefined,
      );
    } catch {
      // Notification failure cannot change an authoritative mutation result.
    }
  }
}

function resolveAction(
  actionId: OrderActionId,
  input: OrderActionPolicyInput,
): ActionAvailability {
  if (input.supported[actionId] !== true) {
    return { state: "unavailable", reason: "provider-unsupported" };
  }
  if (
    (actionId === "print-address-label" || actionId === "pirate-ship") &&
    !input.hasShippingAddress
  ) {
    return { state: "unavailable", reason: "missing-data" };
  }
  if (READY_ACTIONS.has(actionId) && input.lifecycle !== "ready-to-ship") {
    return { state: "unavailable", reason: "order-state" };
  }
  if (
    actionId === "refund" &&
    (input.lifecycle === "canceled" || input.lifecycle === "refunded")
  ) {
    return { state: "unavailable", reason: "order-state" };
  }
  if (
    input.providerAllowed !== undefined &&
    (actionId === "add-tracking" ||
      actionId === "mark-shipped" ||
      actionId === "refund") &&
    !input.providerAllowed.has(actionId)
  ) {
    return { state: "unavailable", reason: "order-state" };
  }
  return { state: "available" };
}
