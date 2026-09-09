# ADR 0033: Local inventory is the stock source of truth

## Status

Accepted and implemented on 2026-08-25.

## Context

The first provider-neutral inventory workspace aggregates live marketplace
listings. That makes the Inventory page useful for observing and directly
editing a connection, but it does not represent cards that are owned and not
listed anywhere. It also leaves no safe authority for deciding whether stock
may be published to more than one marketplace.

Copying quantities between marketplace connections is unsafe. A remote
quantity can change because of a sale, a manual correction, eventual
consistency, or a delayed mutation. Mirroring that value into another provider
cannot reliably distinguish those causes and can create feedback loops or
overselling. A quantity-one item can also sell concurrently on two providers
before either order is observed.

## Decision

The application owns a durable, versioned local inventory ledger. Its
`onHand` quantity is the authoritative count of physical stock known to the
application. A local item:

- has a stable application-generated ID;
- contains normalized catalog identities and display metadata;
- may exist without any marketplace listing;
- remains in the ledger at zero quantity for reconciliation and audit
  continuity; and
- is merged only by a shared exact-variant catalog identity.

Exact-variant matching uses a provider-neutral, fail-closed hierarchy:

1. A shared provider-declared exact variant ID, such as a TCGplayer SKU.
2. A shared product or printing ID (TCGplayer product, Scryfall printing, or
   MTGJSON UUID) plus normalized language, condition, and finish.
3. For Magic singles without a shared ID, a normalized natural printing key:
   game, set code, collector number, List status, language, condition, and
   finish.

The resolver recognizes provider spelling differences such as `English` and
`en`, `Near Mint` and `near_mint`, or `Normal` and `nonfoil`. It derives no
exact identity when any required variant field is missing or when multiple
values disagree. Card name and set name never participate in automatic
matching. The List indicator is a discriminator within a natural key, not an
identity by itself; the `PLST` set code implies a List printing when a provider
does not expose a separate flag.

A shared provider-exact ID always wins. When two records expose the same exact
namespace with different values, a weaker derived key cannot override that
contradiction. If the best available tier resolves to multiple local items, the
operation stops for reconciliation instead of selecting one arbitrarily.

Marketplace inventory is an observation of remote listing state, not stock
authority. The Inventory workspace presents local items first and shows
provider listings separately, linked when an exact catalog identity matches.
An unmatched provider listing never creates or changes local stock
automatically.

Add Cards adds quantity to the local ledger. Catalog search may still use an
explicit capable provider as a metadata source, but selecting a catalog source
does not select a listing destination and does not mutate that provider.

This phase deliberately provides no cross-posting, automatic publication,
provider-to-provider mirroring, or automatic remote quantity reconciliation.
Existing provider mutation services and durable jobs remain available for
compatibility, but the local Add Cards and Inventory workflows do not invoke
them.

## Safety invariants

1. Local stock mutations and remote listing mutations are different commands.
2. No local stock change causes a provider mutation in this phase.
3. No provider inventory read overwrites or seeds local `onHand` quantity.
4. The UI identifies catalog sources and marketplace observations without
   calling either one a stock destination.
5. Provider-declared exact identities are unique across local items. New
   writes also merge safely derived matches; any pre-existing derived
   ambiguity blocks automatic selection.
6. Every local state write is validated and atomically replaces the previous
   version.

## Consequences

Operators can record unlisted cards immediately and can compare them with
remote listings without enabling cross-posting. Existing remote inventory will
initially appear as unmatched until the operator adds or later imports the
corresponding local item. The application can warn about multiple observed
listings, but it cannot prevent an oversell caused by listings that already
exist independently on multiple marketplaces.

Future publication must be an explicit local-item-to-connection command with a
preview, idempotency key, durable job, and reconciliation result. Shared-stock
publication policies and pre-sale reservations require a separate ADR and
remain out of scope.

## Explicit ManaPool publication amendment

