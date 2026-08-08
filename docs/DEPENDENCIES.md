# Dependency provenance

## tcgplayer-private-api

- npm contract: `tcgplayer-private-api@0.9.0`
- Source repository: <https://github.com/Reldnahc/tcgplayer-private-api>
- Source commit: `f82e5c29ddc1c6b7c4761ff3859a88ba3595d1c3`
- Development artifact: `tcgplayer-private-api-0.9.0.tgz`
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

## playwright-core

- npm package: `playwright-core@1.61.1`
- Project: <https://playwright.dev/>
- License: Apache-2.0
- Purpose: launch the operator's installed Microsoft Edge for the disposable managed-login proof of concept

`playwright-core` contains no browser binary. The proof of concept uses a new temporary Edge profile, never reads an existing browser profile, and removes its profile after the attempt.

## Operator console

- `preact@10.29.8` (MIT) provides the small, typed component runtime shipped to the loopback-only browser UI.
- `vite@8.2.1` and `@preact/preset-vite@2.10.6` (MIT) compile and hash the browser assets during development and release builds; they are not loaded by the running service.
- Testing Library and jsdom are pinned development-only dependencies used for interaction tests. The compiled application and server route tests remain part of `npm test`.

No upstream application source from `todd-skelton/tcgplayer-automation-app` is copied into this repository.
