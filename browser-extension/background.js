/* global browser, chrome, fetch */

const AUTH_COOKIE_NAME = "TCGAuthTicket_Production";
const SELLER_PORTAL_URL = "https://store.tcgplayer.com/admin";
const DEFAULT_PORT = 47_831;
const RENEWAL_ALARM = "tcgplayer-alert-session-renewal";
const api = typeof browser !== "undefined" ? browser : chrome;

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "connection-status") {
    void storedConnection()
      .then((connection) =>
        sendResponse({
          paired: connection !== undefined,
          port: connection?.port ?? DEFAULT_PORT,
        }),
      )
      .catch(() => sendResponse({ paired: false, port: DEFAULT_PORT }));
    return true;
  }
  if (message?.type === "pair-session") {
    void pairSession(message)
      .then(sendResponse)
      .catch((cause) => sendResponse(failure(cause)));
    return true;
  }
  if (message?.type === "renew-session") {
    void renewSession(message.port)
      .then(sendResponse)
      .catch((cause) => sendResponse(failure(cause)));
    return true;
  }
  return false;
});

api.cookies.onChanged.addListener((change) => {
  if (
    change.removed ||
    change.cookie.name !== AUTH_COOKIE_NAME ||
    !isSellerPortalDomain(change.cookie.domain)
  ) {
    return;
  }
  void renewSession().catch(() => undefined);
});

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RENEWAL_ALARM) void renewSession().catch(() => undefined);
});

api.runtime.onStartup.addListener(() => {
  void ensureRenewalAlarm().catch(() => undefined);
  void renewSession().catch(() => undefined);
});

api.runtime.onInstalled.addListener(() => {
  void ensureRenewalAlarm().catch(() => undefined);
});

void ensureRenewalAlarm().catch(() => undefined);

async function pairSession(message) {
  const pairingCode =
    typeof message.pairingCode === "string" ? message.pairingCode.trim() : "";
  const port = validPort(message.port);
  if (pairingCode === "")
    throw new Error("Enter the pairing code shown by TCGPlayerAlert.");
  const session = await currentBrowserSession();
  const result = await submit(port, { pairingCode, ...session });
  if (typeof result.connectorToken !== "string") {
    throw new Error("The application did not return a connector token.");
  }
  await storageSet({ connectorToken: result.connectorToken, port });
  await ensureRenewalAlarm();
  return {
    ok: true,
    message:
      "Connected. Future browser-session changes will be sent automatically.",
  };
}

async function renewSession(portOverride) {
  const connection = await storedConnection();
  if (connection === undefined) {
    return {
      ok: false,
      pairingRequired: true,
      message: "Pair this browser with TCGPlayerAlert first.",
    };
  }
  const port =
    portOverride === undefined ? connection.port : validPort(portOverride);
  const session = await currentBrowserSession();
  try {
    await submit(port, {
      connectorToken: connection.connectorToken,
      ...session,
    });
  } catch (cause) {
    if (cause instanceof ConnectorError && cause.code === "PAIRING_REQUIRED") {
      await storageRemove(["connectorToken", "port"]);
      return { ok: false, pairingRequired: true, message: cause.message };
    }
    throw cause;
  }
  if (port !== connection.port) await storageSet({ ...connection, port });
  return { ok: true, message: "The current seller session was refreshed." };
}

async function currentBrowserSession() {
  const cookie = await cookieGet({
    url: SELLER_PORTAL_URL,
    name: AUTH_COOKIE_NAME,
  });
  if (cookie?.value === undefined || cookie.value === "") {
    throw new Error(
      "No signed-in seller session was found. Sign in to the Seller Portal and try again.",
    );
  }
  return {
    authCookie: cookie.value,
    ...(typeof cookie.expirationDate === "number"
      ? { expiresAt: new Date(cookie.expirationDate * 1_000).toISOString() }
      : {}),
  };
}

async function submit(port, body) {
  const response = await fetch(
    `http://127.0.0.1:${String(port)}/api/auth/session`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      body: JSON.stringify(body),
    },
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ConnectorError(
      typeof result.message === "string"
        ? result.message
        : "TCGPlayerAlert rejected the connection.",
      typeof result.code === "string" ? result.code : undefined,
    );
  }
  return result;
}

class ConnectorError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function storedConnection() {
  const stored = await storageGet(["connectorToken", "port"]);
  return typeof stored.connectorToken === "string" &&
    /^[a-f0-9]{64}$/.test(stored.connectorToken)
    ? { connectorToken: stored.connectorToken, port: validPort(stored.port) }
    : undefined;
}

function validPort(value) {
  const port = value === undefined ? DEFAULT_PORT : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Enter a valid local application port.");
  }
  return port;
}

function failure(cause) {
  return {
    ok: false,
    message: cause instanceof Error ? cause.message : "The connection failed.",
  };
}

async function ensureRenewalAlarm() {
  if ((await alarmGet(RENEWAL_ALARM)) === undefined) {
    await alarmCreate(RENEWAL_ALARM, { periodInMinutes: 5 });
  }
}

function isSellerPortalDomain(domain) {
  return domain === "store.tcgplayer.com" || domain === ".store.tcgplayer.com";
}

function alarmGet(name) {
  if (typeof browser !== "undefined") return browser.alarms.get(name);
  return new Promise((resolvePromise, rejectPromise) => {
    chrome.alarms.get(name, (alarm) => {
      const error = chrome.runtime.lastError;
      if (error === undefined) resolvePromise(alarm);
      else rejectPromise(new Error(error.message));
    });
  });
}

function cookieGet(details) {
  if (typeof browser !== "undefined") return browser.cookies.get(details);
  return new Promise((resolvePromise, rejectPromise) => {
    chrome.cookies.get(details, (cookie) => {
      const error = chrome.runtime.lastError;
      if (error === undefined) resolvePromise(cookie);
      else rejectPromise(new Error(error.message));
    });
  });
}

function storageGet(keys) {
  if (typeof browser !== "undefined") return browser.storage.local.get(keys);
  return new Promise((resolvePromise, rejectPromise) => {
    chrome.storage.local.get(keys, (value) => {
      const error = chrome.runtime.lastError;
      if (error === undefined) resolvePromise(value);
      else rejectPromise(new Error(error.message));
    });
  });
}

function storageSet(value) {
  if (typeof browser !== "undefined") return browser.storage.local.set(value);
  return new Promise((resolvePromise, rejectPromise) => {
    chrome.storage.local.set(value, () => {
      const error = chrome.runtime.lastError;
      if (error === undefined) resolvePromise();
      else rejectPromise(new Error(error.message));
    });
  });
}

function storageRemove(keys) {
  if (typeof browser !== "undefined") return browser.storage.local.remove(keys);
  return new Promise((resolvePromise, rejectPromise) => {
    chrome.storage.local.remove(keys, () => {
      const error = chrome.runtime.lastError;
      if (error === undefined) resolvePromise();
      else rejectPromise(new Error(error.message));
    });
  });
}

function alarmCreate(name, info) {
  if (typeof browser !== "undefined") return browser.alarms.create(name, info);
  chrome.alarms.create(name, info);
  return Promise.resolve();
}
