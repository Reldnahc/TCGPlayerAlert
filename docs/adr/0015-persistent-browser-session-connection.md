# ADR 0015: Persistent browser-owned seller session connection

## Status

Accepted

## Context

The user-controlled browser pairing proof established that Firefox and
Chromium-family browsers can explicitly provide the authenticated
`TCGAuthTicket_Production` cookie to the loopback-only application without
automating the TCGplayer login page. The proof deliberately discarded the
cookie and used a temporary extension, so it did not replace environment-file
credentials or handle session rotation and expiration.

## Decision

The application owns one process-wide seller-session manager. Every private API
client receives an asynchronous session provider and resolves the current
seller key when an operation begins. Replacing the manager's credential
therefore affects polling, fulfillment, inventory, pricing, payments, feedback,
and messages without rebuilding services or restarting the application.

On Windows, browser-provided credentials are serialized to an ignored local
file only after encryption with Windows DPAPI in current-user scope. Secret
bytes travel to the fixed PowerShell DPAPI helper through standard input, never
through command arguments, environment variables, logs, browser responses, or
application configuration. Existing environment credentials remain a migration
fallback until the first browser connection is saved.

The running local console creates a short-lived one-time pairing code. The
extension reads only the exact seller-session cookie after an explicit Connect
action and posts it to the console's loopback origin. After validation through
authenticated seller discovery, the application returns a random connector
token. The application stores that token with DPAPI and the extension stores it
in extension-local storage. Later cookie changes and a bounded periodic check
may replace the session using that token without repeating the pairing code.
The extension never controls or reads Seller Portal pages.

An authentication-required result from the private client marks the shared
session expired, clears the unusable cookie, and retains the connector token so
the installed extension can provide a renewed browser session. The console
shows the disconnected state, ordinary API reads fail with an explicit
authentication-required response, scheduled synchronization waits, and queued
mutations remain pending. A true Seller Portal logout still requires the
operator to complete TCGplayer login, MFA, and CAPTCHA normally.

Firefox development builds remain temporary until the package is signed by
Mozilla. Signing changes distribution, not the session protocol or application
architecture. Chromium and Firefox builds share behavior but use their
browser-specific Manifest V3 background declaration.

The Firefox build requires Firefox 140 or newer and declares required
`authenticationInfo` handling so Firefox presents its built-in data consent at
installation. A public privacy policy documents the exact cookie, loopback-only
destination, automatic renewal timing, protected application storage, and
deletion controls for Mozilla review and operator inspection.

## Consequences

- `.env.local` is no longer required after the first protected browser
  connection, but remains supported as an explicit migration fallback.
- Disconnect writes an intentional disconnected marker so environment
  credentials do not silently reactivate after restart.
- Browser auto-renewal is limited to the exact authentication cookie and the
  paired loopback application. It does not refresh TCGplayer itself or bypass a
  login requirement.
- Switching seller accounts requires an explicit new pairing rather than a
  silent token-authenticated renewal.
- Non-Windows protected persistence remains unavailable until a platform keyring
  adapter is implemented.
