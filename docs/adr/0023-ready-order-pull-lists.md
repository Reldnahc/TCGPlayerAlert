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
- Preserve the validated per-order allocation supplied by
  `tcgplayer-private-api` 0.15.0. Track picking progress on each exact
  order-number/SKU allocation; never represent it as an order status or alter
  the provider status. TCGplayer remains the sole order-status authority.
- Derive optional product IDs from validated TCGplayer product-image URLs. When
  the export omits those URLs, read ready-order details sequentially only until
  every pull-sheet SKU that can be matched has a product ID. Reuse cached order
  details, then request marketplace metadata in sequential batches of at most
  24 exact product IDs. Preserve provider-supplied colors and omit color when
  none exists.
- Treat metadata as an enhancement. If its read fails, return the complete
  operational master list with a visible warning instead of failing the list.
- Cache the assembled master list in server memory for 30 seconds. Refresh
  bypasses both it and the ready-order cache, and order mutations invalidate it.
- Render a dedicated master-list route with combined quantity, product, set,
  number, condition, rarity, and available metadata. Allow every data column to
  control a stable ascending or descending row sort; keep the check-off column
  unsortable. Store only the validated sort field and direction in browser-local
  storage so later visits and browser restarts restore the operator's layout.
  Keep the summary visible while the row region scrolls independently. The
  printed list follows the displayed order. Use a dense monochrome printer
  stylesheet and `window.print()` so the operating system's normal print dialog
  remains the generic printer boundary.
- Default the working and printed master list to allocations that still need to
  be pulled. A `Show pulled` control may reveal completed SKU rows with their
  checkboxes prechecked. Checking a combined SKU marks only its current
  per-order allocations; a later order for the same SKU remains unpulled and
  contributes only its new quantity.
- Persist only order number, SKU, pulled quantity, and timestamp in a separate
  versioned progress document. Prune entries when their allocation is no longer
  in TCGplayer's ready queue. Never persist or log pull-sheet product fields,
  product metadata, customer details, or a synthetic order status.

## Consequences

A cold load performs the paginated ready-order search, one pull-sheet export
per 500 ready orders, up to one detail read per ready order needed to resolve
missing product IDs, and one public marketplace request per 24 unique products.
It stops detail reads as soon as every pull-sheet SKU is resolved and reuses
details already in the short-lived in-memory cache. Repeated exact SKUs become
one physical picking row, and revisits within the pull-list cache window add no
requests. Optional detail or catalog drift cannot block fulfillment, while
pull-sheet identity or SKU drift fails explicitly. The feature works with any
printer exposed through the browser's operating-system print dialog. Sorting is
entirely client-side and adds no provider requests. Its preference is local to
the browser profile and resets when the operator clears site data. Pull
progress survives browser and application restarts without retaining card
descriptions or customer data, and updating it adds no seller API request while
the current list is cached.
