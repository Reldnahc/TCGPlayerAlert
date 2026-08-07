# Dependency provenance

## tcgplayer-private-api

- npm contract: `tcgplayer-private-api@0.5.2`
- Source repository: <https://github.com/Reldnahc/tcgplayer-private-api>
- Source commit: `efca6f121171ebae899cce6844fcb3a8459efbb9`
- Development artifact: `tcgplayer-private-api-0.5.2.tgz`
- Publication status: unpublished

The local tarball is generated from the adjacent repository and excluded from Git. `package-lock.json` records its package version and integrity. CI checks out the exact source commit above, builds the tarball, and installs it through npm before validating this application.

After the package is published, replace the file dependency with the immutable registry version and update this document and CI together.

## pdf-lib

- npm package: `pdf-lib@1.17.1`
- License: MIT
- Purpose: generate configurable address-label PDFs and synthetic printer-test documents

## pdfjs-dist

- npm package: `pdfjs-dist@5.4.624`
- Project: <https://github.com/mozilla/pdf.js>
- License: Apache-2.0
- Purpose: parse and render packing-slip PDFs inside the application without an installed PDF viewer

## @napi-rs/canvas

- npm package: `@napi-rs/canvas@0.1.88`
- Project: <https://github.com/Brooooooklyn/canvas>
- License: MIT
- Purpose: provide the cross-platform canvas implementation used by PDF.js to produce print-ready PNG pages

Both dependencies are pinned. Their platform-specific runtime artifacts are installed through npm and covered by the normal dependency audit. No PDF-viewer executable is copied into this repository.

No upstream application source from `todd-skelton/tcgplayer-automation-app` is copied into this repository.
