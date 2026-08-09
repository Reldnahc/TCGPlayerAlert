# ADR 0022: Confirmed order refunds

## Status

Accepted

## Context

The internal order workspace already confirms one seller-owned order and shows
its provider-derived capabilities. Operators need to issue full or partial
refunds from that same workspace without treating the application as a second
order ledger or creating an automated financial workflow.

Refunds are consequential and may be impossible to undo. A timeout after the
remote service receives a request also makes an automatic retry unsafe because
the first request may have succeeded.

## Decision

- Show Refund only when the freshly validated order advertises the exact
  provider action `FullRefund` or `PartialRefund`.
- Load provider-defined origin and reason options through the package contract
  and cache them in server memory for five minutes.
- Keep refund editing inside the seller-confirmed order workspace. Support a
  full refund of the provider-calculated remaining eligible value and a partial
  refund split across remaining shipping and product-line balances.
- Subtract validated prior product and shipping refunds when computing partial
  limits. Reject negative, fractional-cent, duplicate-SKU, over-limit, empty,
  oversized, or malformed input at both the browser and server boundaries.
- Require a buyer-visible message of 1 through 500 characters.
- Always separate preparation from mutation: **Review refund** creates an
  on-page summary and sends no remote request. Only a second, danger-styled
  confirmation submits the refund. This confirmation cannot be disabled by
  shipment or application settings.
- Reconfirm the order, exact capability, current products, and prior refunds in
  the private API package immediately before the remote mutation.
- Never automatically retry a refund POST. If the response is ambiguous, lock
  the panel, preserve the warning, and require the operator to refresh and
  reconcile the order in TCGplayer before another attempt.
- Serialize refund submissions per order in the application service and guard
  the browser submit handler against duplicate activation.
- Clear in-memory order and order-list caches after an accepted mutation. Never
  persist or log the order detail, refund message, or raw request.

## Consequences

The application can handle the deliberate refund workflow where the order is
already being reviewed while TCGplayer remains the capability and financial
source of truth. Full-refund amounts remain provider-calculated rather than
being guessed locally. Partial limits improve operator feedback but do not
replace the package's fresh preflight validation. Automated refunds, refund
queues, bulk refunds, cancellations, payout changes, and payment setup remain
out of scope.
