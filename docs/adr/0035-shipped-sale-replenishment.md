# Shipped-sale replenishment

An opt-in rule lives on a local Inventory item and one marketplace connection.
It keeps a configurable public quantity (default one) by replacing sold units
only after the provider confirms shipped or delivered. It is a visibility limit,
not a per-buyer purchase limit. Local on-hand includes the publicly listed units.

Rules, outstanding order references, and bounded job history are persisted with
local inventory. Recording a sale and its replenishment ticket is atomic and
idempotent. Only sales first processed after enabling are eligible; enabling or
restocking never publishes immediately. Canceled/refunded orders require manual
stock adjustment and do not replenish. No buyer data is retained.

The inventory worker checks one rule at a time, under its existing process lease,
queue enable switch and pacing. It prioritizes queued operator mutations. Each
rule is polled at most once per minute. Local inventory mutations and policy
changes are serialized through submission. Replenishment never exceeds either
remaining local stock after reserving quantities on other connected marketplaces,
the configured public limit, or confirmed shipped sales. A failure to read another
connection holds replenishment. Local state uses a shared file lease across
service instances, including command-line synchronization.
A running attempt is persisted before submission; interruptions and uncertain
results pause for operator reconciliation without automatic mutation retries.
History appears in Jobs; policy controls remain in Inventory.

The first adapter supports primary-channel TCGplayer exact SKUs through the
client's public exports and existing live-validated inventory executor. Custom
or secondary inventory is unsupported. Fixed-price overrides take precedence;
otherwise the operator supplies a relisting price. No client package changes.
Explicit repricer delisting pauses the matching rule before queuing removal.
Re-enabling after review acknowledges reconciliation and discards old tickets;
only future confirmed sales can trigger another attempt.
