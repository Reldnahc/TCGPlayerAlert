# ADR 0029: Durable internal job schedules

- Status: Accepted
- Date: 2026-08-10

## Context

The application has durable price and inventory mutation queues, but those
queues represent concrete Seller Portal writes that are ready to execute. Their
`nextAttemptAt` fields are retry controls, and their payloads contain prices or
quantities calculated from a short-lived preview. Using those queues as a
business scheduler would retain stale prices, blur retries with user intent,
and provide no model for recurring repricing.

Operators want to select exact cards in Add Cards and release them later, and
to run a pricing profile on a recurring schedule. Internal job state must not
create or reinterpret TCGplayer order statuses.

## Decision

- Add a separate, versioned internal-job document containing schedule
  definitions and bounded run history. Persist it through atomic replacement
  and a filesystem lease.
- Keep schedule state, internal-run state, price mutations, and inventory
  mutations distinct. An internal run calculates a fresh plan and hands
  concrete writes to the existing domain queue.
- Support one-time, fixed-interval, daily, and weekly timing. Daily and weekly
  schedules carry an IANA timezone. A repeated daylight-saving wall-clock slot
  runs once; a nonexistent slot advances to the first valid minute. Coalesce
  missed recurring occurrences into one run when the service returns.
- Run at most one internal job at a time. Only the long-running `start` command
  executes jobs; the configuration UI may create and edit schedules while
  clearly reporting that its runner is stopped.
- Add an optional internal-run source ID to generated mutation jobs. Queue
  insertion for one run is atomic and idempotent. On restart, an interrupted
  internal run may safely resume without duplicating already-dispatched seller
  mutations.
- A scheduled listing stores exact product/SKU identifiers, quantity, and a
  merchandise-profile reference. Resolve that profile and its pricing profile,
  load current inventory and market evidence, and create a fresh internal
  preview only when the run executes. Never retain a calculated listing price
  in the schedule.
- A scheduled repricing run references the current version of a pricing profile
  by ID and always requests a fresh marketplace snapshot. `review` mode records
  a proposal report but emits no mutations. `automatic` mode applies independent
  caps for update count, percentage and absolute decreases, percentage
  increases, and the proportion of proposed rows blocked by those limits.
- If a referenced profile is missing, a listing cannot be priced, or automation
  limits stop the run, retain a safe review-required result rather than
  substituting defaults or stale values.
- Retry only retryable read/calculation failures, at most three attempts with
  bounded exponential backoff and jitter. Once a mutation batch is handed off,
  its existing queue owns mutation retry and ambiguity handling.
- Do not expose raw cron expressions or arbitrary executable workflows. The job
  registry is capability-based and accepts only runtime-validated payloads for
  supported handlers.

## Consequences

Scheduling intent remains durable without weakening the live checks in the
mutation workers. Add Cards keeps its one-click quantity controls: `Now` queues
the existing preview immediately, while a future time adds the exact SKU to a
one-time batch. Recurring repricing can remain review-only or be explicitly
enabled for guarded automatic dispatch. Internal statuses describe application
work only and never become a second source of truth for TCGplayer orders.
