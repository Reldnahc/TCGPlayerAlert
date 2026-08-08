# ADR 0014: Disposable managed-login proof

## Status

Accepted as a proof of concept

## Context

Requiring operators to copy an authenticated cookie and seller key into an environment file is unsuitable for a polished local application. Before designing encrypted persistence and reconnection, the project must prove that TCGplayer accepts a visible browser context launched by the application and that the resulting seller session can be validated without prior seller-key configuration.

## Decision

Provide an explicit `npm run auth:poc` command on Windows. It launches installed Microsoft Edge through `playwright-core` with a newly created profile under the operating-system temporary directory. The operator completes login, MFA, and any CAPTCHA directly in that visible window; the application does not enter, inspect, or retain those values.

The process polls only its own browser context for the exact `TCGAuthTicket_Production` cookie. Once present, it passes the value directly to `tcgplayer-private-api` 0.9.0, whose read-only authenticated-seller identity method validates the session and discovers the seller key. Neither value is printed. The Edge context is closed and its temporary profile is recursively removed after success, cancellation, timeout, or failure.

This proof does not persist the cookie, modify `.env.local`, update application configuration, start background workers, or add a browser-delivered credential endpoint. Full login integration requires a separate credential-store and centralized-session design.

## Consequences

- The test exercises a real user-driven login without reading the operator's normal Edge or Chrome profile.
- TCGplayer remains free to reject a controlled browser; failure is reported without attempts to evade bot or access controls.
- Successful validation proves browser acquisition, cookie visibility, and seller discovery, but not secure long-term session storage.
- `playwright-core` is a runtime dependency, but no browser binary is downloaded or bundled.
