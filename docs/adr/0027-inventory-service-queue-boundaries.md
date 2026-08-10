# 0027: Separate Inventory Preview, Queue, and Worker Responsibilities

## Status

Accepted

## Context

Inventory additions began as a preview-first catalog feature, then accumulated
durable inventory-change persistence, retry state, a background worker, and the
TCGplayer mutation executor in the same source file. That coupled read-heavy
catalog and pricing changes to filesystem recovery and side-effect execution,
despite those areas having different dependencies and failure modes.

Existing callers import all supported inventory capabilities from
`inventory-additions.ts`.

## Decision

Keep `inventory-additions.ts` as the public compatibility facade and separate
the implementation into:

- `service.ts` for catalog search, product caches, selection snapshots,
  preview pricing, and short-lived addition authorization;
- `queue.ts` for persisted inventory-change jobs, validation, leasing,
  recovery, cancellation, resubmission, and state transitions;
- `worker.ts` for serialized background execution and the TCGplayer mutation
  adapter.

No implementation module imports through the compatibility facade, and the
existing public names and root import path remain unchanged.

## Consequences

The catalog service no longer imports filesystem or worker infrastructure. The
queue can be reviewed around persistence invariants without navigating catalog
ranking and pricing code. Worker retry behavior remains independently testable,
while current consumers require no import migration.
