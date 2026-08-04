import { describe, expect, it } from "vitest";
import { renderAddressLabel } from "../src/index.js";
import { syntheticOrder } from "./fixtures.js";

describe("address-label action", () => {
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
});
