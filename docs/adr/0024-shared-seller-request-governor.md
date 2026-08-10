# ADR 0024: Shared seller client and request governor

- Status: Accepted
- Date: 2026-08-10

## Context

The long-running service previously constructed an independent private-API client for order synchronization, order management, repricing, inventory additions, price and inventory workers, payments, feedback, and messages. Each package client correctly paced its own request starts, but those independent gates could not see one another. Opening several workspaces while a worker or scheduled synchronization was active could therefore create more concurrent seller traffic than any single component intended.

## Decision

- Create one session-aware `TcgplayerSellerClient` for each long-running `configure`, `start`, or one-shot `sync` process and inject it into every seller-backed service, workflow, and mutation executor created by that process.
- Preserve the package transport's conservative 250 ms default as the application's global minimum between actual network starts. Enforce it in the shared governor and set the shared and validation clients' per-client delay to zero so concurrency backlogs cannot move the spacing ahead of the real fetch or apply it twice.
- Wrap the client's fetch transport in one FIFO request governor with a default maximum of two in-flight request attempts. Calls beyond that limit wait for a slot, paced calls remain ordered, and queued calls honor cancellation.
- Route browser-session validation through the same governor. Validation uses a short-lived client because it must authenticate the newly submitted cookie before that session becomes the shared client's session source.
- Keep existing exported factories independently usable. A caller that does not supply a shared runtime receives the previous self-contained client behavior; the application entry point always supplies the shared runtime.
- Expose only aggregate, process-local request-attempt metrics at `GET /api/provider/requests`: response counts, network failures, aborted attempts, in-flight and queued counts, peak concurrency, and last start/completion times. Never record request URLs, paths, bodies, seller keys, order numbers, or response data in these metrics.

## Consequences

Seller-backed work can still overlap, but the complete application cannot exceed two simultaneous network attempts or start them less than 250 ms apart. A slot remains occupied until the response body is fully read or canceled, so slow JSON and PDF transfers count as active work. A slow request no longer permits an unbounded cross-feature burst, and operators or diagnostics can inspect current pressure without exposing customer or seller data. The governor measures transport attempts rather than logical operations, so package retries appear as additional attempts and non-success HTTP responses are counted before the package decides whether to retry.
