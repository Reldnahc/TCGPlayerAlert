import { describe, expect, it } from "vitest";
import {
  createActions,
  executeConfiguredAddressLabel,
  executeConfiguredSyntheticPrintTest,
  renderAddressLabel,
  shipmentTagId,
  type PrintJob,
  type Printer,
} from "../src/index.js";
import { appConfig, syntheticOrder } from "./fixtures.js";

describe("address-label action", () => {
  it("does not instantiate disabled print actions", () => {
    const actions = createActions(
      appConfig({
        actions: {
          label: {
            type: "print-address-label",
            enabled: false,
            printer: "synthetic",
            page: { widthMm: 89, heightMm: 36, marginMm: 3, fontSize: 9 },
            lines: ["{recipientName}"],
          },
        },
      }),
      {},
    );

    expect(actions).toEqual({});
  });

  it("renders a valid PDF using a configurable label size and template", async () => {
    const bytes = await renderAddressLabel(syntheticOrder, {
      type: "print-address-label",
      printer: "synthetic",
      page: { widthMm: 89, heightMm: 36, marginMm: 3, fontSize: 9 },
      lines: [
        "{recipientName}",
        "{addressOne}",
        "{addressTwo}",
        "{city}, {territory} {postalCode}",
      ],
    });

    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(bytes.byteLength).toBeGreaterThan(500);
  });

  it("uses structured label media when the printer supports native labels", async () => {
    const submitted: PrintJob[] = [];
    const printer: Printer = {
      acceptedMediaTypes: new Set([
        "application/vnd.tcgplayer-alert.address-label+json",
      ]),
      submit: (job) => {
        submitted.push(job);
        return Promise.resolve();
      },
    };
    const labelConfig = {
      type: "print-address-label" as const,
      printer: "synthetic",
      page: { widthMm: 89, heightMm: 36, marginMm: 3, fontSize: 9 },
      lines: ["{recipientName}", "{addressOne}", "{addressTwo}", "{country}"],
      omitLineValues: ["US", "USA"],
    };
    const action = createActions(
      appConfig({ actions: { label: labelConfig } }),
      { synthetic: printer },
    ).label;
    if (action === undefined) throw new Error("Synthetic action is missing.");

    await action.execute({
      order: syntheticOrder,
      idempotencyKey: "synthetic:order:label",
    });

    expect(submitted[0]).toMatchObject({
      mediaType: "application/vnd.tcgplayer-alert.address-label+json",
      lines: ["Example Recipient", "123 Example Street", "Unit 4"],
    });
    expect(submitted[0]).not.toHaveProperty("fiducialMarker");

    await action.execute({
      order: {
        ...syntheticOrder,
        shippingAddress: {
          ...syntheticOrder.shippingAddress,
          country: "Canada",
        },
      },
      idempotencyKey: "synthetic:international-order:label",
    });
    expect(submitted[1]).toMatchObject({
      lines: ["Example Recipient", "123 Example Street", "Unit 4", "Canada"],
    });
  });

  it("adds the stable shipment tag to order labels only when scanning is enabled", async () => {
    const submitted: PrintJob[] = [];
    const printer: Printer = {
      acceptedMediaTypes: new Set([
        "application/vnd.tcgplayer-alert.address-label+json",
      ]),
      submit: (job) => {
        submitted.push(job);
        return Promise.resolve();
      },
    };
    const config = appConfig({
      shipmentScanner: {
        enabled: true,
        automaticallyMarkShipped: false,
        soundEnabled: true,
        camera: { enabled: false, deviceId: "" },
        stateFile: ".data/test-shipment-scans.json",
      },
      actions: {
        label: {
          type: "print-address-label",
          printer: "synthetic",
          page: { widthMm: 89, heightMm: 36, marginMm: 3, fontSize: 9 },
          lines: ["{recipientName}", "{addressOne}"],
        },
      },
    });
    const action = createActions(
      config,
      { synthetic: printer },
      {
        shipmentTags: {
          assign: (orderNumber) => Promise.resolve(shipmentTagId(orderNumber)),
        },
      },
    ).label;
    if (action === undefined) throw new Error("Synthetic action is missing.");

    await action.execute({
      order: syntheticOrder,
      idempotencyKey: "synthetic:shipment-tag",
    });

    expect(submitted[0]).toMatchObject({
      fiducialMarker: {
        family: "APRILTAG_36h11",
        tagId: shipmentTagId(syntheticOrder.id),
      },
    });
  });

  it("never adds a production shipment identity to a printer test label", async () => {
    const submitted: PrintJob[] = [];
    const printer: Printer = {
      acceptedMediaTypes: new Set([
        "application/vnd.tcgplayer-alert.address-label+json",
      ]),
      submit: (job) => {
        submitted.push(job);
        return Promise.resolve();
      },
    };
    const config = appConfig({
      shipmentScanner: {
        enabled: true,
        automaticallyMarkShipped: true,
        soundEnabled: true,
        camera: { enabled: false, deviceId: "" },
        stateFile: ".data/test-shipment-scans.json",
      },
      actions: {
        label: {
          type: "print-address-label",
          printer: "synthetic",
          page: { widthMm: 89, heightMm: 36, marginMm: 3, fontSize: 9 },
          lines: ["{recipientName}"],
        },
      },
    });

    await executeConfiguredSyntheticPrintTest(config, "label", {
      synthetic: printer,
    });

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).not.toHaveProperty("fiducialMarker");
  });

  it("prints pasted lines with the configured layout and country omission", async () => {
    const submitted: PrintJob[] = [];
    const printer: Printer = {
      acceptedMediaTypes: new Set([
        "application/vnd.tcgplayer-alert.address-label+json",
      ]),
      submit: (job) => {
        submitted.push(job);
        return Promise.resolve();
      },
    };
    const config = appConfig({
      actions: {
        label: {
          type: "print-address-label",
          enabled: false,
          printer: "synthetic",
          page: { widthMm: 89, heightMm: 28, marginMm: 3, fontSize: 14 },
          lines: ["{recipientName}"],
          omitLineValues: ["US", "USA"],
        },
      },
    });

    await executeConfiguredAddressLabel(
      config,
      [
        " Example Recipient ",
        "123 Example Street",
        "Example City, IL 00000",
        "USA",
      ],
      { printers: { synthetic: printer } },
    );

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      mediaType: "application/vnd.tcgplayer-alert.address-label+json",
      page: { widthMm: 89, heightMm: 28, marginMm: 3, fontSize: 14 },
      lines: [
        "Example Recipient",
        "123 Example Street",
        "Example City, IL 00000",
      ],
    });
  });

  it("can explicitly test an output that is disabled for automation", async () => {
    const submitted: PrintJob[] = [];
    const printer: Printer = {
      acceptedMediaTypes: new Set(["application/pdf"]),
      submit: (job) => {
        submitted.push(job);
        return Promise.resolve();
      },
    };
    const config = appConfig({
      printers: {
        synthetic: {
          adapter: "windows-pdf",
          printerName: "Synthetic Printer",
          timeoutSeconds: 30,
          dpi: 150,
          scale: "fit",
        },
      },
      actions: {
        packing: {
          type: "print-packing-slip",
          enabled: false,
          printer: "synthetic",
        },
      },
    });

    await executeConfiguredSyntheticPrintTest(config, "packing", {
      synthetic: printer,
    });

    expect(submitted).toHaveLength(1);
    const job = submitted[0];
    if (job?.mediaType !== "application/pdf") {
      throw new Error("Synthetic PDF print job is missing.");
    }
    expect(new TextDecoder().decode(job.bytes.slice(0, 5))).toBe("%PDF-");
  });
});
