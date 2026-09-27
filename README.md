# TCGPlayerAlert

A local-first, multi-marketplace seller console. TCGplayer and ManaPool share
one provider-neutral order, fulfillment, pull-list, scanner, and inventory UI.
Providers register capability-based adapters, so adding another marketplace
does not require provider branches in generic routes or pages.

This project is not affiliated with, endorsed by, or supported by TCGplayer or
ManaPool. Use it only with seller accounts you are authorized to operate.

## What works across providers

- Aggregated ready and historical order views with connection-qualified IDs
- Order detail, tracking, shipment completion, address labels, and packing slips
- One combined master pull list with tiered exact-variant merging and qualified progress
- Background synchronization and scanner workflows with per-connection failures
- Durable local inventory with read-only marketplace listing observations
- Capability-driven navigation, health, unavailable states, and partial results

ManaPool packing slips are generated locally from normalized order detail;
ManaPool does not need a native packing-slip endpoint. TCGplayer can use its
native document facet. The master pull list combines every healthy order
connection and uses provider-native pull data when available, otherwise
normalized order lines.

Catalog search is an optional connection capability used as a metadata source
for local Add Cards. Repricing jobs, payments, messages, feedback, and
browser-managed session pairing remain optional connection capabilities. They
do not block ManaPool or another provider.

## Repricing shipping

TCGplayer delivered-price matching uses this store's free shipping at $5 or
more. A current listing's under-$5 shipping charge is not deducted when
matching a qualifying price: $5.98 with free shipping and a one-cent undercut
produces $5.97, not $4.48. Sub-$5 comparisons retain their shipping adjustment.
Competitors' shipping charges still count toward their delivered prices.

Saving a fixed price queues the change and recalculates the preview using the
existing marketplace snapshot while showing progress. Fixed rows distinguish
the saved target from the last observed live price. Use **Refresh marketplace**
after the queue applies the change to verify the live price; saving alone does
not confirm that the marketplace has accepted it.

## Safety defaults

- Print actions, automatic shipment scanning, Discord, and mutation queues are
  independently disabled in the committed example.
- The first successful sync establishes a baseline without processing old orders.
- Ambiguous remote mutations become `review-required` and are never retried
  automatically.
- Addresses and document bytes remain in memory or temporary print files; they
  are not written to workflow state or logs.
- Configuration stores environment-variable names, never credential values.
- Remote IDs are always qualified by `connectionId`, so multiple accounts may
  safely contain the same order or listing ID.
- Local `onHand` stock is authoritative. Add Cards has one **List on** selector
  for TCGplayer, ManaPool, or local-only entry. TCGplayer additions use its
  priced durable queue; ManaPool additions show one final quantity-and-price
  confirmation. Ordinary local quantity edits never publish automatically.
- A reviewed one-time import can initialize missing local items from current
  marketplace observations. Cross-listed quantities use the highest observed
  value and are never summed.
- After local stock is initialized, newly synchronized sales deduct exact
  variants once using a durable qualified-order record. First-sync baseline
  orders are not deducted again.
- Cross-provider identity resolution prefers a shared exact SKU, then combines
  a shared product/printing ID with normalized language, condition, and finish.
  A complete set-code/collector-number/List-status key is the final fallback;
  incomplete or contradictory records remain unmatched.

## Limited-quantity auto-relisting

In **Inventory > Local stock > Auto-relist**, enable selected exact TCGplayer
items, choose a public quantity limit (default 1), and set a relisting price.
Local **on hand** must include all reserve stock plus the units already listed.
Enabling does not change the live listing immediately; reduce an excessive live
quantity before enabling.

Only new sales recorded after enabling qualify. After the marketplace confirms
all tracked orders shipped or delivered, the inventory worker replaces sold
units up to the public limit and available local stock. Listings on other
connected marketplaces reserve stock; unreadable inventory stops verification.
A fixed-price override takes precedence over the relisting price. This feature
limits visible quantity, not purchases per buyer.

Run the service with the inventory queue enabled. **Jobs > Auto-relist** shows
waiting orders and durable attempt history. Pausing or explicitly delisting
clears pending tickets. Uncertain or interrupted attempts require checking the
live listing and acknowledging reconciliation before watching future sales.
Canceled/refunded orders do not replenish automatically. No rule is enabled by
default and the feature does not publish all local stock.

## Requirements

- Node.js 24 or newer for source development
- At least one authorized TCGplayer or ManaPool seller account
- Windows PowerShell 5.1 and installed printer drivers for Windows printing

The packaged per-user Windows installer includes its own runtime. See the
[Windows installer guide](docs/WINDOWS_INSTALLER.md).

## Install

