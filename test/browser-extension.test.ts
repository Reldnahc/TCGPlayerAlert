import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function readManifest(
  browserName: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(
      join("browser-extension", `${browserName}-manifest.json`),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

describe("browser session connector", () => {
  it("ships narrowly scoped renewal builds for Firefox and Chromium", async () => {
    const [chromiumManifest, firefoxManifest, popup, background] =
      await Promise.all([
        readManifest("chromium"),
        readManifest("firefox"),
        readFile(join("browser-extension", "popup.js"), "utf8"),
        readFile(join("browser-extension", "background.js"), "utf8"),
      ]);

    for (const manifest of [chromiumManifest, firefoxManifest]) {
      expect(manifest).toMatchObject({
        manifest_version: 3,
        permissions: ["cookies", "storage", "alarms"],
        host_permissions: [
          "https://store.tcgplayer.com/*",
          "http://127.0.0.1/*",
        ],
        action: { default_popup: "popup.html" },
      });
      expect(manifest).not.toHaveProperty("content_scripts");
      expect(manifest).toHaveProperty("background");
    }
    expect(chromiumManifest).not.toHaveProperty("browser_specific_settings");
    expect(firefoxManifest).toMatchObject({
      browser_specific_settings: {
        gecko: {
          id: "session-connector@tcgplayeralert.local",
          data_collection_permissions: {
            required: ["authenticationInfo"],
          },
        },
      },
    });
    expect(popup).not.toContain("authCookie");
    expect(popup).not.toContain("console.");
    expect(background).toContain(
      'const AUTH_COOKIE_NAME = "TCGAuthTicket_Production"',
    );
    expect(background).toContain("cookies.onChanged");
    expect(background).toContain("alarms.onAlarm");
    expect(background).not.toContain("console.");
  });
});
