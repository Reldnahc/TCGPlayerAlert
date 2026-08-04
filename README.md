# TCGPlayerAlert

A local-first, configurable seller automation service. It polls the authoritative TCGplayer ready-to-ship queue, reconciles orders against durable state, evaluates declarative rules, dispatches modular actions, and processes explicitly queued listing and pricing changes at a safe pace.

The first action modules draw an address label through the native Windows print system and render a packing-slip PDF inside the application before sending it to another OS-visible printer. Printer vendors and names are configuration, not application assumptions.

This project is not affiliated with, endorsed by, or supported by TCGplayer. It uses the separately maintained unofficial `tcgplayer-private-api` package and must only access an authorized seller account.

## Current safety defaults

- `dryRun` is enabled in the committed example. The ignored local configuration may be deliberately switched to live printing after printer tests pass.
- The first successful sync establishes a baseline without processing existing orders.
- No tracking or shipment mutation is part of the automatic workflow.
- Price changes are opt-in jobs in a separate durable queue. Only one is submitted at a time, with a configurable delay, and dry run pauses the worker.
- Card additions require an exact product-condition SKU and a reviewed price preview. They use a separate durable queue, and dry run pauses its worker too.
- Addresses and document bytes remain in memory and temporary print files only; they are not stored in workflow state or logs.
- Interrupted or ambiguous print submissions become `review-required` and are never retried automatically.

## Requirements

- Node.js 20.19 or newer
- An authorized TCGplayer seller session and seller key
- Windows PowerShell 5.1 and installed printer drivers for the initial Windows adapters

## Bootstrap with the local API package

Create the immutable development tarball from the adjacent API repository:

```powershell
New-Item -ItemType Directory -Force .packages
Push-Location ..\tcgplayer-private-api
npm pack --pack-destination ..\TCGPlayerAlert\.packages
Pop-Location
npm install
```

The tarball is intentionally ignored by Git. `package-lock.json` pins its integrity. The current application contract requires `tcgplayer-private-api` 0.4.0 from the commit recorded in [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md). After that package is published, replace the file dependency with the released semantic version.

## Configure

The repository creates ignored local files for you:

- `.env.local` for `TCGPLAYER_AUTH_COOKIE` and `TCGPLAYER_SELLER_KEY`
- `config/local.json` for scheduling, rules, actions, and printers

Do not commit either file. The committed [.env.example](.env.example) and [local.example.json](config/local.example.json) contain no secrets or personal printer settings.

Build once, then launch the local settings screen:

```powershell
npm run build
npm run configure
```

Open the printed `http://127.0.0.1:47831` address. The UI separates Automation, Add cards, Repricing, and Jobs into persistent, keyboard-accessible tabs, with connection, dry-run, and queue status always visible. Its save banner appears only while persistent automation or worker settings differ from their last saved values. The UI discovers installed Windows printers and provides independent on/off controls for address labels and packing slips, along with polling, dry-run, label-size, font, PDF scaling, DPI, and queue settings. Catalog search is ranked by name likeness and includes product images. The UI listens only on this computer and never receives or displays the seller credentials from `.env.local`.

Validate non-secret configuration without contacting TCGplayer or printing:

```powershell
npm run build
npm run config:validate
```

## Operate

Run one authoritative synchronization:

```powershell
npm run sync
```

The first run records the current queue as a baseline. To deliberately process the existing queue instead:

```powershell
node --env-file=.env.local dist/cli.js sync --process-backlog
```

Start the long-running scheduler, which defaults to 60 minutes:

```powershell
npm start
```

The scheduler also hosts the same local settings screen at the URL written to its startup log. Saved settings are used on the next scheduled synchronization; restart the service if a change must take effect before then.

Inspect safe workflow counts and the last synchronization result:

```powershell
npm run status
```

The scheduler and separately invoked manual syncs share a filesystem lease, so they cannot reconcile or dispatch actions concurrently.

## Add cards to inventory

Open the settings screen and use **Add cards**:

1. Search for the card name, optionally narrowing by product line. Exact-name matches appear before broader fuzzy matches, and artwork helps identify the correct printing.
2. Choose the exact set, then select condition, printing, and language independently. Only valid combinations are offered, and language defaults to English whenever English is available.
3. Enter the quantity and pricing rules. Delivered-price comparison (item plus shipping) is the default. Enter the shipping rate already configured in Seller Portal; the browser remembers this pricing preference but does not change your Seller Portal shipping settings. For a standalone item under $5, the preview applies TCGplayer's current $1.49 minimum shipping charge.
4. Preview the live seller quantity and proposed initial price, verify them, and queue the addition.

