# ADR 0001: Polling-first order discovery

- Status: Accepted
- Date: 2026-08-03

## Context

The application needs a dependable way to discover seller orders that require fulfillment. A sale email can provide a timely hint, but adding mailbox authentication, provider-specific behavior, message parsing, cursors, and duplicate handling would increase the first release's complexity. Email is also not authoritative; every candidate would still need confirmation through TCGplayer before any fulfillment action.

The seller interface already exposes an authoritative ready-to-ship order queue and the order details and packing slips required by the initial workflow.

## Decision

The initial application will use polling-first discovery:

1. A configurable scheduler requests synchronization every 60 minutes by default.
2. An operator can request `Sync now`; manual and scheduled requests use the same orchestration path.
3. Each synchronization pages through the complete ready-to-ship queue using the public contract of the `tcgplayer-private-api` npm package.
4. Discovered orders are reconciled against durable application state.
5. Each unseen order is confirmed through TCGplayer before its packing slip or normalized order data is dispatched to rules and actions.

The first successful synchronization establishes a baseline. Existing orders are recorded without running actions unless the operator explicitly chooses to process the backlog.

Order and action processing must be idempotent. Each action uses a durable key derived from the authoritative order identifier and action identity. Successful actions are not repeated when another action fails, a synchronization overlaps, or the process restarts.

Only one synchronization may reconcile a seller account at a time. Overlapping scheduled and manual signals must be serialized or coalesced. Retries are bounded, pagination failures make the synchronization incomplete, and an expired seller session is reported as an actionable health failure.

Email and other notification providers may be added later as optional accelerators. Such an adapter may request an immediate synchronization, but it may not create an authoritative order or dispatch fulfillment actions directly. Periodic polling remains the reconciliation safety net.

## Consequences

- The first useful release does not require mailbox credentials, IMAP/OAuth support, or email parsing.
- New orders may wait up to the configured polling interval unless an operator selects `Sync now`.
- Durable reconciliation and action-level idempotency are required before automatic printing is enabled.
- Polling cadence remains configurable so deployments can balance latency against an undocumented private interface.
- Adding an email provider later does not change the order-confirmation or action pipeline.
