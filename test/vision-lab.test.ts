import { describe, expect, it } from "vitest";
import { createShipmentAprilTag } from "../src/april-tag.js";
import {
  parseVisionLabLabelIndex,
  resolveVisionLabScan,
  visionLabCase,
  visionLabPrintedOrder,
} from "../src/vision-lab.js";

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
      visionLabPrintedOrder("unique").tagId,
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
        visionLabPrintedOrder("unique").tagId,
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
        visionLabPrintedOrder("missing").tagId,
        missing.candidates,
      ),
    ).toMatchObject({ state: "missing" });
    expect(
      resolveVisionLabScan(
        visionLabPrintedOrder("ambiguous").tagId,
        ambiguous.candidates,
      ),
    ).toMatchObject({ state: "ambiguous", orders: { length: 2 } });
  });

  it("provides five unique labels that all resolve in the basket pool", () => {
    const basket = visionLabCase("basket");

    expect(basket.printedOrders).toHaveLength(5);
    expect(new Set(basket.printedOrders.map((order) => order.tagId)).size).toBe(
      5,
    );
    expect(
      basket.printedOrders
        .map((order) => resolveVisionLabScan(order.tagId, basket.candidates))
        .every((resolution) => resolution.state === "match"),
    ).toBe(true);
    expect(parseVisionLabLabelIndex(undefined, "basket")).toBe(0);
    expect(parseVisionLabLabelIndex(4, "basket")).toBe(4);
    expect(parseVisionLabLabelIndex(5, "basket")).toBeUndefined();
    expect(visionLabPrintedOrder("basket", 4)).toMatchObject({
      orderNumber: "LAB-4005",
      buyerName: "Emery Mock",
      tagId: 333,
    });
  });
});
