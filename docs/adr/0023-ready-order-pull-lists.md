# ADR 0023: Printable master pull lists

## Status

Accepted

## Context

Operators need one concise picking list for every exact product and combined
quantity required by the current ready-to-ship queue. A pull sheet for one
order merely repeats information already visible on that order's packing slip.
TCGplayer's multi-order pull-sheet export contains the authoritative product
line, product name, condition, collector number, set, rarity, SKU, and order
quantity needed for a useful master list.

Product metadata such as card color can speed physical sorting, although it is
optional and must not make fulfillment unavailable when a product line or
catalog response omits it. Pull-sheet content must remain in memory, and
metadata enrichment must avoid one catalog request per row.

## Decision

- Load the authoritative `ReadyToShip` order queue when the operator explicitly
  opens the master pull list. Use normalized `SellerOrderStatus` values rather
  than display text, and omit any unexpected non-ready result.
- Retrieve validated typed rows through `tcgplayer-private-api`
  `exportPullSheet`; do not parse provider CSV in the application. Export at
  most 500 order numbers per request and validate that every response identifies
  exactly the requested batch.
- Combine rows with the same exact SKU and sum their order quantities. Reject
  conflicting product identity fields for one SKU instead of silently merging
  uncertain products.
- Derive optional product IDs only from validated TCGplayer product-image URLs,
  then request marketplace metadata in sequential batches of at most 24 exact
  product IDs. Preserve provider-supplied colors and omit color when none
  exists.
- Treat metadata as an enhancement. If its read fails, return the complete
  operational master list with a visible warning instead of failing the list.
- Cache the assembled master list in server memory for 30 seconds. Refresh
  bypasses both it and the ready-order cache, and order mutations invalidate it.
- Render a dedicated master-list route with combined quantity, product, set,
  number, condition, rarity, and available metadata. Use `window.print()` and a
  printer stylesheet so the operating system's normal print dialog remains the
  generic printer boundary.
- Never persist or log pull-sheet rows, product metadata, or customer/order
  content.

## Consequences

A cold load performs the paginated ready-order search, one pull-sheet export
per 500 ready orders, and one public marketplace request per 24 unique products.
It does not confirm every individual order. Repeated exact SKUs become one
physical picking row, and revisits within the cache window add no requests.
Optional catalog drift cannot block fulfillment, while pull-sheet identity or
SKU drift fails explicitly. The feature works with any printer exposed through
the browser's operating-system print dialog.
