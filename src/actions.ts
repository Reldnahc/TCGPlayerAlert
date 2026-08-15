import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { createHash } from "node:crypto";
import type {
  ActionConfig,
  AddressLabelActionConfig,
  AppConfig,
} from "./config.js";
import type { FulfillmentDocument, FulfillmentOrder } from "./domain.js";
import { ApplicationError } from "./errors.js";
import type { AddressLabelPrintJob, PdfPrintJob, Printer } from "./printing.js";
import {
  createShipmentAprilTag,
  type FiducialMarkerMatrix,
} from "./april-tag.js";
import type { ShipmentTagAssigner } from "./shipment-tags.js";

export interface ActionContext {
  readonly order: FulfillmentOrder;
  readonly idempotencyKey: string;
  readonly packingSlip?: FulfillmentDocument;
  readonly signal?: AbortSignal;
}

export interface WorkflowAction {
  readonly id: string;
  readonly requiresPackingSlip: boolean;
  execute(context: ActionContext): Promise<void>;
}

const POINTS_PER_MM = 72 / 25.4;
const ADDRESS_FIELDS = new Set([
  "recipientName",
  "addressOne",
  "addressTwo",
  "city",
  "territory",
  "postalCode",
  "country",
]);

function renderLine(template: string, order: FulfillmentOrder): string {
  return template.replace(/\{([a-zA-Z]+)\}/gu, (_match, field: string) => {
    if (!ADDRESS_FIELDS.has(field)) {
      throw new ApplicationError(
        "CONFIGURATION_ERROR",
        "An address-label template contains an unsupported field.",
      );
    }
    return (
      order.shippingAddress[field as keyof typeof order.shippingAddress] ?? ""
    );
  });
}

function wrapLine(
  value: string,
  maximumWidth: number,
  fontSize: number,
  measure: (text: string, size: number) => number,
): string[] {
  const words = value.trim().split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate, fontSize) <= maximumWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function renderAddressLines(
  order: FulfillmentOrder,
  config: AddressLabelActionConfig,
): string[] {
  return printableAddressLines(
    config.lines.map((template) => renderLine(template, order)),
    config,
  );
}

function printableAddressLines(
  lines: readonly string[],
  config: AddressLabelActionConfig,
): string[] {
  const omittedValues = new Set(
    (config.omitLineValues ?? []).map((value) => value.trim().toUpperCase()),
  );
  return lines
    .map((line) => line.trim())
    .filter((line) => line && !omittedValues.has(line.toUpperCase()));
}

