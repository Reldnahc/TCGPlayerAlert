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
- Support item-price or delivered-price comparison, a hard global minimum, an optional cent adjustment, and an explicit price-increase toggle.
- Default to delivered price, same-or-better condition, zero-cent adjustment, and no price increases.
- Return a server-held, expiring preview. The browser receives display rows and opaque row identifiers, not editable mutation payloads.
- Require the operator to select preview rows before they enter the durable queue.
- Skip custom listings, unsupported conditions, and SKUs with secondary-channel inventory rather than guessing reserve state.
- Re-read the exact live listing immediately before each mutation, preserve current quantity, and stop if the listing disappeared, became custom, or gained secondary-channel inventory.

## Consequences

The application now provides a convenient bulk repricing workflow without making automatic unattended pricing decisions. Marketplace searches add read traffic before queuing and again before mutation, but avoid stale-quantity writes. The minimum is currently global per preview; future rule modules can add scoped floors without changing the API transport package.
