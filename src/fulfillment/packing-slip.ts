import { PDFDocument as CanvasPdfDocument } from "@napi-rs/canvas";
import {
  parseOrderDetail,
  type Money,
  type NormalizedFulfillmentDocument,
  type OrderDetail,
  type PostalAddress,
} from "../marketplaces/contracts.js";
import type { ProviderOrderRef } from "../marketplaces/identity.js";

export interface AddressLabelRenderModel {
  readonly ref: ProviderOrderRef;
  readonly address: PostalAddress;
}

export interface PackingSlipLineRenderModel {
  readonly description: string;
  readonly attributes: readonly {
    readonly label: string;
    readonly value: string;
  }[];
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly lineTotal: Money;
}

export interface PackingSlipRenderModel {
  readonly ref: ProviderOrderRef;
  readonly heading: "Packing slip";
  readonly connectionLabel: string;
  readonly displayOrderNumber: string;
  readonly createdAt: string;
  readonly shippingMethod: string;
  readonly shipTo: PostalAddress;
  readonly lines: readonly PackingSlipLineRenderModel[];
  readonly totals: OrderDetail["totals"];
}

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

export function createAddressLabelRenderModel(
  detail: OrderDetail,
): AddressLabelRenderModel {
  const normalized = parseOrderDetail(detail);
  return Object.freeze({
    ref: normalized.ref,
    address: normalized.shippingAddress,
  });
}

export function createPackingSlipRenderModel(
  detail: OrderDetail,
  connectionLabel: string,
): PackingSlipRenderModel {
  const normalized = parseOrderDetail(detail);
  const label = connectionLabel.trim();
  if (
    label.length === 0 ||
    Array.from(label).length > 128 ||
    /\p{Cc}/u.test(label)
  ) {
    throw new Error("The packing-slip connection label is invalid.");
  }
  return Object.freeze({
    ref: normalized.ref,
    heading: "Packing slip",
    connectionLabel: label,
    displayOrderNumber: normalized.displayOrderNumber,
    createdAt: normalized.createdAt,
    shippingMethod: normalized.shippingMethod,
    shipTo: normalized.shippingAddress,
    lines: Object.freeze(
      normalized.lines.map((line) =>
        Object.freeze({
          description: line.description,
          attributes: Object.freeze(
            Object.entries(line.attributes)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([attributeLabel, value]) =>
                Object.freeze({ label: attributeLabel, value }),
              ),
          ),
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          lineTotal: line.lineTotal,
        }),
      ),
    ),
    totals: normalized.totals,
  });
}

export function renderLocalPackingSlip(
  model: PackingSlipRenderModel,
): Promise<NormalizedFulfillmentDocument> {
  const document = new CanvasPdfDocument({
    title: `Packing slip ${model.displayOrderNumber}`,
    subject: "Application-generated marketplace packing slip",
    creator: "TCGPlayerAlert",
  });
  let page = beginPage(document);
  let y = MARGIN;

  const nextPage = () => {
    document.endPage();
    page = beginPage(document);
    y = MARGIN;
  };
  const ensure = (height: number) => {
    if (y + height > PAGE_HEIGHT - MARGIN) nextPage();
  };
  const write = (
    text: string,
    options: {
      readonly size?: number;
      readonly bold?: boolean;
      readonly indent?: number;
    } = {},
  ) => {
    const size = options.size ?? 10;
    const indent = options.indent ?? 0;
    page.font = `${options.bold === true ? "bold " : ""}${String(size)}px Arial, sans-serif`;
    const lines = wrapText(
      text,
      (value) => page.measureText(value).width,
      CONTENT_WIDTH - indent,
    );
    for (const line of lines) {
      ensure(size + 3);
      page.fillText(line, MARGIN + indent, y + size);
      y += size + 3;
    }
  };
  const gap = (points: number) => {
    ensure(points);
    y += points;
  };

  write(model.heading, { size: 24, bold: true });
  write("Application-generated — not an official marketplace invoice", {
    size: 9,
  });
  gap(12);
  write(`${model.connectionLabel} order ${model.displayOrderNumber}`, {
    size: 13,
    bold: true,
  });
  write(`Ordered ${model.createdAt} — Shipping: ${model.shippingMethod}`);
  gap(14);
  write("Ship to", { size: 12, bold: true });
  for (const line of addressLines(model.shipTo)) write(line);
  gap(16);
  write("Items", { size: 12, bold: true });
  for (const line of model.lines) {
    ensure(58);
    write(`${String(line.quantity)} × ${line.description}`, { bold: true });
    if (line.attributes.length > 0) {
      write(
        line.attributes
          .map((attribute) => `${attribute.label}: ${attribute.value}`)
          .join(" · "),
        { size: 9, indent: 12 },
      );
    }
    write(
      `${formatMoney(line.unitPrice)} each · ${formatMoney(line.lineTotal)}`,
      { size: 9, indent: 12 },
    );
    gap(7);
  }
  ensure(90);
  gap(8);
  write(`Subtotal: ${formatMoney(model.totals.subtotal)}`);
  write(`Shipping: ${formatMoney(model.totals.shipping)}`);
  if (model.totals.tax !== undefined) {
    write(`Tax: ${formatMoney(model.totals.tax)}`);
  }
  write(`Total: ${formatMoney(model.totals.total)}`, { bold: true, size: 12 });

  document.endPage();

  return Promise.resolve({
    ref: model.ref,
    kind: "packing-slip",
    mediaType: "application/pdf",
    fileName: `packing-slip-${safeFilePart(model.displayOrderNumber)}.pdf`,
    bytes: document.close(),
  });
}

export function addressLines(address: PostalAddress): readonly string[] {
  return [
    address.recipientName,
    address.company,
    address.addressOne,
    address.addressTwo,
    `${address.city}, ${address.territory} ${address.postalCode}`,
    address.country,
  ].filter((line): line is string => line !== undefined && line.trim() !== "");
}

function wrapText(
  value: string,
  measure: (value: string) => number,
  maximumWidth: number,
): readonly string[] {
  const words = value.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const parts = splitWideWord(word, measure, maximumWidth);
    for (const part of parts) {
      const candidate = current === "" ? part : `${current} ${part}`;
      if (current === "" || measure(candidate) <= maximumWidth) {
        current = candidate;
      } else {
        lines.push(current);
        current = part;
      }
    }
  }
  lines.push(current);
  return lines;
}

function splitWideWord(
  word: string,
  measure: (value: string) => number,
  maximumWidth: number,
): readonly string[] {
  if (measure(word) <= maximumWidth) return [word];
  const parts: string[] = [];
  let current = "";
  for (const character of word) {
    const candidate = `${current}${character}`;
    if (current !== "" && measure(candidate) > maximumWidth) {
      parts.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }
  if (current !== "") parts.push(current);
  return parts;
}

function formatMoney(value: Money): string {
  const sign = value.minorUnits < 0 ? "-" : "";
  const absolute = Math.abs(value.minorUnits);
  return `${sign}${value.currency} ${String(Math.floor(absolute / 100))}.${String(absolute % 100).padStart(2, "0")}`;
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 96) || "order";
}

function beginPage(
  document: CanvasPdfDocument,
): ReturnType<CanvasPdfDocument["beginPage"]> {
  const page = document.beginPage(PAGE_WIDTH, PAGE_HEIGHT);
  page.fillStyle = "#000000";
  page.textBaseline = "alphabetic";
  return page;
}