async function renderAddressLabelLines(
  lines: readonly string[],
  config: AddressLabelActionConfig,
  fiducialMarker?: FiducialMarkerMatrix,
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const width = config.page.widthMm * POINTS_PER_MM;
  const height = config.page.heightMm * POINTS_PER_MM;
  const margin = config.page.marginMm * POINTS_PER_MM;
  const page = document.addPage([width, height]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const markerSize = (fiducialMarker?.sizeMm ?? 0) * POINTS_PER_MM;
  const markerGap = fiducialMarker === undefined ? 0 : 2 * POINTS_PER_MM;
  const availableWidth = width - margin * 2 - markerSize - markerGap;
  if (availableWidth <= 0) {
    throw new ApplicationError(
      "CONFIGURATION_ERROR",
      "The address label is too narrow for its fiducial marker and margins.",
    );
  }
  const lineHeight = config.page.fontSize * 1.18;
  const wrappedLines = lines
    .flatMap((line) =>
      wrapLine(line, availableWidth, config.page.fontSize, (text, size) =>
        font.widthOfTextAtSize(text, size),
      ),
    )
    .filter(Boolean);
  let y = height - margin - config.page.fontSize;
  for (const line of wrappedLines) {
    if (y < margin) {
      throw new ApplicationError(
        "CONFIGURATION_ERROR",
        "The configured address template does not fit on the label.",
      );
    }
    page.drawText(line, {
      x: margin,
      y,
      size: config.page.fontSize,
      font,
      color: rgb(0, 0, 0),
    });
    y -= lineHeight;
  }
  if (fiducialMarker !== undefined) {
    drawFiducialMarker(
      page,
      fiducialMarker,
      width - margin - markerSize,
      height - margin - markerSize,
      markerSize,
    );
  }
  return document.save({ useObjectStreams: false });
}

function drawFiducialMarker(
  page: ReturnType<PDFDocument["addPage"]>,
  marker: FiducialMarkerMatrix,
  x: number,
  y: number,
  size: number,
): void {
  const totalModules = marker.rows.length + marker.quietZoneModules * 2;
  const moduleSize = size / totalModules;
  for (const [row, modules] of marker.rows.entries()) {
    for (let column = 0; column < modules.length; column += 1) {
      if (modules[column] !== "1") continue;
      page.drawRectangle({
        x: x + (column + marker.quietZoneModules) * moduleSize,
        y: y + size - (row + marker.quietZoneModules + 1) * moduleSize,
        width: moduleSize,
        height: moduleSize,
        color: rgb(0, 0, 0),
      });
    }
  }
}

export async function renderAddressLabel(
  order: FulfillmentOrder,
  config: AddressLabelActionConfig,
): Promise<Uint8Array> {
  return renderAddressLabelLines(renderAddressLines(order, config), config);
}

function addressLabelPrintJob(
  idempotencyKey: string,
  config: AddressLabelActionConfig,
  jobName: string,
  lines: readonly string[],
  fiducialMarker?: FiducialMarkerMatrix,
): AddressLabelPrintJob {
  return {
    idempotencyKey,
    jobName,
    mediaType: "application/vnd.tcgplayer-alert.address-label+json",
    page: config.page,
    lines,
    ...(fiducialMarker === undefined ? {} : { fiducialMarker }),
  };
}

async function submitAddressLabel(
  config: AddressLabelActionConfig,
  printer: Printer,
  lines: readonly string[],
  idempotencyKey: string,
  jobName: string,
  signal?: AbortSignal,
  tagId?: number,
): Promise<void> {
  const fiducialMarker =
    tagId === undefined ? undefined : createShipmentAprilTag(tagId);
  const job = printer.acceptedMediaTypes.has(
    "application/vnd.tcgplayer-alert.address-label+json",
  )
    ? addressLabelPrintJob(
        idempotencyKey,
        config,
        jobName,
        lines,
        fiducialMarker,
      )
    : printer.acceptedMediaTypes.has("application/pdf")
      ? {
          idempotencyKey,
          jobName,
          mediaType: "application/pdf" as const,
          bytes: await renderAddressLabelLines(lines, config, fiducialMarker),
        }
      : undefined;
  if (job === undefined) throw unsupportedPrinter("manual-address-label");
  await printer.submit(job, signal);
}

export async function executeAddressLabelLines(
  config: AddressLabelActionConfig,
  printer: Printer,
  lines: readonly string[],
  idempotencyKey: string,
  signal?: AbortSignal,
  tagId?: number,
): Promise<void> {
  const printable = printableAddressLines(lines, config);
  if (printable.length === 0) {
    throw new ApplicationError(
      "CONFIGURATION_ERROR",
      "The address label requires at least one printable line.",
    );
  }
  await submitAddressLabel(
    config,
    printer,
    printable,
    idempotencyKey,
    `address-label-${printIdentifier(idempotencyKey)}`,
    signal,
    tagId,
  );
}

export async function renderSyntheticPrintTest(
  config: ActionConfig,
): Promise<Uint8Array> {
  if (config.type === "print-address-label") {
    return renderAddressLabel(syntheticOrder, config);
  }
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  page.drawRectangle({
    x: 36,
    y: 36,
    width: 540,
    height: 720,
    borderWidth: 1,
    borderColor: rgb(0.15, 0.35, 0.25),
  });
  page.drawText("TCGPlayerAlert", {
    x: 72,
    y: 720,
    size: 13,
    font: bold,
    color: rgb(0.09, 0.42, 0.29),
  });
  page.drawText("Packing slip printer test", {
    x: 72,
    y: 675,
    size: 24,
    font: bold,
    color: rgb(0, 0, 0),
  });
  page.drawText("Synthetic document - no customer or order data", {
    x: 72,
    y: 642,
    size: 12,
    font,
    color: rgb(0.28, 0.32, 0.3),
  });
  page.drawLine({
    start: { x: 72, y: 616 },
    end: { x: 540, y: 616 },
    thickness: 1,
    color: rgb(0.78, 0.82, 0.79),
  });
  page.drawText("Setup check", {
    x: 72,
    y: 575,
    size: 15,
    font: bold,
    color: rgb(0, 0, 0),
  });
  page.drawText(
    "If the complete border is visible, page scaling fits the printable area.",
    {
      x: 72,
      y: 545,
      size: 11,
      font,
      color: rgb(0, 0, 0),
    },
  );
  page.drawText(
    "Confirm that this sheet arrived at the printer selected in Settings.",
    {
      x: 72,
      y: 520,
      size: 11,
      font,
      color: rgb(0, 0, 0),
    },
  );
  page.drawText("TEST PAGE - DO NOT FULFILL", {
    x: 72,
    y: 76,
    size: 10,
    font: bold,
    color: rgb(0.42, 0.24, 0.14),
  });
  return document.save({ useObjectStreams: false });
}

export async function executeSyntheticPrintTest(
  action: WorkflowAction,
  config: ActionConfig,
): Promise<void> {
  const packingSlipBytes = await renderSyntheticPrintTest({
    type: "print-packing-slip",
    enabled: true,
    printer: config.printer,
  });
  await action.execute({
    order: syntheticOrder,
    idempotencyKey: `synthetic-print-test:${action.id}`,
    ...(action.requiresPackingSlip
      ? {
          packingSlip: {
            kind: "packing-slip",
            mediaType: "application/pdf",
            fileName: "synthetic-packing-slip.pdf",
            bytes: packingSlipBytes,
          },
        }
      : {}),
  });
}

const syntheticOrder: FulfillmentOrder = {
  provider: "synthetic",
  id: "printer-test",
  placedAt: "2000-01-01T00:00:00.000Z",
  status: "Synthetic",
  channel: "Synthetic",
  fulfillment: "Synthetic",
  shippingType: "Synthetic",
  totalAmount: 0,
  buyerPaid: false,
  shippingAddress: {
    recipientName: "TCGPlayerAlert Printer Test",
    addressOne: "123 Example Street",
    city: "Example City",
    territory: "IL",
    country: "US",
    postalCode: "00000",
  },
  items: [],
};

class AddressLabelAction implements WorkflowAction {
  readonly requiresPackingSlip = false;

  constructor(
    readonly id: string,
    private readonly config: AddressLabelActionConfig,
    private readonly printer: Printer,
    private readonly shipmentTags: ShipmentTagAssigner | undefined,
  ) {}

  async execute(context: ActionContext): Promise<void> {
    await submitAddressLabel(
      this.config,
      this.printer,
      renderAddressLines(context.order, this.config),
      context.idempotencyKey,
      `address-label-${printIdentifier(context.idempotencyKey)}`,
      context.signal,
      this.shipmentTags === undefined
        ? undefined
        : await this.shipmentTags.assign(context.order.id, context.signal),
    );
  }
}

class PackingSlipAction implements WorkflowAction {
  readonly requiresPackingSlip = true;

  constructor(
    readonly id: string,
    private readonly printer: Printer,
  ) {}

  async execute(context: ActionContext): Promise<void> {
    if (context.packingSlip?.mediaType !== "application/pdf") {
      throw new ApplicationError(
        "PROVIDER_ERROR",
        "The packing-slip action requires a validated PDF document.",
      );
    }
    await this.printer.submit(
      pdfPrintJob(
        context,
        `packing-slip-${printIdentifier(context.idempotencyKey)}`,
        context.packingSlip.bytes,
      ),
      context.signal,
    );
  }
}

function printIdentifier(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 12);
}

