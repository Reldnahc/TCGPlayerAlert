# ADR 0012: Shared ready-order synchronization

- Status: Accepted
- Date: 2026-08-07

## Context

The fulfillment scheduler and Dashboard previously queried TCGplayer's ready-to-ship queue through separate clients and caches. Dashboard Refresh could therefore reveal an order without submitting it to durable reconciliation, while a scheduled synchronization did not update an already loaded Dashboard. The all-orders workspace could also overwrite the Dashboard queue with a locally filtered historical result.

Order summaries contain buyer information, so persisting a second browser-oriented order database would also expand the application's retained customer data without improving fulfillment reliability.

## Decision

The running service owns one in-memory authoritative ready-order source and one synchronization coordinator:

1. Scheduled polling and Dashboard `Sync now` invoke the same fulfillment workflow.
2. The workflow refreshes the shared ready-to-ship source exactly once, reconciles that result against durable workflow state, and dispatches configured actions.
3. Dashboard reads return the latest shared snapshot without another seller search. An initial read with no snapshot requests synchronization and coalesces with an active scheduled run. An open Dashboard periodically rereads only the loopback snapshot endpoint so completed scheduled work becomes visible without another TCGplayer request.
4. A confirmed shipment mutation removes the order from the shared snapshot immediately; a subsequent synchronization remains authoritative.
5. The historical Orders workspace remains a separate last-three-months query because it has different scope and display requirements. Its results never populate the Dashboard queue.
6. Shared order summaries remain memory-only. Durable workflow state continues to retain only the minimal identifiers, statuses, rule decisions, and action outcomes required for idempotency and auditability.

## Consequences

- The Dashboard and automated fulfillment operate on the same ready-to-ship result.
- Dashboard visits do not duplicate the scheduler's ready-order API search.
- `Sync now` may dispatch configured fulfillment actions because it is a real manual synchronization, not a display-only refresh.
- Restarting the process clears the in-memory snapshot; the scheduler's immediate startup synchronization repopulates it.
- Historical Orders refreshes still use their own bounded API query and cache.
