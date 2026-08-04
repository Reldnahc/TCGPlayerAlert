import { describe, expect, it } from "vitest";
import {
  createActions,
  renderAddressLabel,
  type PrintJob,
  type Printer,
} from "../src/index.js";
import { appConfig, syntheticOrder } from "./fixtures.js";

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

  it("uses structured label media when the printer supports native labels", async () => {
    let submitted: PrintJob | undefined;
    const printer: Printer = {
      acceptedMediaTypes: new Set([
        "application/vnd.tcgplayer-alert.address-label+json",
      ]),
      submit: (job) => {
        submitted = job;
        return Promise.resolve();
      },
    };
    const labelConfig = {
      type: "print-address-label" as const,
      printer: "synthetic",
      page: { widthMm: 89, heightMm: 36, marginMm: 3, fontSize: 9 },
      lines: ["{recipientName}", "{addressOne}", "{addressTwo}"],
    };
    const action = createActions(
      appConfig({ actions: { label: labelConfig } }),
      { synthetic: printer },
    ).label;
    if (action === undefined) throw new Error("Synthetic action is missing.");

    await action.execute({
      order: syntheticOrder,
      idempotencyKey: "synthetic:order:label",
    });

    expect(submitted).toMatchObject({
      mediaType: "application/vnd.tcgplayer-alert.address-label+json",
      lines: ["Example Recipient", "123 Example Street", "Unit 4"],
    });
  });
});
