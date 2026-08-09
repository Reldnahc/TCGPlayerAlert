# ADR 0017: Opt-in production shipment scanner

## Status

Accepted; activates the production path proven by ADR 0016. ADR 0018 later
retires the simulation lab after successful workstation validation.

## Context

The synthetic AprilTag basket test established that the installed label
printer, label stock, fixed-focus camera, WebAssembly detector, five-read
consensus, parcel-removal latch, and empty-frame re-arm loop work together at
the intended workstation. Production use must connect that identity signal to
real fulfillment without letting a noisy frame, stale browser list, collision,
duplicate request, process interruption, or uncertain seller response ship the
wrong order.

`tag36h11` has 587 identifiers and cannot encode a seller order number. The tag
must remain free of customer and order data. A finite family can also produce
identifier collisions, so an identifier alone is never sufficient evidence to
choose an order.

## Decision

Add a production **Scanner** workspace. Production scanning is disabled for
new and migrated configuration. Settings exposes three independent choices:

1. enable shipment tags on configured order-address labels;
2. opt in to automatically marking an exact match shipped; and
3. enable local audible success and failure cues.

Automatic shipment changes cannot be enabled while shipment scanning is
disabled. Pasted Dashboard labels and printer-test labels do not acquire a
production shipment identity. Existing labels printed before scanning was
enabled remain ordinary labels and cannot be used by the production scanner.

Derive the tag identifier deterministically from a versioned SHA-256 digest of
the normalized seller order number, reduced to the 587 identifiers supported by
the pinned `tag36h11` family. This is a stable, non-secret mapping; the printed
marker contains only the resulting small integer. The mapping can collide by
design. The active ready-order pool is therefore grouped by derived tag, and a
collision is surfaced before and during scanning.

The browser uses the detector and continuous-camera controller proven by ADR 0016. It examines at most four frames per second, allows one detection in flight,
requires five matching reads, latches the processed tag, and re-arms after five
empty frames. Multiple visible tags stop for review. The status route reads the
existing in-memory ready-order snapshot and never contacts TCGplayer. Camera
frames, uploads, detections, and sounds remain local and are not persisted or
logged.

After the fifth confirmed read, submit the numeric tag to the loopback server.
The server performs exactly one fresh authoritative ready-to-ship search for an
automatic scan, derives the tag for every returned order, and proceeds only
when exactly one ready order matches. Zero matches and multiple matches never
mutate seller state. Review mode returns the exact order to the operator; its
explicit **Mark shipped** action revalidates the match with another fresh
ready-order search immediately before mutation. Automatic mode proceeds after
the first exact authoritative match.

Persist shipment mutation intent in a separate version-one JSON state file
before contacting the seller. Records contain only order number, tag id,
status, timestamp, and accepted outcome—never buyer or address data. Serialize
mutations in process. A succeeded record suppresses duplicate submissions. A
`running` record found after interruption becomes `review-required`. Any error
after mutation intent is persisted is treated as an uncertain remote outcome,
becomes `review-required`, and is never retried automatically. A successful
mutation uses the existing order-management callback to remove the accepted
order from the shared ready snapshot immediately.

Success, already-processed, no-match, collision, and review-required outcomes
use distinct visual states. Optional sound is a secondary browser cue only;
visual and server results remain authoritative. Failure to create an audio
context never changes scan behavior.

## Consequences

- Production shipment mutation is available but remains separately and
  explicitly opt in. Enabling address-label printing alone does not enable it.
- A confirmed automatic parcel causes one authoritative ready-order search;
  ordinary camera frames and Scanner page visits cause none.
- The finite AprilTag family can reject a parcel because of a collision. That
  is a safe, visible stop rather than a guessed order.
- The deterministic mapping needs no mutable order-to-tag registry, cannot
  exhaust, and stays stable across restarts. Changing its version requires a
  label-compatibility migration.
- A label from an already processed order is suppressed by the durable ledger.
  If a later ready order derives the same tag, the current authoritative match
  takes precedence and receives its own ledger record.
- Shipment scan state is local, excluded from Git, and governed by the same
  backup and filesystem protections as other application state.
- Real seller compatibility still requires a supervised newly received order;
  ordinary automated tests use injected ready-order, mutation, store, printer,
  and browser doubles.
