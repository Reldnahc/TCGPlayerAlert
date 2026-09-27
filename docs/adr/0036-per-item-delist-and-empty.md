# 0036: Reviewed per-item delisting and local stock clearing

Status: Accepted

The Inventory row needs an undo action for accidentally added stock. This action
targets one local item and its matched marketplace listings, never the entire
inventory.

The server issues a short-lived, single-use review token containing a fingerprint
of the local item and current matched listings. Confirmation rechecks that
fingerprint and requires the explicit `DELIST_AND_EMPTY_ITEM` marker. It uses the
existing provider-neutral inventory mutation capability to clear each listing,
then reads inventory again before setting local on-hand stock to zero. This
operator-confirmed multi-marketplace action is synchronous; ordinary TCGplayer
additions and repricer removals continue to use their existing queue.

The local ledger lease serializes clearing with stock edits and replenishment.
The inventory queue lease cancels this SKU's pending jobs and prevents new queue
claims during clearing; already applying jobs stop the action. Enabled listing
schedules and queued/running listing runs stop the action for operator review.
Auto-relisting is paused before remote mutations. Persist a bounded attempt
history in the local ledger before mutations, retaining running, completed, and
review-required outcomes without credentials or customer data. Existing ledgers
need no migration because this history is optional.

Marketplace failures, unsupported listings, changed state, and unverifiable
removals never silently clear local stock. Partial remote success is possible;
there is no rollback and no automatic retry. A new review reads current state.
Only matched listings on enabled connections are affected; the dialog explicitly
excludes unmatched listings. The operator must separately reconcile stock on
disabled or disconnected accounts.
