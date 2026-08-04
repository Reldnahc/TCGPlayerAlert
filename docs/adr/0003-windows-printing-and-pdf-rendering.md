# ADR 0003: Windows printing and PDF rendering

- Status: Accepted
- Date: 2026-08-03

## Context

The first workflow sends a small structured address label to a locally attached label printer and a seller-provided PDF packing slip to an OS-visible network printer. Requiring an operator to install and configure a separate PDF viewer adds deployment state, while sending raw PDF bytes to a Windows queue is not portable because many printer drivers do not interpret PDF.

The printing design must remain independent of DYMO, Dell, Windows, and this pair of actions. It must also preserve idempotency and privacy when a print result is ambiguous.

## Decision

- Model print documents explicitly. The initial media types are structured address labels and PDFs.
- Give printer adapters declared media capabilities. Validate incompatible action/printer pairings before side effects.
- Implement `windows-native-label` with the built-in Windows `System.Drawing.Printing.PrintDocument` path. Pass text, page dimensions, margins, and font size as data; do not depend on a vendor SDK or PDF renderer.
- Implement `windows-pdf` as two inward-facing components: an Apache-licensed PDF.js page renderer backed by an MIT-licensed canvas runtime, and the same Windows print transport used for rendered pages. Pin both npm dependencies and record their provenance.
- Retain the `command` PDF adapter for custom deployments. It is no longer the Windows default.
- Use a random per-job temporary directory. Pass its path to a non-interactive PowerShell child through a sanitized environment, discard process output, and remove the directory after submission.
- Treat missing printers and document/rendering failures as definite pre-submission failures. Treat failures after the print process starts as ambiguous so orchestration requires review instead of retrying blindly.
- Keep printer names and rendering policy in local configuration. The committed example contains placeholders only.

## Consequences

The initial Windows deployment needs Node.js, the application dependencies, Windows PowerShell 5.1, and installed printer drivers; it does not need SumatraPDF, Adobe Reader, DYMO application software, or a vendor SDK. Packing slips are rasterized before Windows submission, so DPI controls the memory/quality tradeoff and the renderer enforces page-count and pixel limits.

Windows is isolated to adapters. Future transports can accept the same typed documents or introduce explicit capabilities such as IPP and raw PDF without changing rule evaluation or marketplace orchestration.
