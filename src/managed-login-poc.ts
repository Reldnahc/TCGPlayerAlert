import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTcgplayerSellerClient,
  isTcgplayerApiError,
} from "tcgplayer-private-api";

const LOGIN_URL = "https://store.tcgplayer.com/admin";
const AUTH_COOKIE_NAME = "TCGAuthTicket_Production";
const DEFAULT_TIMEOUT_MILLISECONDS = 10 * 60 * 1_000;
const COOKIE_POLL_MILLISECONDS = 500;
const VALIDATION_RETRY_MILLISECONDS = 5_000;

export type ManagedLoginProofErrorCode =
  | "ABORTED"
  | "BROWSER_CLOSED"
  | "BROWSER_UNAVAILABLE"
  | "CLEANUP_FAILED"
  | "SESSION_INVALID"
  | "TIMEOUT";

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

interface ManagedLoginCookie {
  readonly name: string;
  readonly value: string;
}

interface ManagedLoginPage {
  goto(
    url: string,
    options: {
      readonly timeout: number;
      readonly waitUntil: "domcontentloaded";
    },
  ): Promise<unknown>;
}

export interface ManagedLoginBrowserContext {
  pages(): readonly ManagedLoginPage[];
  newPage(): Promise<ManagedLoginPage>;
  cookies(): Promise<readonly ManagedLoginCookie[]>;
  close(): Promise<void>;
}

export interface ManagedLoginProofOptions {
  readonly timeoutMilliseconds?: number;
  readonly signal?: AbortSignal;
  readonly onStatus?: (message: string) => void;
  readonly launchBrowser?: (
    profileDirectory: string,
  ) => Promise<ManagedLoginBrowserContext>;
  readonly validateSession?: (authCookie: string) => Promise<void>;
  readonly createProfile?: () => Promise<string>;
  readonly removeProfile?: (profileDirectory: string) => Promise<void>;
  readonly now?: () => number;
  readonly sleep?: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export async function runManagedLoginProofOfConcept(
  options: ManagedLoginProofOptions = {},
): Promise<void> {
  const timeoutMilliseconds = boundedTimeout(options.timeoutMilliseconds);
  const onStatus = options.onStatus ?? (() => undefined);
  const launchBrowser = options.launchBrowser ?? launchEdge;
  const validateSession =
    options.validateSession ?? validateAuthenticatedSeller;
  const createProfile =
    options.createProfile ??
    (() => mkdtemp(join(tmpdir(), "tcgplayer-alert-login-poc-")));
  const removeProfile =
    options.removeProfile ??
    ((profileDirectory) =>
      rm(profileDirectory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      }));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const profileDirectory = await createProfile();
  let context: ManagedLoginBrowserContext | undefined;
  let operationFailed = false;
  let operationError: unknown;

  try {
    throwIfAborted(options.signal);
    onStatus("Opening a temporary Microsoft Edge login window...");
    try {
      context = await launchBrowser(profileDirectory);
    } catch (cause) {
      throw new ManagedLoginProofError(
        "BROWSER_UNAVAILABLE",
        "Microsoft Edge could not be opened for the login proof of concept.",
        { cause },
      );
    }

    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(LOGIN_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    onStatus(
      "Complete the TCGplayer sign-in in Edge. Passwords, MFA codes, and CAPTCHA responses stay in that window.",
    );

    const deadline = now() + timeoutMilliseconds;
    let lastCookie = "";
    let lastValidationAt = Number.NEGATIVE_INFINITY;
    let validated = false;
    while (now() < deadline) {
      throwIfAborted(options.signal);
      let cookies: readonly ManagedLoginCookie[];
      try {
        cookies = await context.cookies();
      } catch (cause) {
        throw new ManagedLoginProofError(
          "BROWSER_CLOSED",
          "The login window was closed before the session was validated.",
          { cause },
        );
      }
      const ticket = cookies.find(
        (cookie) => cookie.name === AUTH_COOKIE_NAME && cookie.value !== "",
      );
      const shouldValidate =
        ticket !== undefined &&
        (ticket.value !== lastCookie ||
          now() - lastValidationAt >= VALIDATION_RETRY_MILLISECONDS);
      if (ticket !== undefined && shouldValidate) {
        lastCookie = ticket.value;
        lastValidationAt = now();
        try {
          await validateSession(ticket.value);
          onStatus("Connected successfully.");
          validated = true;
          break;
        } catch (cause) {
          if (!isAuthenticationPending(cause)) {
            throw new ManagedLoginProofError(
              "SESSION_INVALID",
              "TCGplayer issued a session, but its seller identity could not be validated.",
              { cause },
            );
          }
        }
      }
      await sleep(COOKIE_POLL_MILLISECONDS, options.signal);
    }
    if (!validated) {
      throw new ManagedLoginProofError(
        "TIMEOUT",
        "TCGplayer login was not completed within ten minutes.",
      );
    }
  } catch (cause) {
    operationFailed = true;
    operationError = cause;
  }

  if (context !== undefined) {
    try {
      await context.close();
    } catch {
      // Profile removal below remains the authoritative cleanup check.
    }
  }
  try {
    await removeProfile(profileDirectory);
  } catch (cause) {
    throw new ManagedLoginProofError(
      "CLEANUP_FAILED",
      "The temporary login profile could not be removed.",
      { cause },
    );
  }
  if (operationFailed) throw operationError;
}

async function launchEdge(
  profileDirectory: string,
): Promise<ManagedLoginBrowserContext> {
  const { chromium } = await import("playwright-core");
  return chromium.launchPersistentContext(profileDirectory, {
    channel: "msedge",
    headless: false,
    viewport: null,
    args: ["--start-maximized"],
  });
}

async function validateAuthenticatedSeller(authCookie: string): Promise<void> {
  const client = createTcgplayerSellerClient({ session: { authCookie } });
  await client.getAuthenticatedSeller();
}

function isAuthenticationPending(cause: unknown): boolean {
  return isTcgplayerApiError(cause) && cause.code === "AUTHENTICATION_REQUIRED";
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

function abortableSleep(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(
        new ManagedLoginProofError(
          "ABORTED",
          "The login proof of concept was cancelled.",
        ),
      );
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        new ManagedLoginProofError(
          "ABORTED",
          "The login proof of concept was cancelled.",
        ),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
