# Persistent fixed prices in repricing

Fixed prices belong to exact SKU/channel listings in the configured price queue,
independently of the selected pricing profile. The repricing workspace lets an
operator review a price and explicitly save and queue it, or restore profile
pricing. Overrides persist across restarts and remain visible in future previews.
Scheduled and manual profile runs exclude fixed-price rows from their updates.

The existing version-one queue document gains an optional fixed-price map; older
documents load with no overrides. Saving or clearing an override atomically
supersedes pending updates for that listing. Changes are blocked while a listing
has an applying or unresolved ambiguous job. Enqueue and resubmit reject updates
that conflict with an override, including updates from older previews. Clearing
an override requires a new preview before profile changes can be queued.

Fixed prices bypass profile policy, but retain the existing exact-SKU eligibility,
live inventory checks, queue enable switch, pacing, and ambiguous-result handling.
Like the existing queue, overrides are scoped to its configured state file; use
separate queue state for separate seller accounts.

Operator workflow: open Repricing, update the preview, select **Set fixed price**
on a listing, enter the exact amount, then **Save & queue fixed price**. The
override is durable immediately; the remote update follows the enabled queue.
Use **Fixed prices only** to find overrides, **Edit fixed price** to change one,
or **Use profile** to clear it and review a fresh profile proposal. Clearing an
override does not itself submit the profile price. Canceling a queued update
does not clear its fixed-price policy; clear it from Repricing explicitly.
