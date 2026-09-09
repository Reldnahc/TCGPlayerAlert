import type { TcgplayerSellerClient } from "tcgplayer-private-api";
import {
  type AddTrackingCommand,
  type FulfillmentMutator,
  type MarkShippedCommand,
  type MutationResult,
} from "../../marketplaces/contracts.js";
import {
  MarketplaceValidationError,
  parseConnectionId,
  parseProviderOrderRef,
} from "../../marketplaces/identity.js";
import { assertTcgplayerOrderConnection } from "./normalization.js";

type FulfillmentClient = Pick<
  TcgplayerSellerClient,
  "detectCarrier" | "addOrderTracking" | "shipOrderWithoutTracking"
>;

export class TcgplayerFulfillmentMutator implements FulfillmentMutator {
  private readonly connectionId: string;

  constructor(
    private readonly client: FulfillmentClient,
    connectionId: string,
    private readonly sellerKey: () => string,
  ) {
    this.connectionId = parseConnectionId(connectionId);
  }

  async addTracking(
    input: AddTrackingCommand,
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    const ref = parseProviderOrderRef(input.ref);
    assertTcgplayerOrderConnection(this.connectionId, ref.connectionId);
    const trackingNumber = requiredText(
      input.trackingNumber,
      "tracking number",
      256,
    );
    const options = signal === undefined ? undefined : { signal };
    const detected = await this.client.detectCarrier(trackingNumber, options);
    const carrier = requiredText(detected.carrier, "carrier", 128);
    const result = await this.client.addOrderTracking(
      {
        sellerKey: requiredText(this.sellerKey(), "seller credential", 256),
        orderNumber: ref.remoteId,
        carrier,
        trackingNumber,
      },
      options,
    );
    if (result.orderNumber !== ref.remoteId) {
      throw wrongMutationOrder();
    }
    return { ref, outcome: result.outcome };
  }

  async markShipped(
    input: MarkShippedCommand,
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    const ref = parseProviderOrderRef(input.ref);
    assertTcgplayerOrderConnection(this.connectionId, ref.connectionId);
    const result = await this.client.shipOrderWithoutTracking(
      {
        sellerKey: requiredText(this.sellerKey(), "seller credential", 256),
        orderNumber: ref.remoteId,
      },
      signal === undefined ? undefined : { signal },
    );
    if (result.orderNumber !== ref.remoteId) {
      throw wrongMutationOrder();
    }
    return { ref, outcome: result.outcome };
  }
}

function requiredText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    Array.from(normalized).length > maximum ||
    /\p{Cc}/u.test(normalized)
  ) {
    throw new MarketplaceValidationError(`The ${label} is invalid.`);
  }
  return normalized;
}

function wrongMutationOrder(): MarketplaceValidationError {
  return new MarketplaceValidationError(
    "TCGplayer returned a mutation for the wrong order.",
  );
}
