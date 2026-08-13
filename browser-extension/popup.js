/* global browser, chrome, document */

const form = document.querySelector("#pairing-form");
const codeInput = document.querySelector("#pairing-code");
const portInput = document.querySelector("#pairing-port");
const button = document.querySelector("#connect");
const pairAgainButton = document.querySelector("#pair-again");
const hint = document.querySelector("#pairing-hint");
const status = document.querySelector("#status");
let paired = false;

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void connect();
});

pairAgainButton.addEventListener("click", () => {
  paired = false;
  renderConnectionState();
  codeInput.focus();
});

void loadStatus().catch((cause) => {
  setStatus(
    cause instanceof Error ? cause.message : "The connector could not start.",
  );
});

async function loadStatus() {
  const result = await sendMessage({ type: "connection-status" });
  paired = result?.paired === true;
  if (Number.isInteger(result?.port)) portInput.value = String(result.port);
  renderConnectionState();
}

function renderConnectionState() {
  button.textContent = paired ? "Refresh session" : "Connect and share session";
  codeInput.hidden = paired;
  document.querySelector('label[for="pairing-code"]').hidden = paired;
  pairAgainButton.hidden = !paired;
  hint.textContent = paired
    ? "This browser is paired. Refresh sends its current seller session now; use a new code if the local application no longer recognizes this pairing."
    : "Generate this code from the connection panel in TCGPlayerAlert.";
}

async function connect() {
  setBusy(true);
  setStatus(
    paired
      ? "Refreshing the seller session…"
      : "Checking the signed-in seller session…",
  );
  try {
    const port = Number(portInput.value);
    const message = paired
      ? { type: "renew-session", port }
      : { type: "pair-session", pairingCode: codeInput.value.trim(), port };
    const result = await sendMessage(message);
    if (result?.pairingRequired === true) {
      paired = false;
      await loadStatus();
    }
    if (result?.ok !== true)
      throw new Error(result?.message ?? "The connection failed.");
    paired = true;
    setStatus(result.message, "success");
    await loadStatus();
  } catch (cause) {
    setStatus(
      cause instanceof Error ? cause.message : "The connection failed.",
    );
  } finally {
    setBusy(false);
  }
}

function sendMessage(message) {
  if (typeof browser !== "undefined")
    return browser.runtime.sendMessage(message);
  return new Promise((resolvePromise, rejectPromise) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error === undefined) resolvePromise(response);
      else rejectPromise(new Error(error.message));
    });
  });
}

function setBusy(busy) {
  button.disabled = busy;
  button.textContent = busy
    ? paired
      ? "Refreshing…"
      : "Connecting…"
    : paired
      ? "Refresh session"
      : "Connect and share session";
}

function setStatus(message, tone = "danger") {
  status.textContent = message;
  status.dataset.tone = tone;
}
