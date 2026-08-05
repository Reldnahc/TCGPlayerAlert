# ADR 0006: Preview-first smart repricing

- Status: Accepted
- Date: 2026-08-03

## Context

The price queue originally accepted complete listing payloads manually. That supplied transport backpressure but did not help an operator conveniently update cards already listed. A useful repricer must discover seller inventory, compare genuinely equivalent marketplace variants, support condition-aware floors, and make proposed mutations visible before submission.

Price-only Seller Portal mutations also include quantity and reserve fields. A stale queued payload could restore sold inventory unless the listing is read again immediately before submission.

## Decision

- Load the authenticated seller's live marketplace inventory through `tcgplayer-private-api`.
- Compare only the same product, printing, language, and channel, excluding the seller's own listings and custom listings.
- Support either same-condition or same-or-better-condition comparison. Better-to-worse order is Near Mint, Lightly Played, Moderately Played, Heavily Played, and Damaged.
- Store reusable repricing profiles containing a hard minimum, item-price or delivered-price comparison, condition policy, optional cent adjustment, explicit price-increase toggle, and one or more ordered value ranges.
- Select a range using the lowest qualifying listing, falling back to product market price only when no comparison exists. The inventory response carries one market figure at product level, while live listings are filtered to exact printing, language, and allowed conditions; the exact comparison is therefore the safer value-tier signal. Every range except the last has an editable maximum; the final range is open-ended.
- Let each range calculate from either a percentage of market price or a percentage of the lowest qualifying listing. Market-based pricing may proceed without a competing listing when a valid market price exists.
- Measure a listing gap as the percentage difference between the cheapest and second-cheapest qualifying listings. Each range can also require a minimum count of qualifying listings. It can ignore a gap, use the second listing as its pricing reference so a separated low can sell first, or skip the card. Gap handling never silently changes condition, printing, language, or channel filters.
- Default to delivered price, same-or-better condition, zero-cent adjustment, no price increases, and 100% of the lowest qualifying comparable. Use four conservative value tiers: up to $5 requires one comparable and uses the next at a 50% gap; up to $25 requires two and uses the next at 30%; up to $100 requires three and skips at 20%; above $100 requires three and skips at 15%.
- Treat those thresholds as editable priors, not statistically fitted claims. TCGplayer documents delivered-price ranking and a Market-Low policy intended to absorb low-price swings. NIST guidance distinguishes flagging/accommodating potential outliers from proving they are erroneous. Accordingly, the default becomes more evidence-seeking as financial exposure rises and sends high-value gaps to operator review.
- Return a server-held, expiring preview. The browser receives display rows and opaque row identifiers, not editable mutation payloads.
- Require the operator to select preview rows before they enter the durable queue.
- Skip custom listings, unsupported conditions, and SKUs with secondary-channel inventory rather than guessing reserve state.
- Re-read the exact live listing immediately before each mutation, preserve current quantity, and stop if the listing disappeared, became custom, or gained secondary-channel inventory.

## Consequences

The application provides reusable bulk-repricing policies without making unattended pricing decisions. Percentage targets, comparable counts, and gap handling use the marketplace products and listings already loaded for the preview, so ranges do not add per-card API requests. Marketplace searches add read traffic before queuing and again before mutation, but avoid stale-quantity writes. The preview explains the chosen range, market/lowest reference, comparable count, detected gap, and any wait-or-skip decision before the operator queues selected rows.

## Research basis

- TCGplayer, [Best Practices for Pricing Your Items](https://help.tcgplayer.com/hc/en-us/articles/201914668-Best-Practices-for-Pricing-Your-Items)
- TCGplayer, [Price Settings and Updates](https://help.tcgplayer.com/hc/en-us/articles/16007140992791-Price-Settings-and-Updates)
- NIST/SEMATECH, [Detection of Outliers](https://www.itl.nist.gov/div898/handbook/eda/section3/eda35h.htm)
