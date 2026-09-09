import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  OrderDocumentService,
  OrderPrintService,
  projectDocumentActions,
} from "../src/fulfillment/documents.js";
import {
  createPackingSlipRenderModel,
  renderLocalPackingSlip,
} from "../src/fulfillment/packing-slip.js";
import {
  MarketplaceConnectionRegistry,
  ProviderAdapterRegistry,
  environmentSecretAccess,
} from "../src/marketplaces/registry.js";
import type { PrintJob, Printer } from "../src/printing.js";
import { appConfig } from "./fixtures.js";
import { marketplaceOrderDetail } from "./marketplace-ui-fixtures.js";
import {
  syntheticFactory,
  type SyntheticFactoryControls,
} from "./synthetic-marketplace.js";

const NATIVE_BYTES = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");

describe("provider-neutral order documents", () => {
  it("renders a deterministic local packing slip from normalized detail", async () => {
    const detail = marketplaceOrderDetail({
      connectionId: "local-main",
      remoteId: "LOCAL/100",
      displayOrderNumber: "LOCAL 100",
      description: "Synthetic café カード",
    });
    const model = createPackingSlipRenderModel(detail, "Local store");

    const rendered = await renderLocalPackingSlip(model);
    const pdf = await PDFDocument.load(rendered.bytes);

    expect(rendered).toMatchObject({
      ref: detail.ref,
      kind: "packing-slip",
      mediaType: "application/pdf",
      fileName: "packing-slip-LOCAL-100.pdf",
    });
    expect(pdf.getTitle()).toBe("Packing slip LOCAL 100");
    expect(pdf.getSubject()).toBe(
      "Application-generated marketplace packing slip",
    );
    expect(pdf.getPageCount()).toBeGreaterThan(0);
    expect(model.totals).not.toHaveProperty("tax");
  });

  it("preserves Unicode input and paginates large local packing slips", async () => {
    const base = marketplaceOrderDetail({
      connectionId: "local-main",
      remoteId: "LOCAL-UNICODE",
      displayOrderNumber: "LOCAL-UNICODE",
      buyerName: "Zoë 山田",
      description: "Café カード",
    });
    const [sourceLine] = base.lines;
    if (sourceLine === undefined)
      throw new Error("The fixture needs one line.");
    const detail = {
      ...base,
      lines: Array.from({ length: 80 }, (_, index) => ({
        ...sourceLine,
        lineKey: `${base.ref.remoteId}:line-${String(index + 1)}`,
        description:
          index === 0
            ? `Café カード ${"unbroken".repeat(40)}`
            : `Café カード ${String(index + 1)}`,
      })),
    };

    const rendered = await renderLocalPackingSlip(
      createPackingSlipRenderModel(detail, "Boutique Montréal"),
    );
    const pdf = await PDFDocument.load(rendered.bytes);

    expect(pdf.getPageCount()).toBeGreaterThan(1);
  });

  it("uses an exact native document without loading detail", async () => {
    const ref = { connectionId: "native-main", remoteId: "NATIVE-1" };
    const nativeDocument = {
      ref,
      kind: "packing-slip" as const,
      mediaType: "application/pdf",
      fileName: "native.pdf",
      bytes: NATIVE_BYTES,
    };
    const fixture = runtimeFixture({ nativeDocument });

    await expect(fixture.documents.getPackingSlip(ref)).resolves.toStrictEqual(
      nativeDocument,
    );
    expect(fixture.observation.nativeDocumentRemoteIds).toEqual(["NATIVE-1"]);
    expect(fixture.observation.detailRemoteIds).toEqual([]);
  });

  it("falls back locally only when native documents are absent or explicitly unsupported", async () => {
    const withoutNative = runtimeFixture();
    const unsupported = runtimeFixture({
      nativeDocument: { outcome: "unsupported" },
    });

    const [local, fallback] = await Promise.all([
      withoutNative.documents.getPackingSlip(withoutNative.ref),
      unsupported.documents.getPackingSlip(unsupported.ref),
    ]);

    expect(local.mediaType).toBe("application/pdf");
    expect(fallback.mediaType).toBe("application/pdf");
    expect(withoutNative.observation.detailRemoteIds).toEqual(["ORDER-1"]);
    expect(unsupported.observation.detailRemoteIds).toEqual(["ORDER-1"]);
  });

  it("does not hide native failures or wrong-order documents with a local fallback", async () => {
    const failed = runtimeFixture({
      nativeDocument: new Error("synthetic private provider failure"),
    });
    const wrong = runtimeFixture({
      nativeDocument: {
        ref: { connectionId: "native-main", remoteId: "WRONG" },
        kind: "packing-slip",
        mediaType: "application/pdf",
        fileName: "wrong.pdf",
        bytes: NATIVE_BYTES,
      },
    });
    const malformed = runtimeFixture({
      nativeDocument: {
        ref: { connectionId: "native-main", remoteId: "ORDER-1" },
        kind: "packing-slip",
        mediaType: "application/pdf",
        fileName: "malformed.pdf",
        bytes: new TextEncoder().encode("not a PDF"),
      },
    });

    await expect(failed.documents.getPackingSlip(failed.ref)).rejects.toThrow(
      "synthetic private provider failure",
    );
    await expect(wrong.documents.getPackingSlip(wrong.ref)).rejects.toThrow(
      "wrong order",
    );
    await expect(
      malformed.documents.getPackingSlip(malformed.ref),
    ).rejects.toThrow("invalid packing-slip document");
    expect(failed.observation.detailRemoteIds).toEqual([]);
    expect(wrong.observation.detailRemoteIds).toEqual([]);
    expect(malformed.observation.detailRemoteIds).toEqual([]);
  });

  it("prints both application document types through the same normalized service", async () => {
    const fixture = runtimeFixture();
    const submitted: PrintJob[] = [];
    const printer: Printer = {
      acceptedMediaTypes: new Set([
        "application/pdf",
        "application/vnd.tcgplayer-alert.address-label+json",
      ]),
      submit(job) {
        submitted.push(job);
        return Promise.resolve();
      },
    };
    const config = appConfig({
      printers: {
        synthetic: {
          adapter: "windows-native-label",
          printerName: "Synthetic printer",
          timeoutSeconds: 10,
        },
      },
      actions: {
        label: {
          type: "print-address-label",
          enabled: false,
          printer: "synthetic",
          page: { widthMm: 89, heightMm: 28, marginMm: 3, fontSize: 12 },
          lines: [
            "{recipientName}",
            "{addressOne}",
            "{addressTwo}",
            "{city}, {territory} {postalCode}",
          ],
        },
        slip: {
          type: "print-packing-slip",
          enabled: false,
          printer: "synthetic",
        },
      },
    });
    const printing = new OrderPrintService({
      documents: fixture.documents,
      configuration: () => Promise.resolve(config),
      createPrinter: () => printer,
    });

    await printing.print(fixture.ref, "print-address-label");
    await printing.print(fixture.ref, "print-packing-slip");

    expect(submitted).toHaveLength(2);
    expect(submitted[0]).toMatchObject({
      mediaType: "application/vnd.tcgplayer-alert.address-label+json",
      lines: [
        "Synthetic Buyer",
        "125 Example Avenue",
        "Unit 4",
        "Test City, IL 60000",
      ],
    });
    expect(submitted[1]).toMatchObject({ mediaType: "application/pdf" });
  });

  it("projects local document actions from application configuration", () => {
    const fixture = runtimeFixture();
    const connection = fixture.registry.get(fixture.ref.connectionId);
    if (connection === undefined) throw new Error("Connection is missing.");
    const detail = marketplaceOrderDetail({
      connectionId: fixture.ref.connectionId,
      remoteId: fixture.ref.remoteId,
    });

    const unconfigured = projectDocumentActions(detail, connection.facets, {
      addressLabelConfigured: false,
    });
    const configured = projectDocumentActions(detail, connection.facets, {
      addressLabelConfigured: true,
    });

    expect(unconfigured.actions["packing-slip"]).toEqual({
      state: "available",
    });
    expect(unconfigured.actions["print-address-label"]).toEqual({
      state: "unavailable",
      reason: "configuration-required",
    });
    expect(configured.actions["print-address-label"]).toEqual({
      state: "available",
    });
  });
});

function runtimeFixture(
  options: {
    readonly nativeDocument?: SyntheticFactoryControls["nativeDocument"];
  } = {},
) {
  const ref = { connectionId: "native-main", remoteId: "ORDER-1" };
  const detail = marketplaceOrderDetail({
    connectionId: ref.connectionId,
    remoteId: ref.remoteId,
  });
  const provider = syntheticFactory("native-provider", "Native Provider", {
    detail,
    ...(options.nativeDocument === undefined
      ? {}
      : { nativeDocument: options.nativeDocument }),
  });
  const registry = new MarketplaceConnectionRegistry({
    adapters: new ProviderAdapterRegistry([provider.factory]),
    connections: {
      [ref.connectionId]: {
        providerId: "native-provider",
        enabled: true,
        label: "Synthetic connection",
        settings: { fixture: "documents" },
      },
    },
    secrets: environmentSecretAccess({}),
  });
  return {
    ref,
    registry,
    documents: new OrderDocumentService(registry),
    observation: provider.observation,
  };
}
