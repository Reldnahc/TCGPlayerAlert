import type { TcgplayerSellerClient } from "tcgplayer-private-api";
import {
  type NativeDocumentRequest,
  type NativeOrderDocumentSource,
  type NormalizedFulfillmentDocument,
} from "../../marketplaces/contracts.js";
import {
  MarketplaceValidationError,
  parseConnectionId,
  parseProviderOrderRef,
} from "../../marketplaces/identity.js";
import { assertTcgplayerOrderConnection } from "./normalization.js";

type DocumentClient = Pick<TcgplayerSellerClient, "getPackingSlip">;

export class TcgplayerNativeOrderDocumentSource implements NativeOrderDocumentSource {
  private readonly connectionId: string;

  constructor(
    private readonly client: DocumentClient,
    connectionId: string,
    private readonly timezoneOffsetMinutes: number,
  ) {
    this.connectionId = parseConnectionId(connectionId);
    if (
      !Number.isSafeInteger(timezoneOffsetMinutes) ||
      timezoneOffsetMinutes < -14 * 60 ||
      timezoneOffsetMinutes > 14 * 60
    ) {
      throw new MarketplaceValidationError(
        "The document timezone offset is invalid.",
      );
    }
  }

  async getDocument(
    input: NativeDocumentRequest,
    signal?: AbortSignal,
  ): Promise<NormalizedFulfillmentDocument> {
    const ref = parseProviderOrderRef(input.ref);
    assertTcgplayerOrderConnection(this.connectionId, ref.connectionId);
    const document = await this.client.getPackingSlip(
      {
        orderNumber: ref.remoteId,
        timezoneOffsetMinutes: this.timezoneOffsetMinutes,
      },
      signal === undefined ? undefined : { signal },
    );
    if (
      document.bytes.length === 0 ||
      document.orderNumbers.length !== 1 ||
      document.orderNumbers[0] !== ref.remoteId
    ) {
      throw new MarketplaceValidationError(
        "TCGplayer returned an invalid packing-slip document.",
      );
    }
    return {
      ref,
      kind: "packing-slip",
      mediaType: document.contentType,
      fileName: requiredFileName(document.fileName),
      bytes: document.bytes,
    };
  }
}

function requiredFileName(value: string): string {
  if (
    value.trim().length === 0 ||
    Array.from(value).length > 256 ||
    /[\\/\p{Cc}]/u.test(value)
  ) {
    throw new MarketplaceValidationError(
      "TCGplayer returned an invalid document file name.",
    );
  }
  return value;
}
