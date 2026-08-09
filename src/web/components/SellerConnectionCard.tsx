import { useState } from "preact/hooks";
import { Button, Notice, StatusBadge } from "./ui.js";
import { useAuthentication } from "../state/AuthenticationContext.js";
import { dateTime } from "../utils.js";

export function SellerConnectionCard({
  compact = false,
}: {
  readonly compact?: boolean;
}) {
  const { status, pairing, loading, busy, error, beginPairing, disconnect } =
    useAuthentication();
  const [copied, setCopied] = useState(false);
  const state = status?.state ?? "disconnected";
  const connected = state === "connected";
  const title =
    state === "expired"
      ? "TCGplayer session expired"
      : connected
        ? "TCGplayer connected"
        : "Connect TCGplayer";
  const detail =
    state === "expired"
      ? "Sign in normally if needed, then send the current browser session with the connector."
      : connected
        ? status?.automaticRenewal === true
          ? "The browser connector can replace this session when TCGplayer rotates it."
          : "This session came from the environment file. Pair the browser to enable protected renewal."
        : "Pair the browser connector once. Login, MFA, and CAPTCHA remain entirely browser-controlled.";

  async function copyCode() {
    if (pairing === null) return;
    await navigator.clipboard.writeText(pairing.pairingCode);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <section
      class={`seller-connection${compact ? " seller-connection--compact" : ""}`}
    >
      <div class="seller-connection__summary">
        <div>
          <div class="seller-connection__title">
            <h2>{title}</h2>
            {loading && status === null ? null : <StatusBadge status={state} />}
          </div>
          <p>{detail}</p>
          {status?.updatedAt === undefined ? null : (
            <small>Updated {dateTime(status.updatedAt)}</small>
          )}
        </div>
        <div class="seller-connection__actions">
          <a
            class="button button--secondary"
            href="https://store.tcgplayer.com/admin"
            target="_blank"
            rel="noreferrer"
          >
            Seller Portal
          </a>
          <Button
            tone="primary"
            busy={busy}
            onClick={() => void beginPairing().catch(() => undefined)}
          >
            {connected ? "Pair browser" : "Connect"}
          </Button>
          {connected ? (
            <Button
              tone="danger"
              busy={busy}
              onClick={() => void disconnect().catch(() => undefined)}
            >
              Disconnect
            </Button>
          ) : null}
        </div>
      </div>
      {pairing === null ? null : (
        <div class="seller-connection__pairing">
          <div>
            <span>Pairing code</span>
            <strong>{pairing.pairingCode}</strong>
          </div>
          <div>
            <span>Local port</span>
            <strong>{pairing.port}</strong>
          </div>
          <Button onClick={() => void copyCode()}>
            {copied ? "Copied" : "Copy code"}
          </Button>
          <p>
            Open the pinned TCGPlayerAlert connector in the same browser
            profile, enter this code and port, then select Connect browser.
          </p>
        </div>
      )}
      {error === "" ? null : <Notice tone="danger">{error}</Notice>}
    </section>
  );
}
