# TCGPlayerAlert browser session connector

This directory contains the shared WebExtensions implementation and
browser-specific Manifest V3 manifests. The connector bridges an ordinary,
user-controlled TCGplayer Seller Portal login to the loopback-only
TCGPlayerAlert application. It does not automate login or inspect page content.

Build both browser directories:

```powershell
cd C:\Users\cwmle\Documents\TCGPlayerAlert\TCGPlayerAlert
npm run build:extension
```

## Firefox development installation

The Firefox build requires Firefox 140 or newer. This guarantees that Firefox
can present its built-in consent for the manifest's required
`authenticationInfo` transmission before installation.

1. Open a normal Firefox window in the profile where you use the Seller Portal.
2. Enter `about:debugging#/runtime/this-firefox` in the address bar.
3. Select **Load Temporary Add-on**.
4. Select
   `C:\Users\cwmle\Documents\TCGPlayerAlert\TCGPlayerAlert\dist\browser-extension\firefox\manifest.json`.
   Select `manifest.json`, not the directory.
5. Confirm that **TCGPlayerAlert Session Connector** appears under **Temporary
   Extensions**.
6. Open Firefox's puzzle-piece Extensions menu, use the gear beside the
   connector, and select **Pin to Toolbar**.

Firefox removes temporary development add-ons on restart. Reload the manifest
after a restart until the release package is signed through Mozilla. The
application's DPAPI-protected credential remains stored; reinstalling the
extension may require a new one-time pairing if Firefox cleared extension-local
storage.

## Store submission packages

Build and validate both upload archives:

```powershell
npm run package:extension
```

This runs Mozilla's official add-on linter with warnings treated as errors, then
creates the Chromium and Firefox ZIP files plus SHA-256 checksums under
`artifacts/browser-extension`. Store listing copy, permission justifications,
privacy-form answers, reviewer notes, asset paths, and the final checklist are
in [SUBMISSION.md](SUBMISSION.md).

The Firefox package has a stable Gecko extension ID, requires Firefox 140 or
newer, and declares `authenticationInfo` through Mozilla's built-in data
collection consent system. The Chromium popup provides a prominent disclosure
and explicit pairing action before transmitting the same authentication
information. Both packages exclude private-browsing access, contain no remote
code or page inspection, and use the public [privacy policy](PRIVACY.md).

Mozilla and Google submission, store-form entry, signing, and publication are
external release steps performed through the operator's store accounts.

## Chromium-family development installation

1. Open `chrome://extensions`, `edge://extensions`, or the browser's equivalent.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose
   `dist/browser-extension/chromium`.
4. Pin **TCGPlayerAlert Session Connector**.

## Pair once

1. Run the application with `npm run start` and open
   `http://127.0.0.1:47831`.
2. Select **Connect** in the TCGplayer connection panel.
3. Sign in normally at `https://store.tcgplayer.com/admin` in the same browser
   profile. Complete MFA or CAPTCHA yourself.
4. Open the connector, enter the application's pairing code and port, then
   select **Connect browser**.
5. The application changes to **connected** after it validates and protects the
   session.

The extension stores a random connector token, not the TCGplayer session
cookie. It sends the current exact authentication cookie when that cookie
changes and performs a local renewal check every five minutes. Those checks
contact only `127.0.0.1`; they do not issue TCGplayer API requests.

## When TCGplayer logs out

If TCGplayer rotates the cookie while the browser remains authenticated, the
connector sends the replacement automatically. If the browser is actually
logged out:

1. Sign in to the Seller Portal normally.
2. Open the connector.
3. Select **Refresh session**.

If the connector reports that pairing is required, generate a new code from
the application and pair again. A custom application port must also be entered
in the connector's Connection settings.

The extension requests cookie access only for `store.tcgplayer.com`, extension
storage for its connector token, alarms for the bounded local renewal check,
and network access to `127.0.0.1`. It has no content scripts or page-inspection
capability.
