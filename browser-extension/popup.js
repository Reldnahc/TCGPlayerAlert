/* global browser, chrome, document, fetch */

const AUTH_COOKIE_NAME = "TCGAuthTicket_Production";
const SELLER_PORTAL_URL = "https://store.tcgplayer.com/admin";
const form = document.querySelector("#pairing-form");
const codeInput = document.querySelector("#pairing-code");
const portInput = document.querySelector("#pairing-port");
const button = document.querySelector("#connect");
const status = document.querySelector("#status");

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void connect();
});

async function connect() {
  setBusy(true);
  setStatus("Checking the signed-in seller session…");
  try {
    const pairingCode = codeInput.value.trim();
    const port = Number(portInput.value);
    if (pairingCode === "") throw new Error("Enter the one-time pairing code.");
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("Enter a valid local port.");
    }

    const cookie = await getSellerCookie();
    if (cookie?.value === undefined || cookie.value === "") {
      throw new Error(
        "No signed-in seller session was found. Sign in to the Seller Portal and try again.",
      );
    }

    const response = await fetch(
      `http://127.0.0.1:${String(port)}/v1/session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        body: JSON.stringify({ pairingCode, authCookie: cookie.value }),
      },
    );
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        typeof result.message === "string"
          ? result.message
          : "The local application rejected the connection.",
      );
    }
    setStatus(
      "Connected. The proof validated the session without saving it.",
      "success",
    );
  } catch (cause) {
    setStatus(
      cause instanceof Error ? cause.message : "The connection failed.",
    );
  } finally {
    setBusy(false);
  }
}

function getSellerCookie() {
  const details = { url: SELLER_PORTAL_URL, name: AUTH_COOKIE_NAME };
  if (typeof browser !== "undefined") return browser.cookies.get(details);
  return new Promise((resolve, reject) => {
    chrome.cookies.get(details, (cookie) => {
      const error = chrome.runtime.lastError;
      if (error === undefined) resolve(cookie);
      else reject(new Error(error.message));
    });
  });
}

function setBusy(busy) {
  button.disabled = busy;
  button.textContent = busy ? "Connecting…" : "Connect";
}

function setStatus(message, tone = "danger") {
  status.textContent = message;
  status.dataset.tone = tone;
}
