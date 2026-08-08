# ADR 0014: User-controlled browser session-pairing proof

## Status

Accepted as a proof of concept

## Context

Requiring operators to copy an authenticated cookie and seller key into an
environment file is unsuitable for a polished local application. The original
proof launched Edge through Playwright with a disposable profile. Although the
operator performed every login interaction, TCGplayer challenged and rejected
that instrumented browser context. The application must not evade or disguise
browser automation.

A normal browser deliberately prevents arbitrary local applications from
reading its authenticated cookies. A browser extension can provide an explicit,
user-initiated bridge with narrowly declared permissions.

## Decision

Replace the controlled-browser proof with an explicit `npm run auth:poc`
command and a local Manifest V3 WebExtension compatible with Firefox and
Chromium-family browsers.

The command binds an ephemeral proof service to `127.0.0.1` on port `47841`,
creates a random 64-bit one-time pairing code, and opens the Seller Portal in
the operator's regular default browser profile. It does not launch a debugging
session, create a browser profile, control a page, or inspect browser state.

After completing login, MFA, and any CAPTCHA normally, the operator opens the
locally installed **TCGPlayerAlert Session Connector** extension, enters the displayed
pairing code, and explicitly selects **Connect**. The extension requests only:

- the `cookies` capability with host access to
  `https://store.tcgplayer.com/*`; and
- network access to `http://127.0.0.1/*`.

It has no content script, background worker, page-inspection capability, or
storage permission. On Connect, it reads only the exact
`TCGAuthTicket_Production` cookie and submits it directly to the paired loopback
proof service. The service accepts extension origins only, verifies its exact
Host header, uses a bounded request body, compares the one-time code in constant
time, and immediately validates the cookie with the read-only authenticated
seller discovery in `tcgplayer-private-api`.

The loopback service accepts Chromium `chrome-extension://` and Firefox
`moz-extension://` origins. A dependency-free build step combines one shared
popup implementation with browser-specific manifests. Chromium receives a
manifest without Gecko metadata. Firefox receives its required extension ID and
declares `authenticationInfo` because the connector transmits a session ticket
to the local application for validation. The shared source uses the
WebExtensions cookie API with the appropriate Promise or callback form for each
browser family.

The proof never prints the cookie or seller key. It closes its pairing listener
after success, cancellation, timeout, or fatal validation failure and retains
neither value. It does not modify `.env.local` or application configuration.

## Consequences

- TCGplayer receives a normal, fully user-controlled browser login rather than an
  automation-instrumented browser.
- The operator must explicitly install the local extension and click Connect.
- The one-time code prevents an unrelated extension from silently claiming the
  short-lived loopback listener.
- Successful validation proves normal-browser session transfer and seller
  discovery, but not secure persistence, renewal, revocation, or multi-session
  ownership.
- A production stage requires Chrome Web Store, Microsoft Edge Add-ons, and
  Mozilla Add-ons distribution decisions, protected
  credential storage, centralized session replacement, explicit disconnect,
  and expiry/reconnection UX.
- `playwright-core` is no longer a runtime dependency.
