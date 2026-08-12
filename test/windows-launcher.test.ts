import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareVersions,
  createInstalledConfig,
  selectVerifiedRelease,
} from "../src/windows-launcher.js";

describe("Windows launcher", () => {
  it("compares stable semantic versions", () => {
    expect(compareVersions("1.2.3", "1.2.2")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3", "2.0.0")).toBe(-1);
    expect(() => compareVersions("1.2.3-beta", "1.2.3")).toThrow();
  });

  it("accepts only a newer stable release with the exact verified asset", () => {
    expect(
      selectVerifiedRelease(
        {
          tag_name: "v0.2.0",
          draft: false,
          prerelease: false,
          assets: [
            {
              name: "TCGPlayerAlert-Setup-0.2.0-win-x64.exe",
              digest: `sha256:${"a".repeat(64)}`,
              browser_download_url:
                "https://github.com/Reldnahc/TCGPlayerAlert/releases/download/v0.2.0/TCGPlayerAlert-Setup-0.2.0-win-x64.exe",
            },
          ],
        },
        "0.1.0",
      ),
    ).toEqual({
      version: "0.2.0",
      filename: "TCGPlayerAlert-Setup-0.2.0-win-x64.exe",
      sha256: "a".repeat(64),
      downloadUrl:
        "https://github.com/Reldnahc/TCGPlayerAlert/releases/download/v0.2.0/TCGPlayerAlert-Setup-0.2.0-win-x64.exe",
    });
  });

  it.each([
    { tag_name: "v0.1.0", assets: [] },
    { tag_name: "v0.2.0", prerelease: true, assets: [] },
    {
      tag_name: "v0.2.0",
      assets: [
        {
          name: "TCGPlayerAlert-Setup-0.2.0-win-x64.exe",
          digest: null,
          browser_download_url:
            "https://github.com/Reldnahc/TCGPlayerAlert/releases/download/v0.2.0/TCGPlayerAlert-Setup-0.2.0-win-x64.exe",
        },
      ],
    },
  ])("rejects an ineligible or unverifiable release", (release) => {
    expect(selectVerifiedRelease(release, "0.1.0")).toBeUndefined();
  });

  it("moves all writable paths into the per-user data directory", () => {
    const userData = join(
      "C:\\Users",
      "seller",
      "AppData",
      "Local",
      "TCGPlayerAlert",
    );
    const installed = createInstalledConfig(
      {
        stateFile: ".data/state.json",
        spoolDirectory: ".spool",
        shipmentScanner: { stateFile: ".data/shipment-scans.json" },
        priceUpdateQueue: { stateFile: ".data/price-updates.json" },
        inventoryAdditionQueue: {
          stateFile: ".data/inventory-additions.json",
        },
      },
      userData,
    );

    expect(installed.stateFile).toBe(join(userData, "data", "state.json"));
    expect(installed.spoolDirectory).toBe(join(userData, "spool"));
    expect(installed.shipmentScanner).toEqual({
      stateFile: join(userData, "data", "shipment-scans.json"),
    });
    expect(installed.priceUpdateQueue).toEqual({
      stateFile: join(userData, "data", "price-updates.json"),
    });
    expect(installed.inventoryAdditionQueue).toEqual({
      stateFile: join(userData, "data", "inventory-additions.json"),
    });
  });
});
