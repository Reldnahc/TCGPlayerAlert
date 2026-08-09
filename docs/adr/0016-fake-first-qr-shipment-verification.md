# ADR 0016: Fake-first QR shipment verification lab

## Status

Accepted

## Context

An eventual workstation workflow may observe outgoing mail with a webcam and
mark an order shipped only when the physical parcel can be matched to exactly
one authoritative ready-to-ship order. OCR alone is a weak identity signal:
addresses can be duplicated, partially visible, or misread. Testing that idea
against seller orders would also risk an irreversible remote mutation.

## Decision

Add a simulation-only Scan lab to prove the label, scanner, resolution, and
idempotency loop before connecting it to fulfillment.

The lab prints a 14 mm QR code with a four-module quiet zone and Q error
correction beside an obviously synthetic address. Its payload is a versioned,
opaque verification code rather than an order number, address, or seller data.
The existing Windows native-label adapter draws the QR modules through the
printer driver; the PDF fallback draws the same matrix as vector rectangles.
Production address-label actions remain unchanged and do not receive a QR code.

The browser scanner is local and operator initiated. The camera is off by
default, starts only after the operator selects **Start camera**, examines
downscaled frames in memory, and stops after decoding a QR code. Image uploads
are bounded to 10 MB. Neither frames nor uploads are persisted, logged, or sent
to TCGplayer.

Three synthetic cases exercise exactly one match, no match, and two matches.
Only one match produces a **Would mark shipped** result. A repeated scan is
recorded in an in-memory fake ledger and reports **Already simulated**. No match
and multiple matches require review. The lab print route accepts only one of
the fixed synthetic case identifiers and is injected with a print-only
function; it has no order service, seller client, or shipment-mutation path.

Production activation is a separate decision. It will require opaque codes
bound durably to real orders, authoritative ready-order reconciliation at scan
time, explicit configuration, durable idempotency, audit history, and a
supervised live-order compatibility test. Webcam motion detection and audible
or visual signals are also deferred until the QR identity loop is proven on
the intended camera and label stock.

## Consequences

- The QR code is a deterministic identity signal while the camera remains a
  replaceable capture adapter; OCR is not required for the first production
  design.
- The DYMO LabelWriter 450 path needs no vendor SDK because the application
  already submits raster/vector output through the installed Windows driver.
- QR generation and raw-pixel decoding add two pinned runtime dependencies and
  a lazily loaded browser chunk.
- The operator can test a real printer and webcam without accessing customer
  data or changing a seller order.
- Passing the lab does not authorize unattended or real shipment mutations.
