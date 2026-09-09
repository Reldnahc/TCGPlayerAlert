import type {
  ManaPoolSellerClient,
  SellerOrderDetail,
  SellerOrderFulfillment,
} from "manapool-seller-api";
import type {
  AddTrackingCommand,
  FulfillmentMutator,
  MarkShippedCommand,
  MutationResult,
} from "../../marketplaces/contracts.js";
import {
  MarketplaceValidationError,
  parseConnectionId,
  parseProviderOrderRef,
} from "../../marketplaces/identity.js";
import { assertManaPoolConnection } from "./normalization.js";

type FulfillmentClient = Pick<
  ManaPoolSellerClient,
  "getSellerOrder" | "updateSellerOrderFulfillment"
>;

export class ManaPoolFulfillmentMutator implements FulfillmentMutator {
  private readonly connectionId: string;

  constructor(
    private readonly client: FulfillmentClient,
    connectionId: string,
  ) {
    this.connectionId = parseConnectionId(connectionId);
  }

  async addTracking(
    input: AddTrackingCommand,
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    const ref = parseProviderOrderRef(input.ref);
    assertManaPoolConnection(this.connectionId, ref.connectionId);
    const trackingNumber = requiredText(input.trackingNumber, 256);
    const current = await this.getOrder(ref.remoteId, signal);
    const latest = current.fulfillments.at(-1);
    await this.client.updateSellerOrderFulfillment(
      {
        orderId: ref.remoteId,
        status: current.latestFulfillmentStatus ?? "processing",
        trackingNumber,
        ...preservedFulfillment(latest, ["trackingCompany", "trackingUrl"]),
      },
      signal === undefined ? undefined : { signal },
    );
    return { ref, outcome: "applied" };
  }

  async markShipped(
    input: MarkShippedCommand,
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    const ref = parseProviderOrderRef(input.ref);
    assertManaPoolConnection(this.connectionId, ref.connectionId);
    const current = await this.getOrder(ref.remoteId, signal);
    if (
      current.latestFulfillmentStatus === "shipped" ||
      current.latestFulfillmentStatus === "delivered"
    ) {
      return { ref, outcome: "already-applied" };
    }
    await this.client.updateSellerOrderFulfillment(
      {
        orderId: ref.remoteId,
        status: "shipped",
        ...preservedFulfillment(current.fulfillments.at(-1), [
          "trackingCompany",
          "trackingNumber",
          "trackingUrl",
        ]),
      },
      signal === undefined ? undefined : { signal },
    );
    return { ref, outcome: "applied" };
  }

  private async getOrder(
    remoteId: string,
    signal?: AbortSignal,
  ): Promise<SellerOrderDetail> {
    const detail = await this.client.getSellerOrder(
      remoteId,
      signal === undefined ? undefined : { signal },
    );
    if (detail.id !== remoteId) {
      throw new MarketplaceValidationError(
        "ManaPool returned detail for the wrong order.",
      );
    }
    return detail;
  }
}

function preservedFulfillment<
  K extends "trackingCompany" | "trackingNumber" | "trackingUrl",
>(
  fulfillment: SellerOrderFulfillment | undefined,
  keys: readonly K[],
): Partial<Pick<SellerOrderFulfillment, K>> {
  if (fulfillment === undefined) return {};
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = fulfillment[key];
      return value === null ? [] : [[key, value]];
    }),
  ) as Partial<Pick<SellerOrderFulfillment, K>>;
}

function requiredText(value: string, maximum: number): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    Array.from(normalized).length > maximum ||
    /\p{Cc}/u.test(normalized)
  ) {
    throw new MarketplaceValidationError("The tracking number is invalid.");
  }
  return normalized;
}
