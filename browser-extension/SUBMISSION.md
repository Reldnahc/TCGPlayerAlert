# Browser extension submission guide

This file contains the copy-ready store metadata and reviewer notes for version
0.1.0 of **TCGPlayerAlert Session Connector**. Run `npm run package:extension`
before uploading. The command creates browser-specific ZIP files and SHA-256
checksums in `artifacts/browser-extension`.

## Shared listing details

- **Name:** TCGPlayerAlert Session Connector
- **Category:** Productivity
- **Language:** English (United States)
- **Homepage:** https://github.com/Reldnahc/TCGPlayerAlert
- **Support:** https://github.com/Reldnahc/TCGPlayerAlert/issues
- **Privacy policy:** https://github.com/Reldnahc/TCGPlayerAlert/blob/main/browser-extension/PRIVACY.md
- **License:** All Rights Reserved. The repository currently has no top-level
  open-source license; do not select one in a store until that changes.

### Short description

Connects a signed-in TCGplayer seller session to the local TCGPlayerAlert app
after an explicit user-approved pairing.

### Detailed description

TCGPlayerAlert Session Connector links an ordinary, user-controlled TCGplayer
Seller Portal login to the TCGPlayerAlert application running on the same
computer.

Open the connector, enter the one-time pairing code shown by the local app, and
select **Connect and share session**. The connector reads only the exact
TCGplayer seller authentication cookie and sends it only to the paired app at
127.0.0.1. Cookie changes and a five-minute local renewal check keep the paired
session current.

The connector does not automate login, inspect Seller Portal pages, read orders
or messages, inject content, collect analytics, display ads, track browsing, or
download executable code. It cannot run in private browsing. TCGPlayerAlert is
not affiliated with, endorsed by, or supported by TCGplayer.

The local TCGPlayerAlert application is required. Source and setup instructions
are available from the project homepage.

## Chrome Web Store

Upload `tcgplayer-alert-session-connector-chromium-0.1.0.zip`.

### Single purpose

Securely pair the browser's existing TCGplayer Seller Portal authentication
session with the user-installed TCGPlayerAlert application on the same
computer.

### Permission justifications

- **cookies:** Reads only the cookie named `TCGAuthTicket_Production` so the
  local application can use the seller session explicitly authorized by the
  user.
- `https://store.tcgplayer.com/*`: Limits cookie access to the Seller Portal
  origin that creates the required authentication cookie.
- `http://127.0.0.1/*`: Sends pairing and session-renewal requests to a
  user-selected port of TCGPlayerAlert on the same computer. The configurable
  port requires the wildcard port scope.
- **storage:** Stores only the random connector token returned after pairing and
  the selected loopback port. It never stores the TCGplayer cookie.
- **alarms:** Performs one local renewal check every five minutes so a rotated
  or renewed Seller Portal cookie reaches the paired application.

### Privacy practices answers

- Select **Authentication information** as the only collected/handled data
  category.
- State that the data is used only for the extension's single purpose.
- Certify that the data is not sold, used for advertising or creditworthiness,
  transferred to third parties, or used for purposes unrelated to the single
  purpose.
- Certify that no remote code is used.
- Use the privacy-policy URL above. The policy contains the Chrome Web Store
  Limited Use disclosure.

### Chrome listing assets

- Store icon: `browser-extension/icons/icon-128.png`
- Screenshot: `browser-extension/store-assets/connector-screenshot-1280x800.png`
- Small promo tile: `browser-extension/store-assets/chrome-small-promo-440x280.png`

## Mozilla Add-ons

Upload `tcgplayer-alert-session-connector-firefox-0.1.0.zip` as a listed
Firefox Desktop extension. Do not enable Firefox for Android distribution;
TCGPlayerAlert is a local desktop application. The stable add-on ID is
`session-connector@tcgplayeralert.local`.

The manifest requires Firefox 140 or later and declares
`authenticationInfo` as required data collection. Firefox therefore presents
its built-in disclosure and consent during installation. The extension also
shows its own specific cookie and destination disclosure before the initial
pairing action.

### Reviewer notes

The extension is dependency-free and its shipped JavaScript is human-readable,
unminified source. There is no transpilation, bundling, generated JavaScript,
remote code, content script, telemetry, or analytics. A separate source archive
is not necessary: the uploaded archive contains the reviewable source exactly
as executed. The only build transformation selects `firefox-manifest.json` as
`manifest.json` and copies the shared source and generated PNG icons.

To exercise the full pairing flow:

1. Follow the application setup in the repository README and run
   `npm run start`.
2. Open `http://127.0.0.1:47831`, select **Connect**, and copy the one-time
   pairing code.
3. Sign in normally to `https://store.tcgplayer.com/admin` using an authorized
   seller test account. The extension does not automate or bypass login, MFA,
   CAPTCHA, or access controls.
4. Open the extension, enter the pairing code, and select **Connect and share
   session**.
5. Confirm the local application's connection panel changes to connected.

The maintainers cannot provide a third-party seller credential through review
notes. Reviewers can still verify the missing-cookie error path without an
account and inspect the complete cookie name, origin restriction, loopback-only
destination, pairing-token check, and storage behavior in the submitted source.

## Pre-submission checklist

1. Confirm the current README and choose **All Rights Reserved** unless a
   top-level project license is intentionally added before submission.
2. Run `npm run check` and `npm run package:extension` from a clean checkout.
3. Confirm the ZIP manifest is at the archive root and matches version 0.1.0.
4. Compare both ZIP hashes with `artifacts/browser-extension/SHA256SUMS.txt`.
5. Test the unpacked Chromium build and temporary Firefox build on clean browser
   profiles, including missing app, missing cookie, invalid code, successful
   pairing, session refresh, application disconnect, and browser restart.
6. Enter the privacy answers exactly as documented above; dashboard disclosures
   must not contradict the manifest, popup, listing, or privacy policy.
7. Upload each browser's corresponding ZIP and its listing assets. Store-issued
   signatures and IDs are external release artifacts and are not committed.
