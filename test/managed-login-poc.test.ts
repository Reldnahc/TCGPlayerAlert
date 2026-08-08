import { describe, expect, it, vi } from "vitest";
import {
  runManagedLoginProofOfConcept,
  type ManagedLoginBrowserContext,
} from "../src/managed-login-poc.js";
import type { ManagedLoginProofError } from "../src/managed-login-poc.js";

function browserFixture(cookieValues: readonly string[]) {
  const goto = vi.fn(() => Promise.resolve());
  const close = vi.fn(() => Promise.resolve());
  const values = [...cookieValues];
  const context: ManagedLoginBrowserContext = {
    pages: () => [{ goto }],
    newPage: () => Promise.resolve({ goto }),
    cookies: () => {
      const value = values.shift() ?? "";
      return Promise.resolve(
        value === "" ? [] : [{ name: "TCGAuthTicket_Production", value }],
      );
    },
    close,
  };
  return { context, goto, close };
}

describe("managed TCGplayer login proof of concept", () => {
  it("validates a captured session without exposing it and removes the profile", async () => {
    const browser = browserFixture(["", "synthetic-secret-ticket"]);
    const validateSession = vi.fn(() => Promise.resolve());
    const removeProfile = vi.fn(() => Promise.resolve());
    const messages: string[] = [];
    let clock = 0;

    await runManagedLoginProofOfConcept({
      launchBrowser: () => Promise.resolve(browser.context),
      validateSession,
      createProfile: () => Promise.resolve("synthetic-profile"),
      removeProfile,
      onStatus: (message) => messages.push(message),
      now: () => clock,
      sleep: (milliseconds) => {
        clock += milliseconds;
        return Promise.resolve();
      },
      timeoutMilliseconds: 5_000,
    });

    expect(browser.goto).toHaveBeenCalledWith(
      "https://store.tcgplayer.com/admin",
      { waitUntil: "domcontentloaded", timeout: 30_000 },
    );
    expect(validateSession).toHaveBeenCalledWith("synthetic-secret-ticket");
    expect(messages).toContain("Connected successfully.");
    expect(messages.join(" ")).not.toContain("synthetic-secret-ticket");
    expect(browser.close).toHaveBeenCalledOnce();
    expect(removeProfile).toHaveBeenCalledWith("synthetic-profile");
  });

  it("cleans up when the disposable login times out", async () => {
    const browser = browserFixture([]);
    const removeProfile = vi.fn(() => Promise.resolve());
    let clock = 0;

    await expect(
      runManagedLoginProofOfConcept({
        launchBrowser: () => Promise.resolve(browser.context),
        validateSession: () => Promise.resolve(),
        createProfile: () => Promise.resolve("synthetic-profile"),
        removeProfile,
        now: () => clock,
        sleep: (milliseconds) => {
          clock += milliseconds;
          return Promise.resolve();
        },
        timeoutMilliseconds: 1_000,
      }),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
    } satisfies Partial<ManagedLoginProofError>);
    expect(browser.close).toHaveBeenCalledOnce();
    expect(removeProfile).toHaveBeenCalledWith("synthetic-profile");
  });

  it("does not report success when the temporary profile cannot be removed", async () => {
    const browser = browserFixture(["synthetic-secret-ticket"]);

    await expect(
      runManagedLoginProofOfConcept({
        launchBrowser: () => Promise.resolve(browser.context),
        validateSession: () => Promise.resolve(),
        createProfile: () => Promise.resolve("synthetic-profile"),
        removeProfile: () => Promise.reject(new Error("Synthetic lock")),
        timeoutMilliseconds: 1_000,
      }),
    ).rejects.toMatchObject({ code: "CLEANUP_FAILED" });
    expect(browser.close).toHaveBeenCalledOnce();
  });
});
