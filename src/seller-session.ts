import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createTcgplayerSellerClient,
  TcgplayerApiError,
  type TcgplayerSession,
} from "tcgplayer-private-api";
import type {
  SellerCredentialStore,
  StoredSellerSession,
} from "./credential-store.js";
import { ApplicationError } from "./errors.js";
import type { SellerCredentialAccess } from "./seller-credentials.js";

const PAIRING_LIFETIME_MILLISECONDS = 10 * 60 * 1_000;

export type SellerConnectionState = "connected" | "expired" | "disconnected";
export type SellerConnectionSource = "browser" | "environment";

export interface SellerConnectionStatus {
  readonly state: SellerConnectionState;
  readonly source?: SellerConnectionSource;
  readonly updatedAt?: string;
  readonly expiresAt?: string;
  readonly automaticRenewal: boolean;
  readonly protectedStorage: boolean;
}

export interface SellerPairingChallenge {
  readonly pairingCode: string;
  readonly expiresAt: string;
}

export interface BrowserSellerSession {
  readonly authCookie: string;
  readonly expiresAt?: string;
}

export interface SellerSessionManagerOptions {
  readonly store: SellerCredentialStore;
  readonly environment?: NodeJS.ProcessEnv;
  readonly authCookieEnvironmentName: string;
  readonly sellerKeyEnvironmentName: string;
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly validateSession?: (authCookie: string) => Promise<string>;
  readonly onExpired?: (updatedAt: string) => void | Promise<void>;
}

export interface SellerSessionService {
  connectionStatus(): SellerConnectionStatus;
  startPairing(): SellerPairingChallenge;
  connect(
    pairingCode: string,
    browserSession: BrowserSellerSession,
  ): Promise<{
    readonly connectorToken: string;
    readonly status: SellerConnectionStatus;
  }>;
  renew(
    connectorToken: string,
    browserSession: BrowserSellerSession,
  ): Promise<SellerConnectionStatus>;
  disconnect(): Promise<SellerConnectionStatus>;
}

interface ActiveSession {
  readonly authCookie: string;
  readonly sellerKey: string;
  readonly source: SellerConnectionSource;
  readonly connectorToken?: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
}

interface ExpiredSession {
  readonly sellerKey: string;
  readonly connectorToken: string;
  readonly updatedAt: string;
}

interface PendingPairing {
  readonly code: string;
  readonly expiresAt: number;
}

