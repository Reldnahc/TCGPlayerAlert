import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import {
  createShipmentQrCode,
  decodeShipmentQrPixels,
} from "../src/qr-code.js";
import { resolveVisionLabScan, visionLabCase } from "../src/vision-lab.js";

function renderQrCode(value: string, pixelsPerModule = 5) {
  const qrCode = createShipmentQrCode(value);
  const totalModules = qrCode.rows.length + qrCode.quietZoneModules * 2;
  const size = totalModules * pixelsPerModule;
  const canvas = createCanvas(size, size);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, size, size);
  context.fillStyle = "black";
  for (const [row, modules] of qrCode.rows.entries()) {
    for (let column = 0; column < modules.length; column += 1) {
      if (modules[column] !== "1") continue;
      context.fillRect(
        (column + qrCode.quietZoneModules) * pixelsPerModule,
        (row + qrCode.quietZoneModules) * pixelsPerModule,
        pixelsPerModule,
        pixelsPerModule,
      );
    }
  }
  return context.getImageData(0, 0, size, size);
}

describe("vision lab QR flow", () => {
  it("round trips the synthetic label code through rendered pixels", () => {
    const labCase = visionLabCase("unique");
    const image = renderQrCode(labCase.printedOrder.verificationCode);

    expect(decodeShipmentQrPixels(image.data, image.width, image.height)).toBe(
      labCase.printedOrder.verificationCode,
    );
  });

  it("resolves one fake order and keeps its repeated scan idempotent", () => {
    const labCase = visionLabCase("unique");
    const first = resolveVisionLabScan(
      labCase.printedOrder.verificationCode,
      labCase.candidates,
    );
    const completed = new Set(
      first.state === "match" ? [first.order.orderNumber] : [],
    );

    expect(first).toMatchObject({
      state: "match",
      order: { orderNumber: "LAB-1001" },
    });
    expect(
      resolveVisionLabScan(
        labCase.printedOrder.verificationCode,
        labCase.candidates,
        completed,
      ),
    ).toMatchObject({
      state: "duplicate",
      order: { orderNumber: "LAB-1001" },
    });
  });

  it("refuses missing and ambiguous fake-order resolutions", () => {
    const missing = visionLabCase("missing");
    const ambiguous = visionLabCase("ambiguous");

    expect(
      resolveVisionLabScan(
        missing.printedOrder.verificationCode,
        missing.candidates,
      ),
    ).toMatchObject({ state: "missing" });
    expect(
      resolveVisionLabScan(
        ambiguous.printedOrder.verificationCode,
        ambiguous.candidates,
      ),
    ).toMatchObject({ state: "ambiguous", orders: { length: 2 } });
  });
});
