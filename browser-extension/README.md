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

## Firefox unlisted signing

The connector is prepared for private, self-distributed signing rather than a
public AMO listing:

- It has a stable Gecko extension ID and requires Firefox 140 or newer.
- It declares `authenticationInfo` as required data in the Firefox manifest.
- Its [privacy policy](PRIVACY.md) explains the exact cookie, loopback
  destination, renewal timing, storage, retention, and permissions.
- The source is readable, dependency-free, and contains no remote code,
  analytics, content scripts, or page inspection.

Run `npm run build:extension` before packaging. The Firefox output includes the
privacy policy in `dist/browser-extension/firefox`. When submitting the build
to Mozilla as an unlisted add-on, use this public privacy-policy URL:

`https://github.com/Reldnahc/TCGPlayerAlert/blob/main/browser-extension/PRIVACY.md`

Mozilla signing is an external release step and requires the submitting
operator's AMO account. The signed `.xpi` can then be installed permanently
through Firefox's **Install Add-on From File** command without making the
extension publicly searchable.

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