export class SellerSessionManager
  implements SellerCredentialAccess, SellerSessionService
{
  readonly session = (): Promise<TcgplayerSession> => this.getSession();
  readonly sellerKey = (): string => this.getSellerKey();
  readonly onAuthenticationRequired = (): void => {
    void this.markExpired();
  };
  readonly isConnected = (): boolean =>
    this.connectionStatus().state === "connected";

  private readonly environment: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly random: (size: number) => Uint8Array;
  private readonly validate: (authCookie: string) => Promise<string>;
  private initialized = false;
  private active: ActiveSession | undefined;
  private expired: ExpiredSession | undefined;
  private stateUpdatedAt: string | undefined;
  private pendingPairing: PendingPairing | undefined;
  private persistence: Promise<void> = Promise.resolve();

  constructor(private readonly options: SellerSessionManagerOptions) {
    this.environment = options.environment ?? process.env;
    this.now = options.now ?? (() => new Date());
    this.random = options.randomBytes ?? randomBytes;
    this.validate = options.validateSession ?? validateAuthenticatedSeller;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const stored = await this.options.store.load();
    if (stored !== undefined) {
      this.applyStored(stored);
    } else {
      const authCookie =
        this.environment[this.options.authCookieEnvironmentName]?.trim();
      const sellerKey =
        this.environment[this.options.sellerKeyEnvironmentName]?.trim();
      if (authCookie && sellerKey) {
        this.active = {
          authCookie,
          sellerKey,
          source: "environment",
          updatedAt: this.now().toISOString(),
        };
      }
    }
    this.initialized = true;
    await this.expireIfNecessary();
  }

  connectionStatus(): SellerConnectionStatus {
    this.assertInitialized();
    if (this.active !== undefined && this.isPast(this.active.expiresAt)) {
      void this.markExpired();
    }
    if (this.active !== undefined && !this.isPast(this.active.expiresAt)) {
      return {
        state: "connected",
        source: this.active.source,
        updatedAt: this.active.updatedAt,
        ...(this.active.expiresAt === undefined
          ? {}
          : { expiresAt: this.active.expiresAt }),
        automaticRenewal: this.active.connectorToken !== undefined,
        protectedStorage: this.options.store.available,
      };
    }
    return {
      state: this.expired === undefined ? "disconnected" : "expired",
      ...(this.stateUpdatedAt === undefined
        ? {}
        : { updatedAt: this.stateUpdatedAt }),
      automaticRenewal: this.expired !== undefined,
      protectedStorage: this.options.store.available,
    };
  }

  startPairing(): SellerPairingChallenge {
    this.assertInitialized();
    const code = formatPairingCode(this.random(8));
    const expiresAt = this.now().getTime() + PAIRING_LIFETIME_MILLISECONDS;
    this.pendingPairing = { code, expiresAt };
    return { pairingCode: code, expiresAt: new Date(expiresAt).toISOString() };
  }

  async connect(
    pairingCode: string,
    browserSession: BrowserSellerSession,
  ): Promise<{
    readonly connectorToken: string;
    readonly status: SellerConnectionStatus;
  }> {
    this.assertInitialized();
    const pending = this.pendingPairing;
    if (
      pending === undefined ||
      pending.expiresAt <= this.now().getTime() ||
      !secretsMatch(pairingCode, pending.code)
    ) {
      throw new TcgplayerApiError(
        "AUTHENTICATION_REQUIRED",
        "The pairing code is invalid or expired. Start a new connection from the application.",
      );
    }
    const normalized = validateBrowserSession(browserSession, this.now());
    const sellerKey = await this.validate(normalized.authCookie);
    const connectorToken = Buffer.from(this.random(32)).toString("hex");
    const updatedAt = this.now().toISOString();
    const active: ActiveSession = {
      ...normalized,
      sellerKey,
      source: "browser",
      connectorToken,
      updatedAt,
    };
    await this.options.store.save(toStoredConnected(active));
    this.active = active;
    this.expired = undefined;
    this.stateUpdatedAt = updatedAt;
    this.pendingPairing = undefined;
    return { connectorToken, status: this.connectionStatus() };
  }

  async renew(
    connectorToken: string,
    browserSession: BrowserSellerSession,
  ): Promise<SellerConnectionStatus> {
    this.assertInitialized();
    const expectedToken =
      this.active?.connectorToken ?? this.expired?.connectorToken;
    const expectedSellerKey = this.active?.sellerKey ?? this.expired?.sellerKey;
    if (
      expectedToken === undefined ||
      expectedSellerKey === undefined ||
      !secretsMatch(connectorToken, expectedToken)
    ) {
      throw new ApplicationError(
        "PAIRING_REQUIRED",
        "This browser connector is not paired with the running application.",
      );
    }
    const normalized = validateBrowserSession(browserSession, this.now());
    const sellerKey = await this.validate(normalized.authCookie);
    if (sellerKey.toLowerCase() !== expectedSellerKey.toLowerCase()) {
      throw new TcgplayerApiError(
        "FORBIDDEN",
        "The browser is signed in to a different seller. Disconnect and pair the intended seller explicitly.",
      );
    }
    const updatedAt = this.now().toISOString();
    const active: ActiveSession = {
      ...normalized,
      sellerKey,
      source: "browser",
      connectorToken: expectedToken,
      updatedAt,
    };
    await this.options.store.save(toStoredConnected(active));
    this.active = active;
    this.expired = undefined;
    this.stateUpdatedAt = updatedAt;
    return this.connectionStatus();
  }

  async disconnect(): Promise<SellerConnectionStatus> {
    this.assertInitialized();
    const updatedAt = this.now().toISOString();
    await this.options.store.save({
      version: 1,
      state: "disconnected",
      updatedAt,
    });
    this.active = undefined;
    this.expired = undefined;
    this.stateUpdatedAt = updatedAt;
    this.pendingPairing = undefined;
    return this.connectionStatus();
  }

  async markExpired(): Promise<void> {
    if (!this.initialized) return;
    const current = this.active;
    if (current === undefined) return;
    if (current.connectorToken === undefined) {
      this.active = undefined;
      this.expired = undefined;
      const updatedAt = this.now().toISOString();
      this.stateUpdatedAt = updatedAt;
      this.notifyExpired(updatedAt);
      return;
    }
    const expired: ExpiredSession = {
      sellerKey: current.sellerKey,
      connectorToken: current.connectorToken,
      updatedAt: this.now().toISOString(),
    };
    this.active = undefined;
    this.expired = expired;
    this.stateUpdatedAt = expired.updatedAt;
    this.persistence = this.persistence
      .then(() =>
        this.options.store.save({ version: 1, state: "expired", ...expired }),
      )
      .catch(() => undefined);
    await this.persistence;
    this.notifyExpired(expired.updatedAt);
  }

  private notifyExpired(updatedAt: string): void {
    try {
      void Promise.resolve(this.options.onExpired?.(updatedAt)).catch(
        () => undefined,
      );
    } catch {
      // Notification failures must never change authentication state.
    }
  }

  private async getSession(): Promise<TcgplayerSession> {
    this.assertInitialized();
    await this.expireIfNecessary();
    if (this.active === undefined) {
      throw new TcgplayerApiError(
        "AUTHENTICATION_REQUIRED",
        "Connect TCGplayer from the local application before using seller tools.",
      );
    }
    return { authCookie: this.active.authCookie };
  }

  private getSellerKey(): string {
    this.assertInitialized();
    if (this.active !== undefined && this.isPast(this.active.expiresAt)) {
      void this.markExpired();
    }
    if (this.active === undefined) {
      throw new TcgplayerApiError(
        "AUTHENTICATION_REQUIRED",
        "Connect TCGplayer from the local application before using seller tools.",
      );
    }
    return this.active.sellerKey;
  }

  private applyStored(stored: StoredSellerSession): void {
    this.stateUpdatedAt = stored.updatedAt;
    if (stored.state === "connected") {
      this.active = {
        authCookie: stored.authCookie,
        sellerKey: stored.sellerKey,
        source: "browser",
        connectorToken: stored.connectorToken,
        updatedAt: stored.updatedAt,
        ...(stored.expiresAt === undefined
          ? {}
          : { expiresAt: stored.expiresAt }),
      };
    } else if (stored.state === "expired") {
      this.expired = {
        sellerKey: stored.sellerKey,
        connectorToken: stored.connectorToken,
        updatedAt: stored.updatedAt,
      };
    }
  }

  private async expireIfNecessary(): Promise<void> {
    if (this.active !== undefined && this.isPast(this.active.expiresAt)) {
      await this.markExpired();
    }
  }

  private isPast(value: string | undefined): boolean {
    return value !== undefined && Date.parse(value) <= this.now().getTime();
  }

  private assertInitialized(): void {
    if (!this.initialized)
      throw new Error("SellerSessionManager must be initialized first.");
  }
}

