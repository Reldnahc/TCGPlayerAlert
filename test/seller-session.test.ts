import { describe, expect, it, vi } from "vitest";
import {
  SellerSessionManager,
  type SellerCredentialStore,
  type StoredSellerSession,
} from "../src/index.js";

class MemoryCredentialStore implements SellerCredentialStore {
  readonly available = true;
  value: StoredSellerSession | undefined;

  load(): Promise<StoredSellerSession | undefined> {
    return Promise.resolve(this.value);
  }

  save(value: StoredSellerSession): Promise<void> {
    this.value = structuredClone(value);
    return Promise.resolve();
  }
}

const NOW = new Date("2026-08-08T12:00:00.000Z");

function manager(
  store: MemoryCredentialStore,
  options: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly sellerKey?: string;
  } = {},
) {
  let randomCall = 0;
  return new SellerSessionManager({
    store,
    environment: options.environment ?? {},
    authCookieEnvironmentName: "SYNTHETIC_AUTH_COOKIE",
    sellerKeyEnvironmentName: "SYNTHETIC_SELLER_KEY",
    now: () => NOW,
    randomBytes: (size) => new Uint8Array(size).fill(++randomCall),
    validateSession: vi
      .fn<(authCookie: string) => Promise<string>>()
      .mockResolvedValue(options.sellerKey ?? "synthetic-seller"),
  });
}

describe("SellerSessionManager", () => {
  it("uses complete environment credentials only as a migration fallback", async () => {
    const store = new MemoryCredentialStore();
    const session = manager(store, {
      environment: {
        SYNTHETIC_AUTH_COOKIE: "synthetic-environment-cookie",
        SYNTHETIC_SELLER_KEY: "synthetic-seller",
      },
    });

    await session.initialize();

    expect(session.connectionStatus()).toMatchObject({
      state: "connected",
      source: "environment",
      automaticRenewal: false,
    });
    await expect(session.session()).resolves.toEqual({
      authCookie: "synthetic-environment-cookie",
    });
    expect(session.sellerKey()).toBe("synthetic-seller");
    expect(store.value).toBeUndefined();
  });

  it("validates, protects, and reloads a paired browser session", async () => {
    const store = new MemoryCredentialStore();
    const session = manager(store);
    await session.initialize();
    const challenge = session.startPairing();

    const connected = await session.connect(challenge.pairingCode, {
      authCookie: "synthetic-browser-cookie",
      expiresAt: "2026-08-09T12:00:00.000Z",
    });

    expect(connected.connectorToken).toMatch(/^[a-f0-9]{64}$/u);
    expect(connected.status).toMatchObject({
      state: "connected",
      source: "browser",
      automaticRenewal: true,
    });
    expect(store.value).toMatchObject({
      state: "connected",
      authCookie: "synthetic-browser-cookie",
      sellerKey: "synthetic-seller",
      connectorToken: connected.connectorToken,
    });

    const reloaded = manager(store);
    await reloaded.initialize();
    await expect(reloaded.session()).resolves.toEqual({
      authCookie: "synthetic-browser-cookie",
    });
  });

  it("renews only from the paired connector and the same seller", async () => {
    const store = new MemoryCredentialStore();
    const session = manager(store);
    await session.initialize();
    const challenge = session.startPairing();
    const connected = await session.connect(challenge.pairingCode, {
      authCookie: "synthetic-browser-cookie-one",
    });

    await expect(
      session.renew("0".repeat(64), {
        authCookie: "synthetic-browser-cookie-two",
      }),
    ).rejects.toMatchObject({ code: "PAIRING_REQUIRED" });

    await expect(
      session.renew(connected.connectorToken, {
        authCookie: "synthetic-browser-cookie-two",
      }),
    ).resolves.toMatchObject({ state: "connected" });
    await expect(session.session()).resolves.toEqual({
      authCookie: "synthetic-browser-cookie-two",
    });

    const wrongSeller = manager(store, { sellerKey: "another-seller" });
    await wrongSeller.initialize();
    await expect(
      wrongSeller.renew(connected.connectorToken, {
        authCookie: "synthetic-other-seller-cookie",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("expires a rejected browser session while retaining automatic renewal", async () => {
    const store = new MemoryCredentialStore();
    const session = manager(store);
    await session.initialize();
    const challenge = session.startPairing();
    await session.connect(challenge.pairingCode, {
      authCookie: "synthetic-browser-cookie",
    });

    await session.markExpired();

    expect(session.connectionStatus()).toMatchObject({
      state: "expired",
      automaticRenewal: true,
    });
    await expect(session.session()).rejects.toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
    });
    expect(store.value).toMatchObject({
      state: "expired",
      sellerKey: "synthetic-seller",
    });
    expect(store.value).not.toHaveProperty("authCookie");
  });

  it("persists an explicit disconnect instead of reactivating environment credentials", async () => {
    const store = new MemoryCredentialStore();
    const environment = {
      SYNTHETIC_AUTH_COOKIE: "synthetic-environment-cookie",
      SYNTHETIC_SELLER_KEY: "synthetic-seller",
    };
    const session = manager(store, { environment });
    await session.initialize();
    await session.disconnect();

    const restarted = manager(store, { environment });
    await restarted.initialize();

    expect(restarted.connectionStatus().state).toBe("disconnected");
    await expect(restarted.session()).rejects.toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
    });
  });
});
