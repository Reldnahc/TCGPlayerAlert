import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import {
  createShipmentAprilTag,
  detectShipmentAprilTags,
} from "../src/april-tag.js";
import { resolveVisionLabScan, visionLabCase } from "../src/vision-lab.js";

function renderAprilTag(tagId: number, markerPixels = 70, rotation = 0) {
  const canvas = createCanvas(640, 480);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  drawAprilTag(
    context,
    tagId,
    canvas.width / 2,
    canvas.height / 2,
    markerPixels,
    rotation,
  );
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

function drawAprilTag(
  context: SKRSContext2D,
  tagId: number,
  centerX: number,
  centerY: number,
  markerPixels: number,
  rotation = 0,
): void {
  const marker = createShipmentAprilTag(tagId);
  const totalModules = marker.rows.length + marker.quietZoneModules * 2;
  const moduleSize = markerPixels / totalModules;
  context.save();
  context.translate(centerX, centerY);
  context.rotate(rotation);
  context.fillStyle = "black";
  for (const [row, modules] of marker.rows.entries()) {
    for (let column = 0; column < modules.length; column += 1) {
      if (modules[column] !== "1") continue;
      context.fillRect(
        -markerPixels / 2 + (column + marker.quietZoneModules) * moduleSize,
        -markerPixels / 2 + (row + marker.quietZoneModules) * moduleSize,
        moduleSize,
        moduleSize,
      );
    }
  }
  context.restore();
}

describe("vision lab AprilTag flow", () => {
  it("detects the synthetic tag in a low-resolution rotated frame", () => {
    const labCase = visionLabCase("unique");
    const image = renderAprilTag(labCase.printedOrder.tagId, 40, Math.PI / 2);

    expect(
      detectShipmentAprilTags(image.data, image.width, image.height),
    ).toMatchObject([
      { tagId: labCase.printedOrder.tagId, hammingDistance: 0 },
    ]);
  });

  it("reports each distinct tag when two parcels are visible", () => {
    const canvas = createCanvas(640, 480);
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    drawAprilTag(context, 7, 200, 240, 70);
    drawAprilTag(context, 18, 440, 240, 70, Math.PI / 2);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);

    expect(
      detectShipmentAprilTags(image.data, image.width, image.height).map(
        (detection) => detection.tagId,
      ),
    ).toEqual(expect.arrayContaining([7, 18]));
  });

  it("resolves one fake order and keeps its repeated scan idempotent", () => {
    const labCase = visionLabCase("unique");
    const first = resolveVisionLabScan(
      labCase.printedOrder.tagId,
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
        labCase.printedOrder.tagId,
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
      resolveVisionLabScan(missing.printedOrder.tagId, missing.candidates),
    ).toMatchObject({ state: "missing" });
    expect(
      resolveVisionLabScan(ambiguous.printedOrder.tagId, ambiguous.candidates),
    ).toMatchObject({ state: "ambiguous", orders: { length: 2 } });
  });
});
