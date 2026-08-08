# TCGPlayerAlert cross-browser session connector

This directory contains the shared WebExtensions source and browser-specific
manifests for a proof-of-concept bridge between a
normal, user-controlled TCGplayer Seller Portal login and the local
`npm run auth:poc` command. The same source works in Firefox and Chromium-family
browsers such as Chrome, Edge, Brave, and Vivaldi.

Build both installable directories before loading the connector:

```powershell
npm run build:extension
```

## Install in Chromium-family browsers

1. Open the browser's extensions page, such as `chrome://extensions` or
   `edge://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose `dist/browser-extension/chromium`.
4. Pin **TCGPlayerAlert Session Connector** so its button is visible.

## Install temporarily in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Select **Load Temporary Add-on**.
3. Choose `dist/browser-extension/firefox/manifest.json`.

Firefox removes temporary add-ons when it restarts. A production distribution
would be packaged and signed through Mozilla rather than asking users to keep a
temporary developer installation.

## Connect

1. Run `npm run auth:poc` from the application repository.
2. Sign in normally in the default-browser window it opens.
3. Select the connector extension, paste the one-time pairing code, and select
   **Connect**.

The extension requests cookie access only for `store.tcgplayer.com` and network
access only to loopback. It has no content scripts, does not inspect page
contents, does not store the seller session, and cannot persist it in the
application. The proof validates the session and then discards it.
