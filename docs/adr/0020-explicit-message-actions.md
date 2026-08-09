# ADR 0020: Explicit seller-message actions

## Status

Accepted.

## Context

ADR 0013 deliberately introduced Messages as read-only. Operators now need to
mark a buyer conversation read and reply without leaving the local console.
Reply submission is externally visible and may succeed even when its network
response is lost, so ordinary automatic retry behavior could duplicate a
message to the buyer.

## Decision

Consume the explicit mark-read and reply contract in
`tcgplayer-private-api` 0.11.0. After an unread thread's content loads
successfully, the browser requests the idempotent thread-level mark-read
operation and immediately updates its indicator and shared badge on success.
The per-thread control remains available as an operator retry when that update
fails. A reply must contain at most 10,000 characters. The server keeps request
text only in memory, never logs it, and invalidates its inbox, count, and
affected-thread caches after every mutation attempt.

TCGplayer exposes no bulk mark-read operation or unread-only inbox filter. The
explicit **Mark all read** action therefore loads active inbox summaries in
100-thread pages and applies the existing idempotent thread operation only to
unread conversations. Requests run sequentially and stop on the first failure.
The service then invalidates all message caches so a partial result can be
reconciled from TCGplayer.

Mark-read is an idempotent state assignment. After a successful response, the
browser immediately clears that thread's unread indicator and adjusts the
shared navigation badge. Reply submission is sent once and is not placed in a
background queue. After a definite success, the browser clears the draft and
refreshes the thread. After `AMBIGUOUS_RESULT`, it preserves the draft, disables
resubmission, and requires a successful conversation refresh before the
operator can decide whether another send is appropriate.

Deleted conversations cannot be replied to. Mark-unread, per-message state,
deletion, resolution, escalation, and new-conversation creation remain outside
the application.

## Consequences

- Buyer replies and read state can be handled from the local Messages workspace.
- Successfully viewing an unread conversation changes its remote read state.
- Bulk work minimizes page reads, avoids request bursts, and may finish
  partially if TCGplayer rejects a later thread.
- A lost reply response cannot trigger an automatic duplicate.
- Tests use synthetic services and transport fixtures; ordinary development
  never sends or changes a real seller message.
