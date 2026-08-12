# Store graphics

- `connector-screenshot-1280x800.png` is the shared listing screenshot.
- `chrome-small-promo-440x280.png` is the Chrome Web Store small promotional
  tile.
- `../icons/icon-128.png` is the store icon for both listings.

The icon sizes and small promotional tile are generated from
`../icons/icon.svg` by `scripts/generate-browser-extension-assets.mjs`.
Regenerate them with `npm run build:extension` after changing the source
artwork. The screenshot is a verified capture of the extension popup and should
be refreshed when the popup layout materially changes.
