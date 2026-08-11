# ADR 0030: Provider-neutral operational notifications with Discord delivery

- Status: Accepted
- Date: 2026-08-10

## Context

The long-running application already observes seller-session failure, scheduled
ready-order changes, seller messages, and every shipment mutation. Operators
need off-console awareness of those events, but a Discord-specific dependency
inside each workflow would duplicate policy, expose secrets, and make later
notification providers difficult to add. Notification monitoring must also
avoid turning the dashboard into another polling source or sending customer
message content to a third party.

The existing canonical configuration is version 2. Adding explicit provider and
event settings requires the ordered schema migration promised by ADR 0028.

## Decision

- Introduce provider-neutral notification events for authentication required,
  inbound message activity, confirmed order cancellation, and app-initiated
  mark-shipped attempts. Discord is the first delivery adapter.
- Route shipment events through the single order-mutation boundary and session
  events through the process-wide session manager so manual, scanner, and
  background workflows cannot bypass notification policy.
- Advance the canonical configuration to version 3. Accept version-one and
  version-two files through pure in-memory migrations; add disabled Discord
  settings to both. A successful Settings save writes the complete version-three
  document, while reads and startup never rewrite it.
- Keep the master switch disabled by default. Individual event switches are
  explicit and independently editable. An enabled observer establishes a
  baseline before publishing changes, preventing a first-run replay.
- Protect a UI-supplied webhook URL with the same current-user Windows DPAPI
  boundary used for seller credentials, in a separate ignored file. Return only
  configured/source status to the browser. Support a named environment variable
  as a non-UI fallback and accept only HTTPS Discord webhook hosts and paths.
- Disable Discord mentions in every payload. Message notifications transmit an
  unread count and Seller Portal link only; subjects, bodies, buyer names, and
  addresses are excluded. Logs include event type and safe error code only.
- Reuse the authoritative ready-order snapshot after scheduled reconciliation.
  When a previously ready order disappears, confirm that exact order once and
  publish only if its normalized `SellerOrderStatus` is a TCGplayer cancellation
  value. Remove successful app-owned shipment mutations from this comparison so
  they do not cause a redundant confirmation. Do not create or infer order
  states.
- Observe unread messages at the existing scheduled order cadence. Read the
  first inbox page and unread total, then load later pages only while the total
  indicates unread messages remain unaccounted for. Do not couple this monitor
  to opening the browser UI.
- Claim an idempotency key before webhook delivery and retain a bounded audit of
  delivered or failed attempts. Do not automatically retry an ambiguous webhook
  POST. A missing webhook is a no-op and does not consume the event key.
- Keep notification failure isolated from authentication state, fulfillment
  mutation results, reconciliation, and queue processing. Provide an explicit
  synthetic test action for setup verification.

## Consequences

Discord can report operational events while the console is closed, without
leaking the webhook back to browser code or copying customer conversations to
Discord. Disabled notifications add no seller requests. Enabled message checks
add inbox reads only at the configured poll cadence, and cancellation checks add
an exact order confirmation only after an order leaves the shared ready queue.

Later adapters can implement the same event sink without changing order or
session workflows. Because webhook delivery has an ambiguous network boundary,
rare failed deliveries may require operator observation rather than automatic
replay; duplicate operational alerts are avoided deliberately.
