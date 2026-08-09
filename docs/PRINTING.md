# Printing

## Adapter contract

Actions submit typed documents to capability-oriented printer adapters. The first adapters are:

- `windows-native-label` draws structured address text through Windows `PrintDocument` and the installed printer driver. It does not create a PDF or require a PDF viewer.
- `windows-pdf` renders PDF pages inside the application with PDF.js, then sends the rendered pages through Windows `PrintDocument` and the installed printer driver. It does not require SumatraPDF, Adobe Reader, or another separately installed viewer.
- `command` remains an escape hatch for a deployment-supplied PDF print command. It invokes the executable directly with `shell: false`; supported placeholders are `{file}`, `{printer}`, and `{job}`.

Renderer, document, and printer transport are separate contracts. A future IPP, raw-PDF, macOS, Linux, or vendor adapter can be added without changing rules or order orchestration.

## Initial actions

Each action has an independent `enabled` setting. A disabled action is omitted from the workflow even when a matched rule names it. This provides global “no address label” and “no packing slip” modes without changing rule conditions.

`print-address-label` creates a structured label using configurable dimensions, margin, font size, address-line template, and printer. A PDF remains available as a fallback for PDF-capable adapters and for preview validation.

The native Windows adapter describes custom stock in portrait dimensions and selects landscape orientation automatically when the configured label is wider than it is tall. This avoids vendor drivers rotating wide labels sideways. It preserves the printer driver's hardware margin, normalizes driver-reported printable dimensions to the requested orientation, then applies the configured label margin within that printable area. This normalization handles label drivers that return portrait-oriented printable dimensions for a landscape job. Text and QR output are rejected when they cannot fit instead of being drawn beyond the stock edge.

## Synthetic QR labels

The Scan lab can submit an explicitly requested synthetic address label through
the configured address-label adapter even when address-label automation is
disabled. It reserves 14 mm at the right edge for a QR code and keeps a
four-module quiet zone. The native Windows adapter draws its modules through
`PrintDocument`; PDF-only adapters receive the same matrix rendered as vector
rectangles. The QR payload and address belong to fixed fake lab cases.

This path is a printer/scanner proof only. Normal order labels and pasted
Dashboard labels do not include a QR code, and printing a lab label cannot
contact TCGplayer or mark an order shipped.

Supported template fields are:

- `{recipientName}`
- `{addressOne}`
- `{addressTwo}`
- `{city}`
- `{territory}`
- `{postalCode}`
- `{country}`

`omitLineValues` removes exact rendered lines case-insensitively. For example, `["US", "USA"]` suppresses domestic country-only lines without removing an international country such as `Canada`.

The Dashboard also provides a manual address-label tool. It accepts pasted multiline text and prints the non-empty lines in their original order using the saved address-label printer, dimensions, margin, font size, orientation, and `omitLineValues`. Manual printing remains available when address-label automation is disabled because it is an explicit operator action. Input is limited to eight lines and 1,024 characters and is never added to application state, responses, or logs. Like order labels, it passes through the random short-lived spool workspace described below and is removed after submission.

`print-packing-slip` accepts the validated PDF returned by the seller provider. The `windows-pdf` adapter renders each page at the configured DPI and preserves the PDF page aspect ratio. Its scale options are:

- `actual-size` - retain the physical PDF page size even if it clips.
- `fit` - grow or shrink to the printer's available page area.
- `shrink` - retain actual size unless the page must shrink to fit. This is the recommended packing-slip default.

PDF.js accepts PDFs up to 50 MiB, renders at most 50 pages per document, rejects pages over 40 million pixels, and caps a job at 100 million rendered pixels. These limits bound memory use if a remote document is malformed.

## Safe setup

1. Leave both automated print outputs disabled.
2. Run `npm run configure` and select the exact installed printer for each output. Each printer card has a test button that uses its currently visible printer, label, scaling, and DPI values without saving them. Testing remains available while an output is disabled.
3. Build the application and run `config validate`.
4. Click `Print test label`, or run `print test --action print-address-label`, and verify the synthetic label's size, orientation, and destination.
5. Click `Print test sheet`, or run `print test --action print-packing-slip`, and verify the synthetic page's destination and scaling.
6. Only then enable the individual output or outputs whose tests routed correctly.

The buttons and test commands intentionally submit real print jobs, but their documents contain only obvious synthetic data and no seller credentials, customer addresses, or order details. The packing-slip test sheet includes an inset border so clipping and page scaling are easy to spot.

The settings UI listens on `127.0.0.1` only, discovers queues without submitting jobs, and preserves a configured printer name if that printer is offline during discovery. Configuration changes are validated as a whole before the ignored local JSON file is atomically replaced.

## Temporary data and child processes

Customer text, source PDFs, and rendered pages are never written to workflow state or logs. Print data is written only to a random per-job directory under `spoolDirectory`, removed after submission, and excluded from Git. The native PowerShell child receives only the payload path; seller credentials and unrelated environment variables are not inherited.

The Windows adapters require Windows PowerShell 5.1 and an installed Windows printer driver. Both ship with supported Windows versions or with the printer, so no separate PDF application is required.

## Failure semantics

- An unsupported platform, missing executable, missing printer, invalid document, or pre-submission cancellation is a definite `PRINT_FAILED` and may retry within the configured attempt limit.
- After Windows print submission starts, a timeout, abnormal exit, cancellation, or lost confirmation is `PRINT_AMBIGUOUS`.
- Ambiguous and process-interrupted submissions become `review-required`; the application never prints them again automatically.

Printer process output is discarded so an operating-system component or custom command cannot place customer data in application logs.
