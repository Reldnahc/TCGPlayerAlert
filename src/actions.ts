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
  const omittedValues = new Set(
    (config.omitLineValues ?? []).map((value) => value.trim().toUpperCase()),
  );
  return config.lines
    .map((template) => renderLine(template, order).trim())
    .filter((line) => line && !omittedValues.has(line.toUpperCase()));
}

export async function renderAddressLabel(
  order: FulfillmentOrder,
  config: AddressLabelActionConfig,
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const width = config.page.widthMm * POINTS_PER_MM;
  const height = config.page.heightMm * POINTS_PER_MM;
  const margin = config.page.marginMm * POINTS_PER_MM;
  const page = document.addPage([width, height]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const availableWidth = width - margin * 2;
  const lineHeight = config.page.fontSize * 1.18;
  const lines = renderAddressLines(order, config)
    .flatMap((line) =>
      wrapLine(line, availableWidth, config.page.fontSize, (text, size) =>
        font.widthOfTextAtSize(text, size),
      ),
    )
    .filter(Boolean);
  let y = height - margin - config.page.fontSize;
  for (const line of lines) {
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
  return document.save({ useObjectStreams: false });
}

function addressLabelPrintJob(
  context: ActionContext,
  config: AddressLabelActionConfig,
  jobName: string,
): AddressLabelPrintJob {
  return {
    idempotencyKey: context.idempotencyKey,
    jobName,
    mediaType: "application/vnd.tcgplayer-alert.address-label+json",
    page: config.page,
    lines: renderAddressLines(context.order, config),
  };
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
  ) {}

  async execute(context: ActionContext): Promise<void> {
    const jobName = `address-label-${printIdentifier(context.idempotencyKey)}`;
    const job = this.printer.acceptedMediaTypes.has(
      "application/vnd.tcgplayer-alert.address-label+json",
    )
      ? addressLabelPrintJob(context, this.config, jobName)
      : pdfPrintJob(
          context,
          jobName,
          await renderAddressLabel(context.order, this.config),
        );
    await this.printer.submit(job, context.signal);
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
): Readonly<Record<string, WorkflowAction>> {
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
      return [[id, createAction(id, actionConfig, printer)]];
    }),
  );
}

function createAction(
  id: string,
  config: ActionConfig,
  printer: Printer,
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
    return new AddressLabelAction(id, config, printer);
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
