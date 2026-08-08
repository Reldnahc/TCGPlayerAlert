import { randomBytes } from "node:crypto";
import {
  createTcgplayerSellerClient,
  isTcgplayerApiError,
} from "tcgplayer-private-api";
import { openDefaultBrowser } from "./default-browser.js";
import { startSessionPairingServer } from "./session-pairing.js";

const LOGIN_URL = "https://store.tcgplayer.com/admin";
const DEFAULT_PAIRING_PORT = 47_841;
const DEFAULT_TIMEOUT_MILLISECONDS = 10 * 60 * 1_000;

export type ManagedLoginProofErrorCode =
  "ABORTED" | "PAIRING_SERVER_UNAVAILABLE" | "SESSION_INVALID" | "TIMEOUT";

export class ManagedLoginProofError extends Error {
  readonly code: ManagedLoginProofErrorCode;

  constructor(
    code: ManagedLoginProofErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ManagedLoginProofError";
    this.code = code;
  }
}

export interface ManagedLoginPairingReady {
  readonly pairingCode: string;
  readonly port: number;
  readonly loginUrl: string;
}

export interface ManagedLoginProofOptions {
  readonly port?: number;
  readonly timeoutMilliseconds?: number;
  readonly signal?: AbortSignal;
  readonly onStatus?: (message: string) => void;
  readonly onReady?: (ready: ManagedLoginPairingReady) => void;
  readonly openBrowser?: (url: string) => Promise<boolean>;
  readonly validateSession?: (authCookie: string) => Promise<void>;
  readonly createPairingCode?: () => string;
}

export async function runManagedLoginProofOfConcept(
  options: ManagedLoginProofOptions = {},
): Promise<void> {
  const requestedPort = boundedPort(options.port);
  const timeoutMilliseconds = boundedTimeout(options.timeoutMilliseconds);
  const onStatus = options.onStatus ?? (() => undefined);
  const openBrowser = options.openBrowser ?? openDefaultBrowser;
  const validateSession =
    options.validateSession ?? validateAuthenticatedSeller;
  const pairingCode =
    options.createPairingCode?.() ?? formatPairingCode(randomBytes(8));
  const pairing = await startPairing(
    requestedPort,
    pairingCode,
    validateSession,
  );

  try {
    throwIfAborted(options.signal);
    options.onReady?.({
      pairingCode,
      port: pairing.port,
      loginUrl: LOGIN_URL,
    });
    onStatus(`Pairing code: ${pairingCode}`);
    onStatus(
      "Sign in normally, then open the TCGPlayerAlert Session Connector browser extension and enter this code.",
    );
    const opened = await openBrowser(LOGIN_URL);
    onStatus(
      opened
        ? "TCGplayer opened in your regular default browser profile."
        : `Your default browser could not be opened automatically. Open ${LOGIN_URL} yourself.`,
    );
    await waitForOutcome(pairing.outcome, timeoutMilliseconds, options.signal);
    onStatus(
      "Connected successfully. The seller session was validated but was not saved.",
    );
  } finally {
    await pairing.close();
  }
}

async function startPairing(
  port: number,
  pairingCode: string,
  validateSession: (authCookie: string) => Promise<void>,
) {
  try {
    return await startSessionPairingServer({
      port,
      pairingCode,
      validateSession: async (authCookie) => {
        try {
          await validateSession(authCookie);
          return "connected";
        } catch (cause) {
          if (isAuthenticationPending(cause)) {
            return "authentication-required";
          }
          throw new ManagedLoginProofError(
            "SESSION_INVALID",
            "TCGplayer issued a session, but its seller identity could not be validated.",
            { cause },
          );
        }
      },
    });
  } catch (cause) {
    throw new ManagedLoginProofError(
      "PAIRING_SERVER_UNAVAILABLE",
      port === DEFAULT_PAIRING_PORT
        ? `The local pairing port ${String(DEFAULT_PAIRING_PORT)} is unavailable.`
        : "The local pairing service could not be started.",
      { cause },
    );
  }
}

async function validateAuthenticatedSeller(authCookie: string): Promise<void> {
  const client = createTcgplayerSellerClient({ session: { authCookie } });
  await client.getAuthenticatedSeller();
}

function isAuthenticationPending(cause: unknown): boolean {
  return isTcgplayerApiError(cause) && cause.code === "AUTHENTICATION_REQUIRED";
}

function formatPairingCode(bytes: Uint8Array): string {
  const value = Buffer.from(bytes).toString("hex").toUpperCase();
  return value.match(/.{1,4}/gu)?.join("-") ?? value;
}

function boundedPort(value: number | undefined): number {
  const resolved = value ?? DEFAULT_PAIRING_PORT;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > 65_535) {
    throw new ManagedLoginProofError(
      "PAIRING_SERVER_UNAVAILABLE",
      "The local pairing port must be between 0 and 65535.",
    );
  }
  return resolved;
}

function boundedTimeout(value: number | undefined): number {
  const resolved = value ?? DEFAULT_TIMEOUT_MILLISECONDS;
  if (!Number.isInteger(resolved) || resolved < 1_000 || resolved > 3_600_000) {
    throw new ManagedLoginProofError(
      "TIMEOUT",
      "The login timeout must be between one second and one hour.",
    );
  }
  return resolved;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new ManagedLoginProofError(
      "ABORTED",
      "The login proof of concept was cancelled.",
    );
  }
}

function waitForOutcome(
  outcome: Promise<void>,
  timeoutMilliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = () => {
      settle(() =>
        reject(
          new ManagedLoginProofError(
            "ABORTED",
            "The login proof of concept was cancelled.",
          ),
        ),
      );
    };
    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new ManagedLoginProofError(
            "TIMEOUT",
            "TCGplayer login was not paired within ten minutes.",
          ),
        ),
      );
    }, timeoutMilliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    outcome.then(
      () => settle(resolve),
      (cause: unknown) =>
        settle(() =>
          reject(
            cause instanceof Error
              ? cause
              : new Error("The login proof failed unexpectedly."),
          ),
        ),
    );
  });
}
