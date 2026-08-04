import { describe, expect, it } from "vitest";
import {
  discoverInstalledPrinters,
  parseDiscoveredPrinters,
} from "../src/index.js";

describe("printer discovery", () => {
  it("parses and sorts the Windows default printer first", () => {
    expect(
      parseDiscoveredPrinters(
        JSON.stringify([
          { name: "Zebra", isDefault: false },
          { name: "Office", isDefault: true },
        ]),
      ),
    ).toEqual([
      { name: "Office", isDefault: true },
      { name: "Zebra", isDefault: false },
    ]);
  });

  it("reports unsupported platforms without spawning a process", async () => {
    const result = await discoverInstalledPrinters("linux", () => {
      throw new Error("The runner should not be called.");
    });

    expect(result).toMatchObject({ supported: false, printers: [] });
  });
});
