# ADR 0007: Preview-first exact-SKU inventory additions

- Status: Accepted
- Date: 2026-08-04

## Context

An operator needs to add an already-owned card to Seller Portal by selecting the exact product, condition, printing, and language. The application should calculate an initial price using the same configurable comparison rules as smart repricing without hiding a quantity mutation behind a broad bulk operation.

Seller Portal identifies a listing by product-condition SKU. Its inventory update request carries both the absolute post-add quantity and a positive relative addition. The absolute value must equal the freshly observed current quantity plus the relative addition. The private interface may accept a request before finishing its own processing, so a successful response is not proof that the listing is already visible.

## Decision

The application provides a server-side catalog search and exact product-detail flow through `tcgplayer-private-api`. The browser receives sanitized catalog and preview data but never credentials or private transport details.

Catalog discovery is explicitly paginated because TCGplayer's fuzzy search can return thousands of products before local likeness ranking. The application starts with one page and expands to a maximum of three only while fewer than eight exact matches are available, or while no exact match and fewer than eight qualified name variants are available. Each result carries a normalized likeness rank that handles punctuation, word-order variants, token overlap, and edit distance; the browser preserves that rank when merging later pages instead of replacing fuzzy relevance with alphabetical or arrival order. The operator may load one subsequent page at a time. When no exact name is loaded, an explicit `Find exact name` action scans a bounded batch of up to eight later pages and stops at the first page containing an exact match. This deeper scan is never triggered by typing or an ordinary search. Identical search batches are cached for one minute, and replacement browser searches propagate cancellation to the marketplace request. Product-line suggestions come only from validated products already returned by TCGplayer; an operator may still enter an exact product-line name when it has not appeared yet.

Before a card can be queued, the operator must select an exact SKU, enter a positive quantity, configure pricing rules, and review a short-lived preview. Choosing a catalog result replaces the result list with the editor while retaining the search controls and a path back to the loaded results. The browser creates the first preview automatically and refreshes it after relevant changes; a short debounce and single in-flight request limit coalesce rapid edits, and stale responses cannot replace newer selections. Product details, primary and secondary seller inventory, and each requested condition-comparison set are cached in memory for the same 15-minute lifetime as a preview. Quantity and arithmetic pricing changes therefore create a fresh queueable preview without repeating remote reads; selecting another SKU or requesting a previously unseen comparison policy loads the required snapshot once. Failed loads are never cached. The worker still re-reads live primary and secondary inventory immediately before submission. Pricing may compare the same condition or the same-or-better conditions, use item or delivered price, apply an optional undercut, and enforce a hard minimum. Delivered price is the UI default. If no qualifying listing exists, the explicit fallback is market price, a manual price, or stop.

The operator enters the small-product shipping rate already configured in Seller Portal. It is a pricing input, not a request to change the seller account's shipping settings, and the loopback browser remembers it locally. For standalone listings below $5, delivered-price calculations use the greater of that rate and TCGplayer's $1.49 minimum shipping charge. This policy was verified against TCGplayer's [shipping-rate guidance](https://help.tcgplayer.com/hc/en-us/articles/23216633721495-Understanding-Shipping-Rates-in-Different-Situations) on 2026-08-04 and is isolated in the pricing module so a future policy change has one implementation point.

Accepted previews become durable jobs. Pending jobs for the same SKU are combined. The worker processes one job at a time and, immediately before submission, re-reads the seller's primary and secondary listings. It submits only if the current quantity still equals the previewed quantity and the SKU is neither a custom listing nor represented in the secondary channel.

Successful requests are recorded as `submitted`, not `applied`. Definite validation and authentication failures are terminal. Timeouts, disconnects, server errors, interrupted in-flight work, and stale live quantity require operator review and are never retried automatically.

The queue is paused whenever application dry-run mode or its own enable switch is active. The configuration-only UI may create jobs, but only the long-running service runs the worker.

## Consequences

- Exact SKU selection avoids guessing condition or printing identifiers from card names.
- Preview expiration and live-state revalidation reduce stale quantity mutations.
- The operator can safely prepare additions while the worker is stopped.
- The preview distinguishes competitor shipping, the seller's configured rate, and TCGplayer's effective under-$5 shipping minimum.
- Marketplace search and seller inventory remain eventually consistent, so submitted jobs may require later confirmation in Seller Portal.
- Automated bulk ingestion, scanning, per-product floors, and scheduled inventory imports remain separate future capabilities.
