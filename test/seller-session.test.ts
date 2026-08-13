import { describe, expect, it, vi } from "vitest";
import {
  SellerSessionManager,
  type SellerCredentialStore,
  type StoredSellerSession,
} from "../src/index.js";
import { TcgplayerApiError } from "tcgplayer-private-api";

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
    readonly validateSession?: (authCookie: string) => Promise<string>;
    readonly onExpired?: (updatedAt: string) => void | Promise<void>;
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
    ...(options.onExpired === undefined
      ? {}
      : { onExpired: options.onExpired }),
    validateSession:
      options.validateSession ??
      vi
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
    const environmentSession = await session.session();
    expect(environmentSession.authCookie).toBe("synthetic-environment-cookie");
    expect(environmentSession.revision).toMatch(/^\d+$/u);
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
    const reloadedSession = await reloaded.session();
    expect(reloadedSession.authCookie).toBe("synthetic-browser-cookie");
    expect(reloadedSession.revision).toMatch(/^\d+$/u);
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
    const renewedSession = await session.session();
    expect(renewedSession.authCookie).toBe("synthetic-browser-cookie-two");
    expect(renewedSession.revision).toMatch(/^\d+$/u);

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
    const onExpired = vi.fn();
    const session = manager(store, { onExpired });
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
    expect(onExpired).toHaveBeenCalledOnce();

    await session.markExpired();
    expect(onExpired).toHaveBeenCalledOnce();
  });

  it("ignores an old failure and retains a current session that revalidates", async () => {
    const store = new MemoryCredentialStore();
    const validateSession = vi
      .fn<(authCookie: string) => Promise<string>>()
      .mockResolvedValue("synthetic-seller");
    const session = manager(store, { validateSession });
    await session.initialize();
    const firstChallenge = session.startPairing();
    await session.connect(firstChallenge.pairingCode, {
      authCookie: "synthetic-old-browser-cookie",
    });
    const oldRevision = (await session.session()).revision;
    if (oldRevision === undefined) {
      throw new Error("The old session did not expose its revision.");
    }

    const replacementChallenge = session.startPairing();
    await session.connect(replacementChallenge.pairingCode, {
      authCookie: "synthetic-replacement-browser-cookie",
    });
    const replacementRevision = (await session.session()).revision;
    if (replacementRevision === undefined) {
      throw new Error("The replacement session did not expose its revision.");
    }
    expect(replacementRevision).not.toBe(oldRevision);

    session.onAuthenticationRequired(
      new TcgplayerApiError(
        "AUTHENTICATION_REQUIRED",
        "Synthetic old request failed.",
      ),
      { sessionRevision: oldRevision },
    );
    await Promise.resolve();

    expect(session.connectionStatus().state).toBe("connected");
    await expect(session.session()).resolves.toMatchObject({
      authCookie: "synthetic-replacement-browser-cookie",
      revision: replacementRevision,
    });

    session.onAuthenticationRequired(
      new TcgplayerApiError(
        "AUTHENTICATION_REQUIRED",
        "Synthetic current request failed.",
      ),
      { sessionRevision: replacementRevision },
    );

    await vi.waitFor(() => expect(validateSession).toHaveBeenCalledTimes(3));
    expect(session.connectionStatus().state).toBe("connected");
    await expect(session.session()).resolves.toMatchObject({
      authCookie: "synthetic-replacement-browser-cookie",
      revision: replacementRevision,
    });
  });

  it("retains the current session when authoritative revalidation is transiently unavailable", async () => {
    const store = new MemoryCredentialStore();
    const validateSession = vi
      .fn<(authCookie: string) => Promise<string>>()
      .mockResolvedValueOnce("synthetic-seller")
      .mockRejectedValueOnce(
        new TcgplayerApiError(
          "NETWORK_ERROR",
          "Synthetic revalidation network failure.",
        ),
      );
    const session = manager(store, { validateSession });
    await session.initialize();
    const challenge = session.startPairing();
    await session.connect(challenge.pairingCode, {
      authCookie: "synthetic-browser-cookie",
    });
    const revision = (await session.session()).revision;
    if (revision === undefined) {
      throw new Error("The current session did not expose its revision.");
    }

    session.onAuthenticationRequired(
      new TcgplayerApiError(
        "AUTHENTICATION_REQUIRED",
        "Synthetic feature request failed.",
      ),
      { sessionRevision: revision },
    );

    await vi.waitFor(() => expect(validateSession).toHaveBeenCalledTimes(2));
    expect(session.connectionStatus().state).toBe("connected");
  });

  it("expires the current session when authoritative revalidation rejects it", async () => {
    const store = new MemoryCredentialStore();
    const validateSession = vi
      .fn<(authCookie: string) => Promise<string>>()
      .mockResolvedValueOnce("synthetic-seller")
      .mockRejectedValueOnce(
        new TcgplayerApiError(
          "AUTHENTICATION_REQUIRED",
          "Synthetic authoritative rejection.",
        ),
      );
    const session = manager(store, { validateSession });
    await session.initialize();
    const challenge = session.startPairing();
    await session.connect(challenge.pairingCode, {
      authCookie: "synthetic-browser-cookie",
    });
    const revision = (await session.session()).revision;
    if (revision === undefined) {
      throw new Error("The current session did not expose its revision.");
    }

    session.onAuthenticationRequired(
      new TcgplayerApiError(
        "AUTHENTICATION_REQUIRED",
        "Synthetic feature request failed.",
      ),
      { sessionRevision: revision },
    );

    await vi.waitFor(() =>
      expect(session.connectionStatus().state).toBe("expired"),
    );
    expect(validateSession).toHaveBeenCalledTimes(2);
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