function pdfPrintJob(
  context: ActionContext,
  jobName: string,
  bytes: Uint8Array,
): PdfPrintJob {
  return {
    idempotencyKey: context.idempotencyKey,
    jobName,
    mediaType: "application/pdf",
    bytes,
  };
}

export function createActions(
  config: AppConfig,
  printers: Readonly<Record<string, Printer>>,
  options: {
    readonly includeShipmentTags?: boolean;
    readonly shipmentTags?: ShipmentTagAssigner;
  } = {},
): Readonly<Record<string, WorkflowAction>> {
  const includeShipmentTags =
    options.includeShipmentTags ?? config.shipmentScanner.enabled;
  if (includeShipmentTags && options.shipmentTags === undefined) {
    throw new ApplicationError(
      "CONFIGURATION_ERROR",
      "Shipment scanning requires a durable shipment-tag registry.",
    );
  }
  return Object.fromEntries(
    Object.entries(config.actions).flatMap(([id, actionConfig]) => {
      if (actionConfig.enabled === false) return [];
      const printer = printers[actionConfig.printer];
      if (printer === undefined) {
        throw new ApplicationError(
          "CONFIGURATION_ERROR",
          "An action references an unavailable printer.",
        );
      }
      return [
        [
          id,
          createAction(
            id,
            actionConfig,
            printer,
            includeShipmentTags ? options.shipmentTags : undefined,
          ),
        ],
      ];
    }),
  );
}

function createAction(
  id: string,
  config: ActionConfig,
  printer: Printer,
  shipmentTags: ShipmentTagAssigner | undefined,
): WorkflowAction {
  if (config.type === "print-address-label") {
    if (
      !printer.acceptedMediaTypes.has(
        "application/vnd.tcgplayer-alert.address-label+json",
      ) &&
      !printer.acceptedMediaTypes.has("application/pdf")
    ) {
      throw unsupportedPrinter(id);
    }
    return new AddressLabelAction(id, config, printer, shipmentTags);
  }
  if (!printer.acceptedMediaTypes.has("application/pdf")) {
    throw unsupportedPrinter(id);
  }
  return new PackingSlipAction(id, printer);
}

function unsupportedPrinter(actionId: string): ApplicationError {
  return new ApplicationError(
    "CONFIGURATION_ERROR",
    `The printer selected by action ${actionId} cannot print that document type.`,
  );
}
