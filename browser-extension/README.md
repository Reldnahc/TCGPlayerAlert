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

1. Open a normal Firefox window in the profile where you use the TCGplayer
   Seller Portal. Do not use a private window for this proof.
2. Enter `about:debugging#/runtime/this-firefox` in the address bar and press
   Enter.
3. On the **This Firefox** page, select **Load Temporary Add-on**.
4. In the file picker, open
   `C:\Users\cwmle\Documents\TCGPlayerAlert\TCGPlayerAlert\dist\browser-extension\firefox`
   and select `manifest.json`. Select the file itself, not the directory.
5. Confirm that **TCGPlayerAlert Session Connector** appears in the
   **Temporary Extensions** list.
6. Select Firefox's Extensions button (the puzzle-piece icon) in the main
   toolbar.
7. Find **TCGPlayerAlert Session Connector**, select its gear menu, and select
   **Pin to Toolbar**. Its button should now remain visible beside the address
   bar.

Firefox removes temporary add-ons when it restarts. A production distribution
would be packaged and signed through Mozilla rather than asking users to keep a
temporary developer installation.

## Connect with Firefox

1. In PowerShell, change to the application repository and start the proof:

   ```powershell
   cd C:\Users\cwmle\Documents\TCGPlayerAlert\TCGPlayerAlert
   npm run auth:poc
   ```

2. Leave that PowerShell window running. It displays a new one-time pairing
   code and listens locally on port `47841`.
3. The command opens the Seller Portal in your default browser. If that is not
   Firefox, manually open `https://store.tcgplayer.com/admin` in the same
   Firefox profile where you loaded the connector.
4. Sign in normally. Complete any MFA or CAPTCHA yourself, then make sure the
   Seller Portal page has finished loading.
5. Select the pinned **TCGPlayerAlert Session Connector** button.
6. Paste the current pairing code from PowerShell. Leave **Local port** set to
   `47841`, then select **Connect**.
7. Success is reported in both places: the popup says the session was validated
   without saving it, and PowerShell says the proof completed.

## Firefox troubleshooting

- **The connector disappeared:** Firefox removes temporary add-ons on restart.
  Repeat the temporary installation steps above.
- **No signed-in seller session was found:** Sign in to the Seller Portal in
  the same Firefox profile, reload the portal tab, and select **Connect** again.
- **The local application could not be reached:** Keep `npm run auth:poc`
  running and confirm that the popup port matches the port printed in
  PowerShell (`47841` by default).
- **The pairing code was rejected:** Use the code printed by the current
  `npm run auth:poc` process. Codes from earlier runs are invalid.
- **The extension button is missing:** Open the puzzle-piece Extensions menu,
  use the gear beside the connector, and select **Pin to Toolbar**.

## Connect with a Chromium-family browser

1. Run `npm run auth:poc` from the application repository.
2. Sign in normally in the default-browser window it opens.
3. Select the connector extension, paste the one-time pairing code, and select
   **Connect**.

The extension requests cookie access only for `store.tcgplayer.com` and network
access only to loopback. It has no content scripts, does not inspect page
contents, does not store the seller session, and cannot persist it in the
application. The proof validates the session and then discards it.
