# ADR 0005: Durable price-update queue

- Status: Accepted
- Date: 2026-08-03

## Context

Seller Portal price updates are slow and should not block an operator or repricing module. Submitting many requests concurrently would add load to an already laggy private interface. A network failure after submission also cannot prove whether a mutation was accepted.

## Decision

- Keep endpoint transport and payload encoding in `tcgplayer-private-api`; keep scheduling, persistence, operator controls, and policy in this application.
- Store price jobs in a dedicated, atomically replaced JSON document with a filesystem lease.
- Queue one complete listing-state update per job. Preserve current quantity and reserve quantity; do not expose quantity changes through this workflow.
- Return from enqueue immediately. Run one worker with one in-flight mutation. Await Seller Portal's response, then apply a configurable cooldown before claiming the next job; default the cooldown to one second.
- Treat a successful Seller Portal response as acceptance, not proof of an immediately visible exact marketplace price. Do not poll for exact equality: TCGplayer documents visibility delays of up to five minutes, and account rounding or Direct price floors can transform the displayed value.
- Supersede an older pending job when a newer price targets the same product-condition/channel pair.
- Pause processing while global dry run is enabled or the queue is disabled.
- Retry only a definite HTTP 429, after a long configured delay. Mark authentication, authorization, validation, and permanent failures as failed.
- Mark timeouts, lost responses, server errors, and jobs found `applying` after process interruption as `review-required`; never automatically resubmit them.
- Expose queue settings, repricing preview/selection, recent status, and pending-job cancellation through the loopback-only same-origin UI. Also retain JSON-file CLI ingestion for integrations.
- Retain a bounded terminal history while preserving non-terminal and review-required jobs.

## Consequences

Operators can enqueue previewed changes without waiting for Seller Portal while the service applies natural backpressure. The one-second default cooldown prevents a zero-delay burst without pretending that the marketplace search index can authoritatively confirm mutation completion. Review-required jobs must be reconciled manually in Seller Portal. The queue does not expose inventory quantity changes.
