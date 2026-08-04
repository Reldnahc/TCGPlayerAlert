import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { createHash } from "node:crypto";
import type {
  ActionConfig,
  AddressLabelActionConfig,
  AppConfig,
} from "./config.js";
import type { FulfillmentDocument, FulfillmentOrder } from "./domain.js";
import { ApplicationError } from "./errors.js";
import type { PrintJob, Printer } from "./printing.js";

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
  const lines = config.lines
    .flatMap((template) =>
      wrapLine(
        renderLine(template, order),
        availableWidth,
        config.page.fontSize,
        (text, size) => font.widthOfTextAtSize(text, size),
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

export async function renderSyntheticPrintTest(
  config: ActionConfig,
): Promise<Uint8Array> {
  if (config.type === "print-address-label") {
    return renderAddressLabel(
      {
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
      },
      config,
    );
  }
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("TCGPlayerAlert packing-slip printer test", {
    x: 72,
    y: 720,
    size: 18,
    font,
    color: rgb(0, 0, 0),
  });
  page.drawText("Synthetic document - no customer data", {
    x: 72,
    y: 690,
    size: 12,
    font,
    color: rgb(0, 0, 0),
  });
  return document.save({ useObjectStreams: false });
}

class AddressLabelAction implements WorkflowAction {
  readonly requiresPackingSlip = false;

  constructor(
    readonly id: string,
    private readonly config: AddressLabelActionConfig,
    private readonly printer: Printer,
  ) {}

  async execute(context: ActionContext): Promise<void> {
    const bytes = await renderAddressLabel(context.order, this.config);
    await this.printer.submit(
      printJob(
        context,
        `address-label-${printIdentifier(context.idempotencyKey)}`,
        bytes,
      ),
      context.signal,
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
      printJob(
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

function printJob(
  context: ActionContext,
  jobName: string,
  bytes: Uint8Array,
): PrintJob {
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
    Object.entries(config.actions).map(([id, actionConfig]) => {
      const printer = printers[actionConfig.printer];
      if (printer === undefined) {
        throw new ApplicationError(
          "CONFIGURATION_ERROR",
          "An action references an unavailable printer.",
        );
      }
      return [id, createAction(id, actionConfig, printer)];
    }),
  );
}

function createAction(
  id: string,
  config: ActionConfig,
  printer: Printer,
): WorkflowAction {
  return config.type === "print-address-label"
    ? new AddressLabelAction(id, config, printer)
    : new PackingSlipAction(id, printer);
}
