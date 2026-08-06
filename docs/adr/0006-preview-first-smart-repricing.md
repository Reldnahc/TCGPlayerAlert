# ADR 0006: Preview-first smart repricing

- Status: Accepted
- Date: 2026-08-03

## Context

The price queue originally accepted complete listing payloads manually. That supplied transport backpressure but did not help an operator conveniently update cards already listed. A useful repricer must discover seller inventory, compare genuinely equivalent marketplace variants, support condition-aware floors, and make proposed mutations visible before submission.

Price-only Seller Portal mutations also include quantity and reserve fields. A stale queued payload could restore sold inventory unless the listing is read again immediately before submission.

## Decision

- Load the authenticated seller's live marketplace inventory through `tcgplayer-private-api`.
- Compare the same product, printing, and language across ordinary marketplace and Direct channels, excluding the seller's own listings and custom listings.
- Support either same-condition or same-or-better-condition comparison. Better-to-worse order is Near Mint, Lightly Played, Moderately Played, Heavily Played, and Damaged.
- Store reusable pricing profiles containing a hard minimum, item-price or delivered-price comparison, condition policy, optional cent adjustment, explicit price-increase toggle, a sparse-market fallback, and one or more ordered value ranges. Inventory selects these profiles directly; merchandise profiles reference them for initial listing prices. Sparse-market behavior is profile-level because a conservative policy and an always-undercut policy should not make the same decision when seller support is absent.
- Select a range using the lowest qualifying listing, falling back to product market price only when no comparison exists. The inventory response carries one market figure at product level, while live listings are filtered to exact printing, language, and allowed conditions; the exact comparison is therefore the safer value-tier signal. Every range except the last has an editable maximum; the final range is open-ended.
- Let each range calculate from either a percentage of market price or a percentage of the lowest qualifying listing. Market-based pricing may proceed without a competing listing when a valid market price exists.
- Support distinct-seller price bands as the default gap analysis. Collapse qualifying listings from both marketplace channels to each seller's cheapest eligible listing, then find the cheapest anchor whose configured percentage window contains the required number of distinct sellers. Compare an absolute low with that supported anchor. If the low itself has enough nearby seller support, continue using it; if a singleton low is separated from a supported band, use the band or skip according to the range. When minimum comparables, seller-band support, or the selected source is unavailable, apply the profile's explicit sparse-market policy: wait, higher of market and lowest, market then lowest, or lowest then market. Preserve first-versus-second-listing analysis as an explicit legacy mode for previously saved profiles. Gap handling and fallback never silently change condition, printing, or language filters.
- Seed two editable starter profiles once. **Smart conservative** defaults to delivered price, same-or-better condition, zero-cent adjustment, no price increases, 100% pricing, 5%-wide seller bands supported by at least two distinct sellers, and the higher of market or the lowest qualifying listing when evidence is sparse. Through $25, use the supported band when an isolated low reaches the tier's gap. Above $25, also require at least three total comparables and skip isolated lows at 3% for review when a supported band exists. **Sell now** allows price increases, ignores gaps, prefers the lowest qualifying listing, undercuts delivered price by one cent, and then uses market price. A persisted starter-default version marker ensures deleted starter profiles are not recreated.
- Treat those settings as editable policy priors, not statistically fitted claims. Distinct seller agreement is evidence of a price level, not proof of fair value. Accordingly, the default becomes more evidence-seeking as financial exposure rises and sends high-value gaps to operator review.
- Return a server-held, expiring preview. The browser receives display rows and opaque row identifiers, not editable mutation payloads.
- Require the operator to select preview rows before they enter the durable queue.
- Skip custom listings, unsupported conditions, and SKUs with secondary-channel inventory rather than guessing reserve state.
- Re-read the exact live listing immediately before each mutation, preserve current quantity, and stop if the listing disappeared, became custom, or gained secondary-channel inventory.
- Cache the supported-condition marketplace and Direct snapshot in process memory for ten minutes. Load the two channels through separate, sequential comparison requests. If a broad product response is truncated and its embedded listings cannot support a pricing decision, issue a condition-filtered recovery search for only the affected products; batch and serialize those requests and retain them in the same snapshot. Recalculate profiles locally from the merged snapshot, coalesce simultaneous loads, expose snapshot capture time in previews, and retain an explicit force-refresh control. Queuing a mutation invalidates the snapshot. This cache never replaces the mandatory live listing read before mutation.

## Consequences

The application provides reusable bulk-repricing policies without making unattended pricing decisions. Percentage targets, comparable counts, seller support, and gap handling use a short-lived marketplace snapshot, so profile changes and ranges do not add per-card API requests. A normal preview reuses data captured within ten minutes; explicit force refresh, expiry, or process restart triggers a new snapshot load. A truncated broad response only adds narrow recovery reads for products whose returned samples are insufficient, rather than adding a request for every inventory row. Marketplace searches add read traffic before queuing and the worker reads each listing again before mutation to avoid stale-quantity writes. The preview explains the chosen range, absolute low, distinct seller count, supported price band, detected gap, snapshot age, and any wait-or-skip decision before the operator queues selected rows.

## Research basis

- TCGplayer, [Best Practices for Pricing Your Items](https://help.tcgplayer.com/hc/en-us/articles/201914668-Best-Practices-for-Pricing-Your-Items)
- TCGplayer, [Price Settings and Updates](https://help.tcgplayer.com/hc/en-us/articles/16007140992791-Price-Settings-and-Updates)
- NIST/SEMATECH, [Detection of Outliers](https://www.itl.nist.gov/div898/handbook/eda/section3/eda35h.htm)
