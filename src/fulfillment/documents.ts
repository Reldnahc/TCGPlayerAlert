import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { ConfigurationError } from "../errors.js";
import {
  parseOrderDetail,
  type ActionAvailability,
  type NativeDocumentResult,
  type NormalizedFulfillmentDocument,
  type OrderSummary,
} from "../marketplaces/contracts.js";
import {
  MarketplaceValidationError,
  orderRefKey,
  parseProviderOrderRef,
  type ProviderOrderRef,
} from "../marketplaces/identity.js";
import type {
  MarketplaceConnectionRegistry,
  MarketplaceFacets,
} from "../marketplaces/registry.js";
import { createPrinter, type Printer } from "../printing.js";
import { executeAddressLabelAddress } from "../actions.js";
import {
  createAddressLabelRenderModel,
  createPackingSlipRenderModel,
  renderLocalPackingSlip,
  type AddressLabelRenderModel,
} from "./packing-slip.js";

export type ManualOrderPrintActionType =
  "print-address-label" | "print-packing-slip";

export function projectDocumentActions(
  order: OrderSummary,
  facets: Pick<MarketplaceFacets, "orderDetails" | "nativeDocuments">,
  options: { readonly addressLabelConfigured: boolean },
): OrderSummary {
  const hasDetails = facets.orderDetails !== undefined;
  const hasNativeDocuments = facets.nativeDocuments !== undefined;
  const available: ActionAvailability = { state: "available" };
  const unsupported: ActionAvailability = {
    state: "unavailable",
    reason: "provider-unsupported",
  };
  const configurationRequired: ActionAvailability = {
    state: "unavailable",
    reason: "configuration-required",
  };
  return {
    ...order,
    actions: Object.freeze({
      ...order.actions,
      "view-detail": hasDetails ? available : unsupported,
      "print-address-label": !hasDetails
        ? unsupported
        : options.addressLabelConfigured
          ? available
          : configurationRequired,
      "packing-slip":
        hasDetails || hasNativeDocuments ? available : unsupported,
      "pirate-ship": hasDetails ? available : unsupported,
    }),
  };
}

export class OrderDocumentService {
  constructor(private readonly registry: MarketplaceConnectionRegistry) {}

  async getPackingSlip(
    input: ProviderOrderRef,
    signal?: AbortSignal,
  ): Promise<NormalizedFulfillmentDocument> {
    const ref = parseProviderOrderRef(input);
    const connection = this.requireConnection(ref.connectionId);
    const native = connection.facets.nativeDocuments;
    if (native !== undefined) {
      const result: NativeDocumentResult = await native.getDocument(
        { ref, kind: "packing-slip" },
        signal,
      );
      if (!("outcome" in result)) {
        return validateDocument(result, ref);
      }
    }
    const detailReader = connection.facets.orderDetails;
    if (detailReader === undefined) {
      throw new MarketplaceValidationError(
        "The connection cannot provide order detail for a local document.",
      );
    }
    const detail = parseOrderDetail(await detailReader.getOrder(ref, signal));
    assertExactRef(detail.ref, ref);
    return renderLocalPackingSlip(
      createPackingSlipRenderModel(
        detail,
        connection.descriptor.connectionLabel,
      ),
    );
  }

  async getAddressLabel(
    input: ProviderOrderRef,
    signal?: AbortSignal,
  ): Promise<AddressLabelRenderModel> {
    const ref = parseProviderOrderRef(input);
    const detailReader = this.requireConnection(ref.connectionId).facets
      .orderDetails;
    if (detailReader === undefined) {
      throw new MarketplaceValidationError(
        "The connection cannot provide an address for this order.",
      );
    }
    const detail = parseOrderDetail(await detailReader.getOrder(ref, signal));
    assertExactRef(detail.ref, ref);
    return createAddressLabelRenderModel(detail);
  }

  private requireConnection(connectionId: string) {
    const connection = this.registry.get(connectionId);
    if (connection === undefined) {
      throw new MarketplaceValidationError(
        "The marketplace connection is unknown or disabled.",
      );
    }
    return connection;
  }
}

export class OrderPrintService {
  constructor(
    private readonly options: {
      readonly documents: OrderDocumentService;
      readonly configuration: () => Promise<AppConfig>;
      readonly createPrinter?: typeof createPrinter;
    },
  ) {}

  async print(
    input: ProviderOrderRef,
    actionType: ManualOrderPrintActionType,
    signal?: AbortSignal,
  ): Promise<void> {
    const ref = parseProviderOrderRef(input);
    const config = await this.options.configuration();
    const selected = Object.entries(config.actions).find(
      ([, action]) => action.type === actionType,
    );
    if (selected === undefined) {
      throw new ConfigurationError([
        `No ${actionType === "print-address-label" ? "address-label" : "packing-slip"} action is configured.`,
      ]);
    }
    const [actionId, action] = selected;
    const printerConfig = config.printers[action.printer];
    if (printerConfig === undefined) {
      throw new ConfigurationError([
        "The configured order printer is unavailable.",
      ]);
    }
    const printer: Printer = (this.options.createPrinter ?? createPrinter)(
      printerConfig,
      config.spoolDirectory,
    );
    const idempotencyKey = `manual-order-print:${orderRefKey(ref)}:${actionId}:${randomUUID()}`;
    if (actionType === "print-address-label") {
      if (action.type !== "print-address-label") {
        throw new ConfigurationError([
          "The configured address-label action has an invalid type.",
        ]);
      }
      const model = await this.options.documents.getAddressLabel(ref, signal);
      await executeAddressLabelAddress(
        action,
        printer,
        model.address,
        idempotencyKey,
        signal,
      );
      return;
    }
    const document = await this.options.documents.getPackingSlip(ref, signal);
    if (!printer.acceptedMediaTypes.has("application/pdf")) {
      throw new ConfigurationError([
        "The configured printer cannot print a packing slip.",
      ]);
    }
    await printer.submit(
      {
        idempotencyKey,
        jobName: `packing-slip-${safeJobPart(ref.remoteId)}`,
        mediaType: "application/pdf",
        bytes: document.bytes,
      },
      signal,
    );
  }
}

function validateDocument(
  document: unknown,
  expected: ProviderOrderRef,
): NormalizedFulfillmentDocument {
  const value = objectValue(document);
  const ref = parseProviderOrderRef(value?.ref);
  assertExactRef(ref, expected);
  const bytes = value?.bytes;
  const fileName = value?.fileName;
  if (
    value?.kind !== "packing-slip" ||
    value.mediaType !== "application/pdf" ||
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 5 ||
    bytes.byteLength > 50 * 1024 * 1024 ||
    new TextDecoder("ascii").decode(bytes.subarray(0, 5)) !== "%PDF-" ||
    typeof fileName !== "string" ||
    fileName.trim() === "" ||
    Array.from(fileName).length > 256 ||
    /[\\/";\p{Cc}]/u.test(fileName)
  ) {
    throw new MarketplaceValidationError(
      "The provider returned an invalid packing-slip document.",
    );
  }
  return {
    ref,
    kind: "packing-slip",
    mediaType: "application/pdf",
    fileName,
    bytes,
  };
}

function assertExactRef(
  actual: ProviderOrderRef,
  expected: ProviderOrderRef,
): void {
  const parsed = parseProviderOrderRef(actual);
  if (
    parsed.connectionId !== expected.connectionId ||
    parsed.remoteId !== expected.remoteId
  ) {
    throw new MarketplaceValidationError(
      "The provider returned data for the wrong order.",
    );
  }
}

function safeJobPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 80) || "order";
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
