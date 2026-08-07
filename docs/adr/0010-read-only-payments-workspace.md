# ADR 0010: Read-only payments workspace

## Status

Accepted on 2026-08-07.

## Context

Operators need payout visibility without returning to Seller Portal for routine review. Payment setup, bank details, payout administration, and money-moving actions have materially different risk from displaying seller-authorized payout records and are not required by this application.

## Decision

- Consume payout history, one payout's displayed transactions, and the current unpaid balance with its displayed upcoming transactions only through the public `tcgplayer-private-api` contract.
- Keep the browser behind loopback application routes. Seller credentials and the private package remain server-side.
- Cache payout pages and unpaid balance data in memory for one minute and payout details for five minutes. Explicit Refresh requests bypass the relevant cache.
- Do not persist payment data or include it in logs, workflow state, jobs, or configuration.
- Do not request or expose payment instruments, masked bank details, payment setup, provider accounts, holds, invoices, or administrative data.
- Do not add payout approval, rejection, retry, or any other payment mutation to either the application or its browser API.
- Preserve TCGplayer's payout status text as the display source of truth. The application may group currently observed statuses for summary cards but must not invent lifecycle states.
- Treat all USD payout and transaction amounts from the package as integer cents and convert them only at the presentation boundary.

## Consequences

The Payments page provides useful reporting with bounded API use and no money-moving capability. Its payout summaries cover the currently loaded payout page, while the unpaid balance and searchable upcoming-transactions view share one dedicated read and cache entry. Private endpoint drift fails through the package's response validation. Features such as payment setup, bank-account management, issuing refunds, and payout administration require separate authorization and design review rather than expansion of this workspace.