The Add Cards workflow may explicitly publish a newly recorded local item to a
connection advertising the `inventory-publisher` capability. Publication is a
separate command: the operator chooses quantity and price, reviews the freshly
read remote listing, and confirms the mutation. Quantity cannot exceed local
`onHand`. The application persists the intent before transport and marks an
ambiguous or mismatched response `review-required`; it never retries the remote
mutation automatically. This does not enable cross-posting or automatic remote
quantity synchronization.

The browser presents this as one `List on` destination choice. Selecting a
connection with the legacy `inventory-additions` capability records local stock
and dispatches the existing priced durable listing job in the same action;
selecting local-only performs no provider command.

## One-time marketplace bootstrap

The operator may explicitly initialize missing local items from a fresh read
of marketplace inventory. The operation has a preview and confirmation step
and remains a provider read plus local write; it never invokes an inventory
mutator.

- Only positive-quantity listings with an exact-variant identity are eligible.
- Listings connected by any shared exact identity form one candidate.
- A candidate already linked to local stock is skipped; bootstrap never
  overwrites operator-entered `onHand`.
- The suggested local quantity is the highest observed listing quantity in the
  group. Quantities from channels or marketplaces are never summed because
  they may represent the same physical stock.
- Provider failures and listings without an exact identity remain visible in
  the preview. Successfully read candidates may still be imported.
- Confirmation re-reads provider inventory and recomputes the plan before one
  atomic local mutation. Repeating the operation is safe because linked items
  are skipped.

## Order-driven stock deduction

Once local stock exists or bootstrap succeeds, every newly processed normalized
order deducts its exact-variant quantities from the local ledger before print or
other workflow actions run. This applies uniformly to capable connections,
including TCGplayer and ManaPool; the orchestration layer contains no provider
branch.

The local state records the qualified order reference and aggregate deduction
result in the same atomic write as the quantity changes. Reprocessing an order
after a retry or restart returns `already-applied` and cannot deduct twice.
First-run baseline orders are not processed and therefore are not deducted;
their sales are already reflected by the marketplace quantities used during
bootstrap. Explicit backlog processing does deduct those orders.

When exact local stock is lower than the sold quantity, the item clamps at zero
and the durable result records the shortage. A line with no matching local exact
identity is recorded as unmatched. Neither case invents negative stock or
mutates a marketplace. Cancellation, refund, and restock adjustments remain
explicit operator work until a separately reviewed reversal policy exists.

## Implemented boundaries

- `src/local-inventory.ts` owns versioned, validated, atomic persistence and
  serialized stock mutations.
- `src/local-inventory-contracts.ts` owns browser-safe item validation without
  importing filesystem or cryptography modules.
- `src/local-inventory-workspace.ts` links remote observations to local items
  only through a provider-declared or safely derived exact-variant identity.
- `src/marketplaces/catalog-identity.ts` owns the provider-neutral identity
  hierarchy and canonical variant vocabulary. Provider adapters supply raw
  IDs and attributes but do not own cross-provider matching policy.
- `GET /api/inventory` returns local items even if every marketplace inventory
  read fails; provider failures remain visible as safe issues.
- `POST /api/local-inventory/catalog-items` uses the selected capable
  connection only as a catalog source and writes the exact SKU to local stock.
- `PUT /api/local-inventory/items/{localInventoryId}` changes only local
  `onHand` quantity.
- `GET /api/local-inventory/import-preview` and confirmed
  `POST /api/local-inventory/import` implement the conservative, rerunnable
  marketplace bootstrap.
- Local state version 2 migrates version 1 in memory and atomically stores
  qualified sale-deduction idempotency records with stock changes.
- The provider-neutral synchronization workflow deducts confirmed exact order
  lines before actions and leaves first-run baseline orders unchanged.
- The Add Cards and Inventory browser workflows call neither provider
  inventory mutation routes nor the legacy inventory-addition queue.

Automated HTTP coverage observes the provider mutator while exercising both
local write endpoints and requires that it receive zero commands.