The repository currently consumes pinned local tarballs for the provider API
packages. Place the package archives under `.packages`, then run:

```powershell
npm install
Copy-Item .env.example .env.local
Copy-Item config/local.example.json config/local.json
```

Package versions and source commits are recorded in
[docs/DEPENDENCIES.md](docs/DEPENDENCIES.md).

## Configure marketplace connections

Configuration schema version 6 uses an open connection map:

```json
{
  "version": 6,
  "providers": {
    "synchronizationConcurrency": 2,
    "connections": {
      "tcgplayer-main": {
        "providerId": "tcgplayer",
        "enabled": true,
        "label": "TCGplayer",
        "settings": {
          "authCookieEnv": "TCGPLAYER_AUTH_COOKIE",
          "sellerKeyEnv": "TCGPLAYER_SELLER_KEY",
          "pageSize": 100,
          "maximumPages": 100
        }
      },
      "manapool-main": {
        "providerId": "manapool",
        "enabled": true,
        "label": "ManaPool",
        "settings": {
          "emailEnv": "MANAPOOL_EMAIL",
          "accessTokenEnv": "MANAPOOL_ACCESS_TOKEN",
          "pageSize": 100,
          "maximumPages": 100
        }
      }
    }
  }
}
```

The `emailEnv` and `accessTokenEnv` values are secret-reference names, not the
normal ManaPool credential-entry workflow. Enter the ManaPool seller email and
Seller API code under Settings > Connections; they are kept in protected local
storage and apply without a restart. Environment values are development/test
fallbacks. A version-five configuration can still be migrated in memory to one
TCGplayer connection, but automatic connection overlays are no longer used:
every additional connection must be explicit. Saving Settings writes the
complete version-six document; validation and startup do not rewrite it.

The full non-secret example is
[config/local.example.json](config/local.example.json). Validate it without
contacting a provider or printer:

```powershell
npm run build
npm run config:validate
```

### TCGplayer browser pairing

The browser connector is optional when valid TCGplayer environment credentials
are present. Build it with `npm run build:extension`, load the appropriate
unpacked directory under `dist/browser-extension`, then pair it from the
TCGplayer card in Settings. The session is protected with Windows DPAPI and is
never returned to the web UI. Disconnecting TCGplayer does not block ManaPool.

See [browser-extension/SUBMISSION.md](browser-extension/SUBMISSION.md) and
[browser-extension/PRIVACY.md](browser-extension/PRIVACY.md).

## Run

```powershell
npm run build
npm run start
```

Open the printed loopback URL, normally `http://127.0.0.1:47831`. Use
`npm run configure` when only the local console is needed without scheduled
polling or mutation workers.

The UI reads `/api/marketplace-connections` and exposes workspaces from adapter
facets. Orders use qualified URLs such as
`/api/connections/{connectionId}/orders/{remoteId}`. There are no unqualified
order aliases or provider query-string switches.

## Operations

- Configure Windows printers and independent address-label/packing-slip actions
  in Settings. Detailed behavior is in [docs/PRINTING.md](docs/PRINTING.md).
- Configure pull-list grouping and physical-bin rules in Settings. Changes
  reproject the active in-memory list without another provider call.
- Add Cards records exact catalog variants in the durable local inventory
  ledger. The catalog connection supplies metadata only; no marketplace listing
  is created. Marketplace listing quantities on Inventory are read-only
  observations in this phase.
- Inventory offers a review-and-confirm one-time marketplace import. Later
  confirmed sales deduct local stock before fulfillment actions; shortages and
  unmatched exact identities are recorded without creating negative stock.
  Cancellations, refunds, and restocks remain manual adjustments.
- Discord webhook credentials stay in protected storage or the environment;
  message notifications omit subjects and bodies.

## Add another provider

Follow [docs/PROVIDER_AUTHORING.md](docs/PROVIDER_AUTHORING.md) and copy the
sanitized [adapter contract-test template](docs/templates/provider-adapter.contract.test.ts).
The adapter supplies only the facets it supports. Generic services, routes, and
pages must consume normalized contracts and must not import a provider SDK.

## Verify changes

```powershell
npm run check
```

The gate checks formatting, lint, types, tests, the server/web/extension builds,
and architecture boundaries. Tests use synthetic providers and sanitized data;
ordinary test runs do not contact real marketplaces or printers.

The provider-neutral design is recorded in
[ADR 0032](docs/adr/0032-provider-neutral-marketplace-architecture.md), and
local inventory ownership and cross-posting boundaries are recorded in
[ADR 0033](docs/adr/0033-local-inventory-ledger.md). Package self-reviews are in
[docs/implementation/provider-neutral-self-reviews.md](docs/implementation/provider-neutral-self-reviews.md).
