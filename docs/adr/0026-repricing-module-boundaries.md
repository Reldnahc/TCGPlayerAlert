# 0026: Separate Repricing Policy from Marketplace Orchestration

## Status

Accepted

## Context

Repricing grew in one source file to include public contracts, configuration
parsing, the pure pricing calculation, seller-inventory retrieval, comparison
recovery and cache coordination, preview assembly, and queued-mutation
selection. Changes to marketplace request behavior and changes to pricing
policy therefore touched the same module, making review and regression analysis
unnecessarily difficult.

Consumers already import the supported repricing API from `repricing.ts`, so
the internal split must not require application-wide import changes or expose
implementation modules as a new public contract.

## Decision

Keep `repricing.ts` as the compatibility facade and divide implementation by
responsibility:

- `contracts.ts` owns public repricing data types.
- `rules.ts` validates and normalizes operator pricing rules.
- `pricing.ts` owns the deterministic per-listing pricing policy.
- `marketplace.ts` owns seller-inventory snapshots, cache sharing, batched
  comparison recovery, and exact-listing verification.
- `service.ts` composes previews, retains short-lived mutation authorization,
  and invalidates marketplace state after relevant changes.

The existing exported names and root import path remain unchanged.

## Consequences

Pricing policy can be reviewed and tested without navigating transport/cache
code, while marketplace request changes no longer share a class with mutation
selection. The public facade prevents callers from depending on internal file
layout, so these components can evolve without changing existing imports.
