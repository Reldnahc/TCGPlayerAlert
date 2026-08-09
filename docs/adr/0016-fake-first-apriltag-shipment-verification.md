# ADR 0016: Fake-first AprilTag shipment verification lab

## Status

Accepted; supersedes the initial QR implementation of this lab.

## Context

An eventual workstation workflow may observe outgoing mail with a webcam and
mark an order shipped only when the physical parcel can be matched to exactly
one authoritative ready-to-ship order. OCR alone is a weak identity signal:
addresses can be duplicated, partially visible, or misread. Testing that idea
against seller orders would also risk an irreversible remote mutation.

The first fake lab used a 14 mm QR code. A Logitech C270 fixed-focus 720p
camera could not reliably focus on its dense 25-by-25 data matrix at the
intended basket distance. Increasing that code would consume too much of the
DYMO address label.

## Decision

Use a simulation-only Scan lab to prove the label, scanner, resolution, and
idempotency loop before connecting it to fulfillment. Replace the QR marker
with an AprilTag `tag36h11` fiducial. The printed marker is 14 mm including a
one-cell white quiet zone; its tag body is only eight cells square. The family
provides 587 tag identifiers with a nominal minimum Hamming distance of 11.
The detector accepts at most two corrected bits to reject false nested
detections while preserving modest print and camera damage tolerance.

Each fixed fake order maps a numeric tag identifier to an in-memory lab order.
The tag contains no order number, address, customer data, or seller data. The
existing Windows native-label adapter draws the marker through the installed
printer driver; the PDF fallback draws the same matrix as vector rectangles.
Production address-label actions remain unchanged and do not receive a marker.

The browser scanner is local and operator initiated. The camera is off by
default, starts only after the operator selects **Start camera**, examines
downscaled frames in memory, and stops only after repeated frames agree on a
marker. A tag belonging to the active ready-order pool requires five matching
reads. An unknown tag requires five exact, zero-correction reads before the lab
reports no match; corrected unknown reads are ignored. This prevents one noisy
frame from being treated as an order identity or a final no-match result. The
interface displays confirmation progress while the camera remains active.
Single uploaded images must produce an exact read. Image uploads are bounded to
10 MB. Neither frames nor uploads are persisted, logged, or sent to TCGplayer.
The official AprilTag 3 detector runs as WebAssembly in a
dedicated browser worker. Only one frame may be in flight; later camera frames
are dropped while detection is busy so scanning cannot build an unbounded queue
or block the operator interface. A frame containing multiple visual tags
requires review rather than choosing one.

Three synthetic cases exercise exactly one order match, no match, and two order
matches for one tag. Only one match produces a **Would mark shipped** result. A
repeated scan is recorded in an in-memory fake ledger and reports **Already
simulated**. No match and multiple matches require review. The lab print route
accepts only one of the fixed synthetic case identifiers and is injected with a
print-only function; it has no order service, seller client, or
shipment-mutation path.

Production activation is a separate decision. It will require a durable,
non-secret mapping from active tag identifiers to real orders, authoritative
ready-order reconciliation at scan time, explicit configuration, durable
idempotency, audit history, and a supervised live-order compatibility test.
Webcam motion detection and audible or visual signals are deferred until the
fiducial identity loop is proven on the intended camera, basket, and label
stock.

## Consequences

- The AprilTag is a deterministic identity signal while the camera remains a
  replaceable capture adapter; OCR is not required for the first production
  design.
- At the same 14 mm size, each AprilTag cell is materially larger than a cell
  in the rejected QR design, improving the fixed-focus camera experiment
  without taking more address space.
- The DYMO LabelWriter 450 path needs no vendor SDK because the application
  submits vector output through the installed Windows driver.
- A pinned, BSD-licensed WebAssembly build of the official AprilTag 3 detector
  performs browser detection, while a generated table from the same pinned
  source provides deterministic server-side vector labels.
- The operator can test a real printer and webcam without accessing customer
  data or changing a seller order.
- Passing the lab does not authorize unattended or real shipment mutations.
