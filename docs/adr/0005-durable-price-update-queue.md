# ADR 0005: Durable price-update queue

- Status: Accepted
- Date: 2026-08-03

## Context

Seller Portal price updates are slow and should not block an operator or repricing module. Submitting many requests concurrently would add load to an already laggy private interface. A network failure after submission also cannot prove whether a mutation was accepted.

## Decision

- Keep endpoint transport and payload encoding in `tcgplayer-private-api`; keep scheduling, persistence, operator controls, and policy in this application.
- Store price jobs in a dedicated, atomically replaced JSON document with a filesystem lease.
- Queue one complete listing-state update per job. Preserve current quantity and reserve quantity; do not expose quantity changes through this workflow.
- Return from enqueue immediately. Run one worker with one in-flight mutation and a configurable minimum delay between requests (30 seconds by default).
- Supersede an older pending job when a newer price targets the same product-condition/channel pair.
- Pause processing while global dry run is enabled or the queue is disabled.
- Retry only a definite HTTP 429, after a long configured delay. Mark authentication, authorization, validation, and permanent failures as failed.
- Mark timeouts, lost responses, server errors, and jobs found `applying` after process interruption as `review-required`; never automatically resubmit them.
- Expose queue settings, manual enqueue, recent status, and pending-job cancellation through the loopback-only same-origin UI. Also provide JSON-file CLI ingestion for future modules.
- Retain a bounded terminal history while preserving non-terminal and review-required jobs.

## Consequences

Operators and future repricers can enqueue work without waiting for Seller Portal, while the service applies natural backpressure. The current UI requires listing identifiers and current inventory state because automatic listing lookup is not implemented yet. Review-required jobs must be reconciled manually in Seller Portal. This queue does not provide pricing strategies, automatic repricing rules, or inventory quantity changes.
