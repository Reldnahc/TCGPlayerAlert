# ADR 0009: Extensible game-pricing modules

- Status: Accepted
- Date: 2026-08-07

## Context

Pricing profiles provide marketplace-wide behavior, but useful pricing metadata differs by game. Magic products expose rarity, while another product line may need a different attribute. Adding game checks directly throughout repricing and inventory-addition workflows would couple those workflows to individual games and make their results diverge.

## Decision

- Pricing profiles may own a validated array of discriminated game-pricing modules. Missing arrays migrate to an empty array so existing profiles retain their behavior.
- Game-specific policy is evaluated by a pure registry boundary before the shared minimum-price calculation. Both existing-inventory repricing and new-listing pricing use that calculation.
- The first module is `magic-rarity-floor`. It applies only when the product line is `Magic: The Gathering`, matches rarity names case-insensitively, and accepts configured rarity names rather than assuming the provider's rarity list is closed.
- A configured rarity amount is an additional floor: it may raise but never lower the pricing profile's general minimum. A blank or unmatched rarity falls back to the general minimum.
- The module is disabled by default. The Settings UI provides common Magic rarity rows and permits additional rarity names.
- Module evaluation uses product metadata already present in catalog and inventory responses. It performs no additional provider requests.
- Preview rows identify the effective game-specific floor and explain when it overrides the calculated target.

## Consequences

- Sellers can give low-value Magic rarities different safety floors while continuing to share pricing profiles between Inventory and merchandise profiles.
- New game behavior can be added as another module without changing queue, transport, or marketplace-comparison code.
- A rarity floor does not raise a current listing when price increases are disabled; the existing no-increase policy remains authoritative.
- Provider rarity spelling remains external data. Custom rarity rows allow newly observed values without an application release, while duplicate names and invalid amounts fail configuration validation.
