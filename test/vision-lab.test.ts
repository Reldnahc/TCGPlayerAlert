import { describe, expect, it } from "vitest";
import { createShipmentAprilTag } from "../src/april-tag.js";
import { resolveVisionLabScan, visionLabCase } from "../src/vision-lab.js";

describe("vision lab AprilTag flow", () => {
  it("renders the official tag36h11 matrix for synthetic order 7", () => {
    expect(createShipmentAprilTag(7)).toMatchObject({
      tagId: 7,
      quietZoneModules: 1,
      rows: [
        "11111111",
        "11110111",
        "11110011",
        "11010111",
        "10100011",
        "11110001",
        "11010111",
        "11111111",
      ],
    });
    expect(() => createShipmentAprilTag(587)).toThrow(
      "An AprilTag id between 0 and 586 is required.",
    );
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
