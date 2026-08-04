# ADR 0007: Preview-first exact-SKU inventory additions

- Status: Accepted
- Date: 2026-08-04

## Context

An operator needs to add an already-owned card to Seller Portal by selecting the exact product, condition, printing, and language. The application should calculate an initial price using the same configurable comparison rules as smart repricing without hiding a quantity mutation behind a broad bulk operation.

Seller Portal identifies a listing by product-condition SKU. Its inventory update request carries both the current absolute quantity and a positive relative addition. The private interface may accept a request before finishing its own processing, so a successful response is not proof that the listing is already visible.

## Decision

The application provides a server-side catalog search and exact product-detail flow through `tcgplayer-private-api`. The browser receives sanitized catalog and preview data but never credentials or private transport details.

Before a card can be queued, the operator must select an exact SKU, enter a positive quantity, configure pricing rules, and review a short-lived preview. Pricing may compare the same condition or the same-or-better conditions, use item or delivered price, apply an optional undercut, and enforce a hard minimum. If no qualifying listing exists, the explicit fallback is market price, a manual price, or stop.

Accepted previews become durable jobs. Pending jobs for the same SKU are combined. The worker processes one job at a time and, immediately before submission, re-reads the seller's primary and secondary listings. It submits only if the current quantity still equals the previewed quantity and the SKU is neither a custom listing nor represented in the secondary channel.

Successful requests are recorded as `submitted`, not `applied`. Definite validation and authentication failures are terminal. Timeouts, disconnects, server errors, interrupted in-flight work, and stale live quantity require operator review and are never retried automatically.

The queue is paused whenever application dry-run mode or its own enable switch is active. The configuration-only UI may create jobs, but only the long-running service runs the worker.

## Consequences

- Exact SKU selection avoids guessing condition or printing identifiers from card names.
- Preview expiration and live-state revalidation reduce stale quantity mutations.
- The operator can safely prepare additions while the worker is stopped.
- Marketplace search and seller inventory remain eventually consistent, so submitted jobs may require later confirmation in Seller Portal.
- Automated bulk ingestion, scanning, per-product floors, and scheduled inventory imports remain separate future capabilities.
