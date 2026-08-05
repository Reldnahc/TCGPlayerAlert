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
- Select a range using product market price, falling back to the lowest qualifying listing when market price is unavailable. Every range except the last has an editable maximum; the final range is open-ended.
- Let each range calculate from either a percentage of market price or a percentage of the lowest qualifying listing. Market-based pricing may proceed without a competing listing when a valid market price exists.
- Measure a listing gap as the percentage difference between the cheapest and second-cheapest qualifying listings. Each range can ignore that gap, use the second listing as its pricing reference so the low outlier can sell first, or skip the card. Gap handling never silently changes condition, printing, language, or channel filters.
- Default to delivered price, same-or-better condition, zero-cent adjustment, no price increases, and one all-values range at 100% of lowest with gap handling disabled. This preserves existing configurations and behavior.
- Return a server-held, expiring preview. The browser receives display rows and opaque row identifiers, not editable mutation payloads.
- Require the operator to select preview rows before they enter the durable queue.
- Skip custom listings, unsupported conditions, and SKUs with secondary-channel inventory rather than guessing reserve state.
- Re-read the exact live listing immediately before each mutation, preserve current quantity, and stop if the listing disappeared, became custom, or gained secondary-channel inventory.

## Consequences

The application provides reusable bulk-repricing policies without making unattended pricing decisions. Percentage targets and gap handling use the marketplace products and listings already loaded for the preview, so ranges do not add per-card API requests. Marketplace searches add read traffic before queuing and again before mutation, but avoid stale-quantity writes. The preview explains the chosen range, market/lowest reference, detected gap, and any wait-or-skip decision before the operator queues selected rows.
