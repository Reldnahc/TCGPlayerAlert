# ADR 0010: Read-only payments workspace

## Status

Accepted on 2026-08-07.

## Context

Operators need payout visibility without returning to Seller Portal for routine review. Payment setup, bank details, payout administration, and money-moving actions have materially different risk from displaying seller-authorized payout records and are not required by this application.

## Decision

- Detect the account-selected legacy or Money Movement payment experience through the public `tcgplayer-private-api` contract. Legacy mode consumes only the displayed estimated-future and past-payment tables; Money Movement mode consumes payout history, one payout's displayed transactions, and the current unpaid balance with its displayed upcoming transactions.
- Keep the browser behind loopback application routes. Seller credentials and the private package remain server-side.
- Cache the payment-experience result, payment pages, and upcoming payment data in memory for one minute and Money Movement payout details for five minutes. Explicit Refresh requests bypass the relevant cache.
- Do not persist payment data or include it in logs, workflow state, jobs, or configuration.
- Do not request or expose payment instruments, masked bank details, payment setup, provider accounts, holds, invoices, or administrative data.
- Do not add payout approval, rejection, retry, or any other payment mutation to either the application or its browser API.
- Preserve TCGplayer's payout status text as the display source of truth. The application may group currently observed statuses for summary cards but must not invent lifecycle states.
- Treat all USD payout and transaction amounts from the package as integer cents and convert them only at the presentation boundary.

## Consequences

The Payments page provides useful reporting with bounded API use and no money-moving capability. Legacy sellers receive the same summary columns shown in Seller Portal rather than empty results from an unassigned Money Movement account. Newer Money Movement sellers retain payout details and the searchable upcoming-transactions view. Private endpoint drift fails through the package's response validation. Features such as payment setup, bank-account management, issuing refunds, and payout administration require separate authorization and design review rather than expansion of this workspace.
