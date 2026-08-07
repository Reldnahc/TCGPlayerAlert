# ADR 0011: Read-only feedback workspace

## Status

Accepted on 2026-08-07.

## Context

Operators need to review seller ratings and buyer comments without leaving the local console. Replying to feedback, requesting removal, or connecting feedback to fulfillment mutations has a different risk and is not required.

## Decision

- Read paginated feedback and aggregate rating summaries only through the public `tcgplayer-private-api` contract. Keep TCGplayer endpoint details out of this repository.
- Keep the browser behind a loopback application route. Provider user keys, creator keys, seller-order identifiers, and redundant seller identifiers do not enter the browser contract.
- Mask buyer nicknames at the application-service boundary before returning JSON to the browser.
- Support TCGplayer's observed star, comment-only, and age filters. Preserve one-to-five-star ratings and the three observed fulfillment-question answers without inventing sentiment categories.
- Cache each filtered page and age-window aggregate in memory for one minute. Explicit Refresh requests bypass the relevant cache.
- Do not persist feedback, comments, or buyer nicknames and do not include them in logs, workflow state, jobs, or configuration.
- Do not add replies, removal requests, moderation, customer messaging, or any other feedback mutation.

## Consequences

The Feedback page provides bounded, current storefront visibility without another seller-authenticated API load or a second feedback source of truth. Sensitive provider identifiers remain server-side, and buyer display names match the storefront's privacy posture. Remote schema drift fails through the package validator. Any future feedback mutation requires separate authorization and design review.
