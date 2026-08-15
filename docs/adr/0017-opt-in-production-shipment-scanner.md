# ADR 0017: Opt-in production shipment scanner

## Status

Accepted; activates the production path proven by ADR 0016. ADR 0018 later
retires the simulation lab after successful workstation validation. ADR 0019
supersedes browser ownership of continuous camera capture and sound cues.

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

Use a versioned SHA-256 digest of the normalized seller order number, reduced to
the 587 identifiers supported by the pinned `tag36h11` family, as the preferred
tag identifier. This is a stable, non-secret candidate; the printed marker
contains only the resulting small integer. Before printing, durably reserve the
candidate for that order. If another current order already owns it, probe the
family for an unused identifier and persist that assignment instead. Serialize
reservations with a filesystem lease and replace the assignment file atomically
so concurrent label work cannot print a duplicate. A reprint uses the same
assignment across restarts. Invalid or exhausted assignment state stops before
printer submission rather than falling back to the colliding hash.

Scanner status reserves assignments for the in-memory ready snapshot so labels
created by the previous hash-only version remain recognizable when they do not
collide. A fresh authoritative ready-order response reconciles the registry:
orders still ready retain their assignment, newly absent orders become retired,
and any unassigned ready orders receive unique IDs. A retired marker remains
unavailable until 100 newer order markers have been assigned. Wall time cannot
expire that quarantine. If the same order reappears before reuse, reactivate its
original marker. If old physical labels already contain the same colliding
marker, one must be reprinted after migration because software cannot alter a
marker already on paper.

The original implementation used the browser detector and continuous-camera controller proven by ADR 0016. It examined at most four frames per second, allowed one detection in flight,
requires five matching reads, latches the processed tag, and re-arms after five
empty frames. Multiple visible tags stop for review. The status route reads the
existing in-memory ready-order snapshot and never contacts TCGplayer. Camera
frames, uploads, detections, and sounds remain local and are not persisted or
logged.

After the fifth confirmed read, submit the numeric tag to the loopback server.
The server performs exactly one fresh authoritative ready-to-ship search for an
automatic scan, reconciles the reserved tags for every returned order, and
proceeds only when exactly one ready order owns the marker. Zero matches and
unsafe assignment state never mutate seller state. Review mode returns the exact order to the operator; its
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
use distinct visual states. The original optional sound was a secondary browser cue only;
visual and server results remain authoritative. Failure to create an audio
context never changes scan behavior.

## Consequences

- Production shipment mutation is available but remains separately and
  explicitly opt in. Enabling address-label printing alone does not enable it.
- A confirmed automatic parcel causes one authoritative ready-order search;
  ordinary camera frames and Scanner page visits cause none.
- A hash collision is resolved before label submission, so two current orders
  cannot receive the same marker. If all 587 identifiers are simultaneously
  active or quarantined, the next label stops for review before printing.
- The assignment registry contains only order number, tag id, and assignment
  timestamp, monotonic assignment sequence, and optional retirement sequence.
  It is local, atomically replaced, and protected by a filesystem lease.
  Changing the preferred-hash version, reuse gap, or tag family requires a
  label-compatibility migration.
- A label from an already processed order is suppressed by the durable ledger.
  If a later ready order derives the same tag, the current authoritative match
  takes precedence and receives its own ledger record.
- Shipment scan state is local, excluded from Git, and governed by the same
  backup and filesystem protections as other application state.
- Real seller compatibility still requires a supervised newly received order;
  ordinary automated tests use injected ready-order, mutation, store, printer,
  and browser doubles.
