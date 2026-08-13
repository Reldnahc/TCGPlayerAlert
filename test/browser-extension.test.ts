// @vitest-environment jsdom

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

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
    const [
      chromiumManifest,
      firefoxManifest,
      popup,
      popupHtml,
      background,
      privacy,
    ] = await Promise.all([
      readManifest("chromium"),
      readManifest("firefox"),
      readFile(join("browser-extension", "popup.js"), "utf8"),
      readFile(join("browser-extension", "popup.html"), "utf8"),
      readFile(join("browser-extension", "background.js"), "utf8"),
      readFile(join("browser-extension", "PRIVACY.md"), "utf8"),
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
        incognito: "not_allowed",
      });
      expect(manifest).toHaveProperty("icons.128", "icons/icon-128.png");
      expect(manifest).not.toHaveProperty("content_scripts");
      expect(manifest).toHaveProperty("background");
    }
    expect(chromiumManifest).not.toHaveProperty("browser_specific_settings");
    expect(firefoxManifest).toMatchObject({
      browser_specific_settings: {
        gecko: {
          id: "session-connector@tcgplayeralert.local",
          strict_min_version: "140.0",
          data_collection_permissions: {
            required: ["authenticationInfo"],
          },
        },
        gecko_android: {
          strict_min_version: "142.0",
        },
      },
    });
    expect(popup).not.toContain("authCookie");
    expect(popup).not.toContain("console.");
    expect(popupHtml).toContain("Connect and share session");
    expect(popupHtml).toContain("exact TCGplayer authentication cookie");
    expect(popupHtml).toContain("127.0.0.1");
    expect(background).toContain(
      'const AUTH_COOKIE_NAME = "TCGAuthTicket_Production"',
    );
    expect(background).toContain("cookies.onChanged");
    expect(background).toContain("alarms.onAlarm");
    expect(background).toContain('domain === "store.tcgplayer.com"');
    expect(background).toContain("alarmGet(RENEWAL_ALARM)");
    expect(background).not.toContain("console.");
    expect(privacy).toContain("TCGAuthTicket_Production");
    expect(privacy).toContain("http://127.0.0.1");
    expect(privacy).toContain("Windows DPAPI");
    expect(privacy).toContain("Chrome Web Store Limited Use disclosure");

    for (const size of [16, 32, 48, 96, 128]) {
      const icon = await stat(
        join("browser-extension", "icons", `icon-${String(size)}.png`),
      );
      expect(icon.size).toBeGreaterThan(0);
    }
  });

  it("lets a retained Firefox pairing be replaced with a new code", async () => {
    const [popup, popupHtml] = await Promise.all([
      readFile(join("browser-extension", "popup.js"), "utf8"),
      readFile(join("browser-extension", "popup.html"), "utf8"),
    ]);
    const parsed = new DOMParser().parseFromString(popupHtml, "text/html");
    document.documentElement.innerHTML = parsed.documentElement.innerHTML;
    const messages: unknown[] = [];
    const sendMessage = vi.fn((message: unknown) => {
      messages.push(message);
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "connection-status"
      ) {
        return Promise.resolve({ paired: true, port: 47_831 });
      }
      return Promise.resolve({
        ok: true,
        message: "Synthetic session connected.",
      });
    });
    runInNewContext(popup, {
      browser: { runtime: { sendMessage } },
      document,
    });

    const codeInput = document.querySelector("#pairing-code");
    const connect = document.querySelector("#connect");
    const pairAgain = document.querySelector("#pair-again");
    if (
      !(codeInput instanceof HTMLInputElement) ||
      !(connect instanceof HTMLButtonElement) ||
      !(pairAgain instanceof HTMLButtonElement)
    ) {
      throw new Error("The synthetic connector controls are missing.");
    }
    await vi.waitFor(() => expect(connect.textContent).toBe("Refresh session"));
    expect(codeInput.hidden).toBe(true);
    expect(pairAgain.hidden).toBe(false);

    pairAgain.click();

    expect(codeInput.hidden).toBe(false);
    expect(connect.textContent).toBe("Connect and share session");
    codeInput.value = "ABCD-EF01-2345-6789";
    document
      .querySelector("#pairing-form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        type: "pair-session",
        pairingCode: "ABCD-EF01-2345-6789",
        port: 47_831,
      }),
    );
  });
});
