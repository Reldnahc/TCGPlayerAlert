import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { createShipmentAprilTag } from "../src/april-tag.js";
import { WasmShipmentTagDetector } from "../src/background-april-tag-detector.js";

describe("background AprilTag detector", () => {
  it("detects the same generated shipment tag without a browser", async () => {
    const frame = renderMarker(42);
    const detector = new WasmShipmentTagDetector();

    try {
      expect(await detector.detect(frame)).toEqual([
        expect.objectContaining({ tagId: 42, hammingDistance: 0 }),
      ]);
    } finally {
      detector.close();
    }
  });
});

function renderMarker(tagId: number) {
  const marker = createShipmentAprilTag(tagId);
  const modulePixels = 48;
  const modules = marker.rows.length + marker.quietZoneModules * 2;
  const width = modules * modulePixels;
  const height = width;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "black";
  for (const [row, values] of marker.rows.entries()) {
    for (let column = 0; column < values.length; column += 1) {
      const value = values[column];
      if (value !== "1") continue;
      context.fillRect(
        (column + marker.quietZoneModules) * modulePixels,
        (row + marker.quietZoneModules) * modulePixels,
        modulePixels,
        modulePixels,
      );
    }
  }
  const rgba = context.getImageData(0, 0, width, height).data;
  const grayscale = new Uint8Array(width * height);
  for (let pixel = 0; pixel < grayscale.length; pixel += 1) {
    const offset = pixel * 4;
    grayscale[pixel] = Math.round(
      Number(rgba[offset]) * 0.2126 +
        Number(rgba[offset + 1]) * 0.7152 +
        Number(rgba[offset + 2]) * 0.0722,
    );
  }
  return { width, height, grayscale };
}
