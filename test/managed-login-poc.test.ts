import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TcgplayerApiError } from "tcgplayer-private-api";
import { describe, expect, it, vi } from "vitest";
import {
  runManagedLoginProofOfConcept,
  type ManagedLoginPairingReady,
  type ManagedLoginProofError,
} from "../src/managed-login-poc.js";

const chromiumExtensionOrigin = `chrome-extension://${"a".repeat(32)}`;
const firefoxExtensionOrigin =
  "moz-extension://12345678-1234-4abc-8def-1234567890ab";

function proofFixture(
  validateSession: (authCookie: string) => Promise<void> = () =>
    Promise.resolve(),
) {
  let readyResolve!: (ready: ManagedLoginPairingReady) => void;
  const ready = new Promise<ManagedLoginPairingReady>((resolve) => {
    readyResolve = resolve;
  });
  const messages: string[] = [];
  const openBrowser = vi.fn(() => Promise.resolve(true));
  const running = runManagedLoginProofOfConcept({
    port: 0,
    timeoutMilliseconds: 5_000,
    createPairingCode: () => "ABCD-EF01-2345-6789",
    validateSession,
    openBrowser,
    onReady: readyResolve,
    onStatus: (message) => messages.push(message),
  });
  return { running, ready, messages, openBrowser };
}

function submit(
  ready: ManagedLoginPairingReady,
  body: unknown,
  origin = chromiumExtensionOrigin,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(ready.port)}/v1/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}

async function readManifest(browser: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(
    await readFile(
      join("browser-extension", `${browser}-manifest.json`),
      "utf8",
    ),
  ) as unknown;
  if (typeof value !== "object" || value === null) {
    throw new Error("The extension manifest must be an object.");
  }
  return value as Record<string, unknown>;
}

