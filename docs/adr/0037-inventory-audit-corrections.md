# 0037: Reviewed listing corrections from inventory audit

Status: Accepted

The inventory audit exposes local stock that was never fully listed, including
additions stopped after a stale quantity preview. Operators can repair an exact
TCGplayer variant from the audit without using Add Cards and increasing local
stock again.

The server recomputes the missing quantity from local stock and fresh marketplace
observations. It reserves quantities on other connections and caps the target
at any enabled replenishment public limit. The existing listing price is the
default; a saved fixed-price override takes precedence. An unlisted SKU requires
an explicit price. Catalog identity must be unique, and custom or secondary-channel
inventory remains unsupported.

A short-lived, single-use preview records the reviewed stock, price, limits, and
local item. Confirmation repeats the reads under the local ledger lease and
rejects changed state. The existing durable inventory queue receives the relative
shortfall. A queue-lease check rejects pending or applying jobs for the same SKU
instead of merging a second repair into them. The normal worker retains its final
quantity check, pacing, and uncertain-outcome handling. Local stock and pricing
policies are not changed by correction submission.

The UI distinguishes queued corrections from verified listings. Refresh reads
marketplace observations again. Other marketplace connections remain audit-only
until they have a compatible reviewed correction workflow.