async function validateAuthenticatedSeller(
  authCookie: string,
): Promise<string> {
  const client = createTcgplayerSellerClient({ session: { authCookie } });
  return (await client.getAuthenticatedSeller()).sellerKey;
}

function validateBrowserSession(
  value: unknown,
  now: Date,
): { readonly authCookie: string; readonly expiresAt?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TcgplayerApiError(
      "INVALID_ARGUMENT",
      "The browser session is invalid.",
    );
  }
  const source = value as Record<string, unknown>;
  const authCookie =
    typeof source.authCookie === "string"
      ? source.authCookie.trim()
      : undefined;
  if (
    typeof authCookie !== "string" ||
    authCookie.length === 0 ||
    authCookie.length > 16_384 ||
    authCookie.includes(";") ||
    authCookie.includes("\r") ||
    authCookie.includes("\n")
  ) {
    throw new TcgplayerApiError(
      "INVALID_ARGUMENT",
      "The browser session is invalid.",
    );
  }
  if (source.expiresAt === undefined) return { authCookie };
  if (typeof source.expiresAt !== "string") {
    throw new TcgplayerApiError(
      "INVALID_ARGUMENT",
      "The browser session expiry is invalid.",
    );
  }
  const expiresAt = Date.parse(source.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    throw new TcgplayerApiError(
      "AUTHENTICATION_REQUIRED",
      "The browser session is already expired. Sign in to TCGplayer again.",
    );
  }
  return { authCookie, expiresAt: new Date(expiresAt).toISOString() };
}

function toStoredConnected(active: ActiveSession): StoredSellerSession {
  if (active.connectorToken === undefined) {
    throw new Error("A browser session requires a connector token.");
  }
  return {
    version: 1,
    state: "connected",
    authCookie: active.authCookie,
    sellerKey: active.sellerKey,
    connectorToken: active.connectorToken,
    updatedAt: active.updatedAt,
    ...(active.expiresAt === undefined ? {} : { expiresAt: active.expiresAt }),
  };
}

function formatPairingCode(bytes: Uint8Array): string {
  const value = Buffer.from(bytes).toString("hex").toUpperCase();
  return value.match(/.{1,4}/gu)?.join("-") ?? value;
}

function secretsMatch(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(
    candidate.replace(/[\s-]/gu, "").toUpperCase(),
  );
  const expectedBytes = Buffer.from(
    expected.replace(/[\s-]/gu, "").toUpperCase(),
  );
  return (
    candidateBytes.length === expectedBytes.length &&
    timingSafeEqual(candidateBytes, expectedBytes)
  );
}
