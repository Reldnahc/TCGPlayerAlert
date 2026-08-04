# Printing

## Adapter contract

The initial `command` printer writes the PDF to an access-restricted temporary file, launches the configured executable directly with `shell: false`, waits for the process result, and removes the temporary file. Supported argument placeholders are `{file}`, `{printer}`, and `{job}`.

This makes the application independent of a specific PDF viewer, printer vendor SDK, operating system queue, network protocol, or printer name. A deployment can use any command that accepts a PDF path and submits it to the desired OS-visible printer.

## Initial actions

`print-address-label` renders a PDF using configurable dimensions, margin, font size, address-line template, and printer. Supported template fields are:

- `{recipientName}`
- `{addressOne}`
- `{addressTwo}`
- `{city}`
- `{territory}`
- `{postalCode}`
- `{country}`

`print-packing-slip` submits the validated PDF returned by the seller provider without rewriting it.

## Safe setup

1. Leave `dryRun` enabled.
2. Set the executable path, argument list, and exact OS printer name for each printer.
3. Build the application and run `config validate`.
4. Run `print test --action print-address-label` and verify the synthetic label's size, orientation, and destination.
5. Run `print test --action print-packing-slip` and verify the synthetic page's destination and scaling.
6. Only then set `dryRun` to `false`.

The test commands intentionally print but contain no customer data.

## Failure semantics

- If the executable cannot start, the action is a definite `PRINT_FAILED` and may retry within the configured attempt limit.
- After the print process starts, a timeout, abnormal exit, cancellation, or lost confirmation is `PRINT_AMBIGUOUS`.
- Ambiguous and process-interrupted submissions become `review-required`; the application never prints them again automatically.

Printer process output is discarded so a third-party tool cannot place customer data in application logs. Customer addresses and PDF bytes are never written to durable workflow state.
