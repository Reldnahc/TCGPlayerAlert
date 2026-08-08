# ADR 0013: Read-only messages workspace

## Status

Accepted

## Context

Operators need buyer conversations and an unread indicator alongside order work. TCGplayer exposes inbox, unread-count, and thread-detail reads separately from message replies and read-state mutations. Message bodies may contain customer information, so the application must keep them local and avoid adding another durable source of sensitive data.

## Decision

The application consumes the read-only message contract introduced by `tcgplayer-private-api` 0.8.0. A server-side `MessageManagementService` normalizes paginated inbox and thread data, keeps it in memory for 30 seconds, and exposes it only through the loopback UI API.

The navigation rail requests the dedicated unread count when the UI opens and then once per minute. The Messages workspace loads inbox pages only when first visited, supports exact order-number filtering and optional deleted-thread inclusion, and loads a selected conversation on demand. Concurrent unread-count reads share one in-flight request.

The application issues no message POST requests. Viewing a thread does not mark it read. Reply, delete, escalation, resolution, and read-state controls remain links to TCGplayer Seller Portal. Message content, participants, and provider identifiers are not persisted or logged.

## Consequences

- The red badge reflects TCGplayer's unread state without requiring full inbox polling.
- Reading a conversation locally intentionally leaves its unread state unchanged.
- The UI can show short-lived message content in the browser on the same computer, but a restart clears every application message cache.
- Message mutations require a separate authorization and design review before they can be added.
