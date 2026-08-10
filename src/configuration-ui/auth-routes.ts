import { ConfigurationError } from "../errors.js";
import type {
  ConfigurationRouteContext,
  ConfigurationRouteHandler,
} from "./context.js";
import { objectValue, readJsonBody, sendJson } from "./http.js";

export const handleAuthenticationRoute: ConfigurationRouteHandler = async (
  context,
) => {
  const { request, response, url, extensionOrigin } = context;
  if (
    request.method === "OPTIONS" &&
    url.pathname === "/api/auth/session" &&
    extensionOrigin !== undefined
  ) {
    response.writeHead(204);
    response.end();
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/auth/status") {
    sendJson(
      response,
      200,
      context.sessionManager?.connectionStatus() ?? {
        state: "disconnected",
        automaticRenewal: false,
        protectedStorage: false,
      },
    );
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/auth/pairing") {
    if (!requireSessionManager(context)) return true;
    await readJsonBody(request);
    const challenge = context.sessionManager.startPairing();
    sendJson(response, 201, {
      ...challenge,
      port: requestPort(request.headers.host),
    });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/auth/disconnect") {
    if (!requireSessionManager(context)) return true;
    await readJsonBody(request);
    sendJson(response, 200, await context.sessionManager.disconnect());
    return true;
  }
  if (request.method !== "POST" || url.pathname !== "/api/auth/session") {
    return false;
  }
  if (extensionOrigin === undefined) {
    sendJson(response, 403, {
      message: "Only the browser connector may provide a session.",
    });
    return true;
  }
  if (request.headers["content-type"] !== "application/json") {
    sendJson(response, 415, {
      message: "Content-Type must be application/json.",
    });
    return true;
  }
  if (!requireSessionManager(context)) return true;
  const body = parseBrowserSessionSubmission(await readJsonBody(request));
  if (body.pairingCode !== undefined) {
    sendJson(
      response,
      200,
      await context.sessionManager.connect(body.pairingCode, body.session),
    );
  } else {
    sendJson(response, 200, {
      status: await context.sessionManager.renew(
        body.connectorToken,
        body.session,
      ),
    });
  }
  return true;
};

function requireSessionManager(
  context: ConfigurationRouteContext,
): context is ConfigurationRouteContext & {
  readonly sessionManager: NonNullable<
    ConfigurationRouteContext["sessionManager"]
  >;
} {
  if (context.sessionManager !== undefined) return true;
  sendJson(context.response, 503, {
    message: "Seller connection is unavailable.",
  });
  return false;
}

type BrowserSessionSubmission =
  | {
      readonly pairingCode: string;
      readonly connectorToken?: never;
      readonly session: {
        readonly authCookie: string;
        readonly expiresAt?: string;
      };
    }
  | {
      readonly pairingCode?: never;
      readonly connectorToken: string;
      readonly session: {
        readonly authCookie: string;
        readonly expiresAt?: string;
      };
    };

function parseBrowserSessionSubmission(
  value: unknown,
): BrowserSessionSubmission {
  const source = objectValue(value);
  const authCookie = source?.authCookie;
  const expiresAt = source?.expiresAt;
  const pairingCode = source?.pairingCode;
  const connectorToken = source?.connectorToken;
  if (
    typeof authCookie !== "string" ||
    authCookie.length === 0 ||
    authCookie.length > 16_384 ||
    authCookie.includes("\r") ||
    authCookie.includes("\n") ||
    authCookie.includes(";") ||
    (expiresAt !== undefined &&
      (typeof expiresAt !== "string" ||
        !Number.isFinite(Date.parse(expiresAt))))
  ) {
    throw new ConfigurationError(["The browser session is invalid."]);
  }
  const session = {
    authCookie,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
  if (
    typeof pairingCode === "string" &&
    pairingCode.length >= 16 &&
    pairingCode.length <= 32 &&
    connectorToken === undefined
  ) {
    return { pairingCode, session };
  }
  if (
    typeof connectorToken === "string" &&
    /^[a-f0-9]{64}$/u.test(connectorToken) &&
    pairingCode === undefined
  ) {
    return { connectorToken, session };
  }
  throw new ConfigurationError([
    "Provide exactly one valid pairing code or connector token.",
  ]);
}

function requestPort(host: string | undefined): number {
  if (host === undefined) return 47831;
  const value = new URL(`http://${host}`).port;
  return value === "" ? 80 : Number(value);
}