describe("managed TCGplayer login proof of concept", () => {
  it("validates one extension-supplied session without exposing or retaining it", async () => {
    const validateSession = vi.fn(() => Promise.resolve());
    const proof = proofFixture(validateSession);
    const ready = await proof.ready;

    const response = await submit(ready, {
      pairingCode: "abcd ef01 2345 6789",
      authCookie: "synthetic-secret-ticket",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ connected: true });
    await expect(proof.running).resolves.toBeUndefined();
    expect(validateSession).toHaveBeenCalledWith("synthetic-secret-ticket");
    expect(proof.openBrowser).toHaveBeenCalledWith(
      "https://store.tcgplayer.com/admin",
    );
    expect(proof.messages).toContain(
      "Connected successfully. The seller session was validated but was not saved.",
    );
    expect(proof.messages.join(" ")).not.toContain("synthetic-secret-ticket");
  });

  it("rejects web origins and incorrect one-time codes without validating a session", async () => {
    const validateSession = vi.fn(() => Promise.resolve());
    const proof = proofFixture(validateSession);
    const ready = await proof.ready;

    const webResponse = await submit(
      ready,
      { pairingCode: ready.pairingCode, authCookie: "not-used" },
      "https://example.com",
    );
    const codeResponse = await submit(ready, {
      pairingCode: "0000-0000-0000-0000",
      authCookie: "not-used",
    });

    expect(webResponse.status).toBe(403);
    expect(codeResponse.status).toBe(401);
    expect(validateSession).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    // Complete the still-waiting proof with its valid code so it closes cleanly.
    await submit(ready, {
      pairingCode: ready.pairingCode,
      authCookie: "synthetic-secret-ticket",
    });
    await proof.running;
  });

  it("accepts Firefox WebExtension origins", async () => {
    const proof = proofFixture();
    const ready = await proof.ready;

    const response = await submit(
      ready,
      {
        pairingCode: ready.pairingCode,
        authCookie: "synthetic-firefox-ticket",
      },
      firefoxExtensionOrigin,
    );

    expect(response.status).toBe(200);
    await proof.running;
  });

  it("keeps pairing available after TCGplayer rejects an unready session", async () => {
    const validateSession = vi
      .fn<(_: string) => Promise<void>>()
      .mockRejectedValueOnce(
        new TcgplayerApiError(
          "AUTHENTICATION_REQUIRED",
          "Synthetic session is not ready.",
        ),
      )
      .mockResolvedValueOnce();
    const proof = proofFixture(validateSession);
    const ready = await proof.ready;

    const rejected = await submit(ready, {
      pairingCode: ready.pairingCode,
      authCookie: "synthetic-unready-ticket",
    });
    const accepted = await submit(ready, {
      pairingCode: ready.pairingCode,
      authCookie: "synthetic-ready-ticket",
    });

    expect(rejected.status).toBe(401);
    expect(accepted.status).toBe(200);
    expect(validateSession).toHaveBeenCalledTimes(2);
    await proof.running;
  });

  it("fails closed when seller identity validation has an unexpected error", async () => {
    const proof = proofFixture(() =>
      Promise.reject(new Error("Synthetic compatibility failure.")),
    );
    const failure = proof.running.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    const ready = await proof.ready;

    const response = await submit(ready, {
      pairingCode: ready.pairingCode,
      authCookie: "synthetic-invalid-ticket",
    });

    expect(response.status).toBe(502);
    await expect(failure).resolves.toMatchObject({
      code: "SESSION_INVALID",
    } satisfies Partial<ManagedLoginProofError>);
  });

  it("answers extension preflights without opening the pairing endpoint to websites", async () => {
    const proof = proofFixture();
    const ready = await proof.ready;
    const response = await fetch(
      `http://127.0.0.1:${String(ready.port)}/v1/session`,
      {
        method: "OPTIONS",
        headers: {
          Origin: chromiumExtensionOrigin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "Content-Type",
        },
      },
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      chromiumExtensionOrigin,
    );
    await submit(ready, {
      pairingCode: ready.pairingCode,
      authCookie: "synthetic-secret-ticket",
    });
    await proof.running;
  });

  it("closes the pairing listener when the proof is cancelled", async () => {
    const controller = new AbortController();
    let readyResolve!: (ready: ManagedLoginPairingReady) => void;
    const readyPromise = new Promise<ManagedLoginPairingReady>((resolve) => {
      readyResolve = resolve;
    });
    const running = runManagedLoginProofOfConcept({
      port: 0,
      timeoutMilliseconds: 5_000,
      signal: controller.signal,
      createPairingCode: () => "ABCD-EF01-2345-6789",
      validateSession: () => Promise.resolve(),
      openBrowser: () => Promise.resolve(true),
      onReady: readyResolve,
    });
    const ready = await readyPromise;
    controller.abort();

    await expect(running).rejects.toMatchObject({
      code: "ABORTED",
    } satisfies Partial<ManagedLoginProofError>);
    await expect(
      submit(ready, {
        pairingCode: ready.pairingCode,
        authCookie: "not-used",
      }),
    ).rejects.toThrow();
  });

  it("ships a narrowly permissioned extension with no content scripts or storage", async () => {
    const [chromiumManifest, firefoxManifest] = await Promise.all([
      readManifest("chromium"),
      readManifest("firefox"),
    ]);
    const popup = await readFile(join("browser-extension", "popup.js"), "utf8");

    for (const manifest of [chromiumManifest, firefoxManifest]) {
      expect(manifest).toMatchObject({
        manifest_version: 3,
        permissions: ["cookies"],
        host_permissions: [
          "https://store.tcgplayer.com/*",
          "http://127.0.0.1/*",
        ],
        action: { default_popup: "popup.html" },
      });
      expect(manifest).not.toHaveProperty("content_scripts");
      expect(manifest).not.toHaveProperty("background");
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
    expect(popup).not.toContain("chrome.storage");
    expect(popup).not.toContain("console.");
  });
});
