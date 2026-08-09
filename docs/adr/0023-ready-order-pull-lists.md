# ADR 0023: Printable ready-order pull lists

## Status

Accepted

## Context

Operators need a concise list of the exact products and quantities required to
assemble an order before printing labels or marking it shipped. TCGplayer's
pull-sheet export contains the authoritative product line, product name,
condition, collector number, set, rarity, SKU, and order quantity, but the
application previously exposed only packing slips. Product metadata such as
card color can speed physical sorting, although it is optional and must not
make fulfillment unavailable when a product line or catalog response omits it.

Pull sheets and exact order details contain seller and order information that
must stay in memory. Fetching metadata with one product-detail request per row
would also create avoidable catalog traffic.

## Decision

- Expose a pull list only for an exact, seller-confirmed order whose normalized
  `SellerOrderStatus` is `ReadyToShip`. Do not infer eligibility from display
  text. Reject a direct request after the order leaves that state.
- Retrieve the validated typed rows through `tcgplayer-private-api`
  `exportPullSheet`; do not parse provider CSV in the application.
- Match pull-sheet SKU IDs to confirmed order products, then request optional
  marketplace metadata in batches of at most 24 exact product IDs. Preserve
  provider-supplied colors and omit the metadata field when none exists.
- Treat metadata as an enhancement. If its read fails, return the complete
  operational pull list with a visible metadata warning instead of failing the
  pull list.
- Load a pull list only when the operator opens it. Cache the confirmed detail
  and assembled pull list in server memory for 30 seconds, let Refresh bypass
  both caches, and invalidate them before relevant order mutations.
- Render a dedicated order route with exact order quantity, product, set,
  number, condition, rarity, and available metadata. Use `window.print()` and a
  printer stylesheet so the normal operating-system print dialog remains the
  generic printer boundary.
- Never persist or log pull-sheet rows, product metadata, or customer/order
  content.

## Consequences

Typical orders need one pull-sheet export and one public marketplace batch in
addition to the seller-confirmed detail; revisits within the cache window add
no requests. Orders with more than 24 unique products use sequential bounded
batches. Optional catalog drift cannot block fulfillment, while pull-sheet or
order-validation drift still fails explicitly. The feature remains compatible
with any printer exposed through the browser's operating-system print dialog
and does not add a printer-specific application adapter.
