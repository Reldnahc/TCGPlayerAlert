import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

const MAX_REQUEST_BYTES = 20_000;
const MAX_AUTH_COOKIE_LENGTH = 16_384;
const CHROMIUM_EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/u;
const FIREFOX_EXTENSION_ORIGIN =
  /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type SessionPairingValidation = "connected" | "authentication-required";

export interface SessionPairingServer {
  readonly port: number;
  readonly outcome: Promise<void>;
  close(): Promise<void>;
}

export interface StartSessionPairingServerOptions {
  readonly port: number;
  readonly pairingCode: string;
  readonly validateSession: (
    authCookie: string,
  ) => Promise<SessionPairingValidation>;
}

interface PairingPayload {
  readonly pairingCode: string;
  readonly authCookie: string;
}

class PairingRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "PairingRequestError";
    this.status = status;
  }
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason?: unknown) => void;
}

export async function startSessionPairingServer(
  options: StartSessionPairingServerOptions,
): Promise<SessionPairingServer> {
  const outcome = deferred();
  let validating = false;
  let connected = false;
  const server = createServer((request, response) => {
    void handlePairingRequest(request, response, {
      expectedCode: options.pairingCode,
      expectedPort: listeningPort(server),
      isConnected: () => connected,
      isValidating: () => validating,
      validate: async (authCookie) => {
        validating = true;
        try {
          const result = await options.validateSession(authCookie);
          if (result === "authentication-required") {
            throw new PairingRequestError(
              401,
              "TCGplayer did not accept that seller session. Sign in again, then retry Connect.",
            );
          }
          connected = true;
          outcome.resolve();
        } finally {
          validating = false;
        }
      },
      fail: outcome.reject,
    });
  });
  const port = await listen(server, options.port);
  server.once("error", (cause) => {
    outcome.reject(
      new Error("The local browser-extension pairing service failed.", {
        cause,
      }),
    );
  });
  return {
    port,
    outcome: outcome.promise,
    close: () => closeServer(server),
  };
}

interface PairingRequestContext {
  readonly expectedCode: string;
  readonly expectedPort: number;
  readonly isConnected: () => boolean;
  readonly isValidating: () => boolean;
  readonly validate: (authCookie: string) => Promise<void>;
  readonly fail: (cause: Error) => void;
}

async function handlePairingRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: PairingRequestContext,
): Promise<void> {
  const origin = request.headers.origin ?? "";
  if (!isBrowserExtensionOrigin(origin)) {
    sendJson(response, 403, { message: "Only a browser extension may pair." });
    return;
  }
  setCorsHeaders(request, response, origin);
  if (request.headers.host !== `127.0.0.1:${String(context.expectedPort)}`) {
    sendJson(response, 400, { message: "The local pairing host is invalid." });
    return;
  }
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method === "OPTIONS" && pathname === "/v1/session") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method !== "POST" || pathname !== "/v1/session") {
    sendJson(response, 404, { message: "Not found." });
    return;
  }
  if (context.isConnected()) {
    sendJson(response, 409, { message: "This pairing code was already used." });
    return;
  }
  if (context.isValidating()) {
    sendJson(response, 409, {
      message: "A seller session is being validated.",
    });
    return;
  }

  try {
    const payload = await readPairingPayload(request);
    if (!pairingCodesMatch(payload.pairingCode, context.expectedCode)) {
      throw new PairingRequestError(401, "The pairing code is incorrect.");
    }
    await context.validate(payload.authCookie);
    sendJson(response, 200, { connected: true });
  } catch (cause) {
    if (cause instanceof PairingRequestError) {
      sendJson(response, cause.status, { message: cause.message });
      return;
    }
    const error =
      cause instanceof Error
        ? cause
        : new Error("The seller session validation failed unexpectedly.");
    context.fail(error);
    sendJson(response, 502, {
      message: "The seller session could not be validated.",
    });
  }
}

async function readPairingPayload(
  request: IncomingMessage,
): Promise<PairingPayload> {
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    throw new PairingRequestError(415, "The pairing request must be JSON.");
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > MAX_REQUEST_BYTES) {
      throw new PairingRequestError(413, "The pairing request is too large.");
    }
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new PairingRequestError(
      400,
      "The pairing request is not valid JSON.",
    );
  }
  if (typeof value !== "object" || value === null) {
    throw new PairingRequestError(
      400,
      "The pairing request must be an object.",
    );
  }
  const source = value as Record<string, unknown>;
  const pairingCode = source.pairingCode;
  const authCookie = source.authCookie;
  if (
    typeof pairingCode !== "string" ||
    normalizePairingCode(pairingCode) === ""
  ) {
    throw new PairingRequestError(400, "A pairing code is required.");
  }
  if (
    typeof authCookie !== "string" ||
    authCookie.length === 0 ||
    authCookie.length > MAX_AUTH_COOKIE_LENGTH ||
    authCookie.includes(String.fromCharCode(0)) ||
    authCookie.includes("\r") ||
    authCookie.includes("\n")
  ) {
    throw new PairingRequestError(400, "The seller session is invalid.");
  }
  return { pairingCode, authCookie };
}

function setCorsHeaders(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string,
): void {
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Vary", "Origin");
  if (request.headers["access-control-request-private-network"] === "true") {
    response.setHeader("Access-Control-Allow-Private-Network", "true");
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function isBrowserExtensionOrigin(origin: string): boolean {
  return (
    CHROMIUM_EXTENSION_ORIGIN.test(origin) ||
    FIREFOX_EXTENSION_ORIGIN.test(origin)
  );
}

function normalizePairingCode(value: string): string {
  return value.replace(/[\s-]/gu, "").toUpperCase();
}

function pairingCodesMatch(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(normalizePairingCode(candidate), "utf8");
  const expectedBytes = Buffer.from(normalizePairingCode(expected), "utf8");
  return (
    candidateBytes.length === expectedBytes.length &&
    timingSafeEqual(candidateBytes, expectedBytes)
  );
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (cause: Error) => {
      server.off("listening", onListening);
      reject(cause);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(listeningPort(server));
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function listeningPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The local pairing service is not listening.");
  }
  return address.port;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((cause) => (cause === undefined ? resolve() : reject(cause)));
  });
}
