# ADR 0021: Seller-confirmed internal order workspace

## Status

Accepted

## Context

The Orders, Dashboard, Payments, Messages, and Scanner workspaces expose order
numbers, but order review previously left the local console for the TCGplayer
Seller Portal. The application already depends on the private client's
validated exact-order contract for fulfillment work. Operators need one local
place to review the shipping address, products, totals, tracking, and available
explicit fulfillment controls without creating another order source of truth.

An exact order confirmation performs a seller-scoped search followed by the
validated detail read. Repeating that pair on every navigation would add
avoidable seller requests. Order details contain customer PII and therefore
must not become durable UI state, logs, fixtures based on real customers, or a
browser-accessible cache outside the loopback application.

## Decision

- Add `GET /api/orders/:orderNumber` to the loopback UI server. It calls the
  public `tcgplayer-private-api` `confirmOrder` contract and rejects a response
  for a different order.
- Normalize the detail into an explicit browser contract and omit the
  provider's raw `allowedActions` values. Shipment availability is derived only
  from the package's `SellerOrderStatus` enum.
- Cache each confirmed detail in server memory for 30 seconds. The explicit
  Refresh control bypasses the cache, and tracking or shipment mutations clear
  it before the remote request.
- Keep the detail and shipping address in memory only. Do not persist or log
  the response.
- Route `#orders/:orderNumber` to an internal order workspace that presents the
  provider status, shipping address, product lines, settlement amounts, and
  tracking. Reuse the existing explicit print, packing-slip, Pirate Ship,
  tracking, and mark-shipped controls.
- Make displayed order numbers link to the internal workspace where the host
  markup can safely contain a link. Replace the former Seller Portal
  `Manage order` menu item with `Order details`.
- Keep a clearly labeled `Open in TCGplayer` link on the internal workspace as
  an escape hatch for capabilities the application does not own.

## Consequences

The application gains an operator-focused order workspace without adding a new
private endpoint or changing the independently released API package. A cold or
forced detail read still performs the two requests required by exact seller
confirmation; ordinary revisits within 30 seconds do not. The local page is not
an independent lifecycle source and never invents an order status. Payment and
payout mutation, cancellations, buyer-message creation, and unrelated Seller
Portal controls remain out of scope. The later, separately constrained order
refund capability is governed by ADR 0022.
