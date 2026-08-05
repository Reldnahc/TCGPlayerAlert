# ADR 0007: Profile-driven exact-SKU inventory additions

- Status: Accepted
- Date: 2026-08-04

## Context

An operator needs to add an already-owned card to Seller Portal by selecting the exact product, condition, printing, and language. The application should calculate an initial price using the same configurable comparison rules as smart repricing without hiding a quantity mutation behind a broad bulk operation.

Seller Portal identifies a listing by product-condition SKU. Its inventory update request carries both the absolute post-add quantity and a positive relative addition. The absolute value must equal the freshly observed current quantity plus the relative addition. The private interface may accept a request before finishing its own processing, so a successful response is not proof that the listing is already visible.

## Decision

The application provides a server-side catalog search and exact product-detail flow through `tcgplayer-private-api`. The browser receives sanitized catalog and pricing results but never credentials or private transport details.

Catalog discovery is explicitly paginated because TCGplayer's fuzzy search can return thousands of products before local likeness ranking. The application starts with one page and expands to a maximum of three only while fewer than eight exact matches are available, or while no exact match and fewer than eight qualified name variants are available. Each result carries a normalized likeness rank that handles punctuation, word-order variants, token overlap, and edit distance; the browser preserves that rank when merging later pages instead of replacing fuzzy relevance with alphabetical or arrival order. The operator may load one subsequent page at a time. When no exact name is loaded, an explicit `Find exact name` action scans a bounded batch of up to eight later pages and stops at the first page containing an exact match. This deeper scan is never triggered by typing or an ordinary search. Identical search batches are cached for one minute, and replacement browser searches propagate cancellation to the marketplace request. Product-line suggestions come only from validated products already returned by TCGplayer; an operator may still enter an exact product-line name when it has not appeared yet.

Before a card can be queued, the operator selects a condition, printing, positive quantity, and merchandise profile. Merchandise profiles are validated, non-secret application configuration containing a name, preferred language, shipping rate, minimum price, condition-comparison policy, price basis, undercut, and no-listing fallback. At least one profile is required and one is the saved default; the Add Cards page may remember a different selected profile locally for the current operator. The profile's language is authoritative for the one-click addition.

Catalog results expose regular and English Near Mint Foil market prices, a condition selector, a Foil toggle, fixed `+1` through `+4` quantity controls, and a custom-quantity dialog. The package identifies matching Foil SKUs from filtered embedded listings and resolves their price points in one batch per search page; it never makes a price request per result. A missing reliable price is displayed as unavailable. Condition and Foil selection are local and do not load product details. Choosing a quantity lazy-loads and caches only that product, resolves the exact condition, printing, and profile-language SKU, and immediately attempts to create the queue job. Foil is an exact printing choice and receives a visible row border; the application never silently falls back to Normal when a Foil SKU is unavailable.

Each quantity action creates a short-lived server-side pricing preview and immediately converts it into a durable job when it is queueable; there is no separate browser confirmation step. The row reports the queued price or the exact reason the addition stopped. Product details, primary and secondary seller inventory, and each requested condition-comparison set are cached in memory for the preview lifetime, so subsequent additions from the same snapshots do not repeat remote reads. Failed loads are never cached. The worker still re-reads live primary and secondary inventory immediately before submission. Pricing may compare the same condition or the same-or-better conditions, use item or delivered price, apply an optional undercut, and enforce a hard minimum. Delivered price is the default profile basis. If no qualifying listing exists, the explicit fallback is market price, a manual price, or stop.

The operator enters the small-product shipping rate already configured in Seller Portal as part of each merchandise profile. It is a pricing input, not a request to change the seller account's shipping settings. For standalone listings below $5, delivered-price calculations use the greater of that rate and TCGplayer's $1.49 minimum shipping charge. This policy was verified against TCGplayer's [shipping-rate guidance](https://help.tcgplayer.com/hc/en-us/articles/23216633721495-Understanding-Shipping-Rates-in-Different-Situations) on 2026-08-04 and is isolated in the pricing module so a future policy change has one implementation point.

Queueable internal previews become durable jobs immediately. Pending jobs for the same SKU are combined. The worker processes one job at a time and, immediately before submission, re-reads the seller's primary and secondary listings. It submits only if the current quantity still equals the internally previewed quantity and the SKU is neither a custom listing nor represented in the secondary channel.

Successful requests are recorded as `submitted`, not `applied`. Definite validation and authentication failures are terminal. Timeouts, disconnects, server errors, interrupted in-flight work, and stale live quantity require operator review and are never retried automatically.

The queue is paused whenever application dry-run mode or its own enable switch is active. The configuration-only UI may create jobs, but only the long-running service runs the worker.

## Consequences

- Exact SKU selection avoids guessing condition or printing identifiers from card names.
- Profiles make recurring merchandise and pricing choices reusable without hard-coding one seller's workflow.
- Short-lived internal pricing and live-state revalidation reduce stale quantity mutations.
- The operator can safely prepare additions while the worker is stopped.
- Profile-driven pricing distinguishes competitor shipping, the seller's configured rate, and TCGplayer's effective under-$5 shipping minimum.
- Marketplace search and seller inventory remain eventually consistent, so submitted jobs may require later confirmation in Seller Portal.
- Automated bulk ingestion, scanning, per-product floors, and scheduled inventory imports remain separate future capabilities.