The long-running service processes the queue; `npm run configure` only hosts the settings UI. Start `npm start` when queued jobs should be submitted. Dry run or a disabled inventory queue keeps them pending.

Pending additions for the same SKU are combined. Before every request, the worker re-reads the seller's current quantity and secondary-channel inventory. It submits both the relative addition and the resulting absolute quantity. A changed quantity, custom listing, or secondary-channel listing becomes `review-required` instead of risking an incorrect update. Accepted requests are labeled `submitted` because Seller Portal may finish processing asynchronously.

Inspect or cancel jobs from either the UI or CLI:

```powershell
node dist/cli.js inventory status
node dist/cli.js inventory cancel --job JOB_ID
```

## Reprice listed cards

Open the settings screen and use **Smart repricing**. Set a minimum item price, choose whether comparisons use item price or delivered price, and choose same-condition or same-or-better-condition matching. Click **Refresh inventory & preview**, review every proposed change, then queue selected rows.

The default same-or-better rule treats conditions as `Near Mint > Lightly Played > Moderately Played > Heavily Played > Damaged`. For example, a Moderately Played card at $3 can match a qualifying Lightly Played listing at $2. Printing and language must also match. Price increases are off by default, the undercut is zero cents by default, and the configured minimum is a hard floor.

Custom listings and SKUs with secondary-channel inventory are shown but skipped because their inventory state cannot be preserved safely. Immediately before each mutation, the worker re-reads the live listing, preserves its current quantity, and abandons the job if the listing sold or its inventory shape changed.

Integrations can enqueue one update or a batch through the CLI without waiting for TCGplayer:

```powershell
node dist/cli.js price queue --file .\price-updates.json
node dist/cli.js price status
node dist/cli.js price cancel --job JOB_ID
```

The JSON file may contain one update or `{ "updates": [...] }`. A complete item looks like:

```json
{
  "productId": 123,
  "productName": "Example card",
  "productConditionId": 456,
  "conditionId": 1,
  "channelId": 0,
  "categoryName": "Example game",
  "quantity": 7,
  "price": 12.34,
  "storePriceCustomId": null,
  "reserveQuantity": 0
}
```

Pending jobs for the same SKU/channel are superseded by the newest price. The service submits one listing per request and starts the next as soon as the previous request finishes; an optional cooldown can be configured. A definite HTTP 429 is delayed for five minutes; authentication and validation failures stop as failed. A timeout, disconnect, server error, or interrupted in-flight update becomes `review-required` and is never retried automatically. Check the listing in Seller Portal before deciding what to do with a review-required job. Seller Portal may continue processing after it accepts a request.

## Enable printing safely

The example uses `windows-native-label` for address text and `windows-pdf` for packing slips. Neither needs a separately installed PDF viewer. Configure each exact Windows printer name; the label adapter also uses the action's configured dimensions, while the PDF adapter controls render DPI and scaling.

The optional `command` PDF adapter remains available for other systems and custom printer tools. It launches the configured executable directly with no shell and supports `{file}`, `{printer}`, and `{job}` argument placeholders.

Before setting `dryRun` to `false`, print synthetic documents with no customer data:

In the Automation tab, each printer card has a `Print test label` or `Print test sheet` button. A test uses the printer and page settings currently visible in the form, including unsaved changes, without saving them. Clicking either button submits a real print job containing synthetic data only; the output does not need to be enabled for automation first.

The same tests are available from the CLI:

```powershell
node --env-file=.env.local dist/cli.js print test --action print-address-label
node --env-file=.env.local dist/cli.js print test --action print-packing-slip
```

Only after both tests route correctly should you replace all `CHANGE_ME_*` values and set `dryRun` to `false`. See [docs/PRINTING.md](docs/PRINTING.md) for adapter details and failure behavior.

## Rules

Rules are versioned JSON and may invoke any number of configured actions. Supported fields are status, channel, fulfillment, shipping type, total amount, buyer-paid state, product count, and total item quantity. Supported operators are `eq`, `neq`, `in`, `gte`, and `lte` where type-compatible.

No arbitrary code is evaluated. See [docs/RULES.md](docs/RULES.md) for examples.

## Development

```powershell
npm run check
npm run audit
```

Tests use synthetic orders, documents, providers, stores, and printers. Ordinary tests never contact TCGplayer or a real printer.

## Current boundaries

This release is a single-seller, single-machine service with a CLI, a loopback-only configuration UI, Windows printer discovery, durable fulfillment state, preview-first exact-SKU inventory additions, preview-first smart repricing, and paced mutation queues. Email acceleration, remote administration, remote shipment mutations, bulk inventory ingestion, barcode scanning, unattended scheduled repricing, per-card pricing floors, and multi-user operation remain deliberate future extensions rather than hidden assumptions in the core workflow.
