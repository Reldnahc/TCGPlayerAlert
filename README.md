# TCGPlayerAlert

A local-first, configurable fulfillment automation service. It polls the authoritative TCGplayer ready-to-ship queue, reconciles orders against durable state, evaluates declarative rules, and dispatches modular actions.

The first action modules draw an address label through the native Windows print system and render a packing-slip PDF inside the application before sending it to another OS-visible printer. Printer vendors and names are configuration, not application assumptions.

This project is not affiliated with, endorsed by, or supported by TCGplayer. It uses the separately maintained unofficial `tcgplayer-private-api` package and must only access an authorized seller account.

## Current safety defaults

- `dryRun` is enabled in the committed example. The ignored local configuration may be deliberately switched to live printing after printer tests pass.
- The first successful sync establishes a baseline without processing existing orders.
- No tracking or shipment mutation is part of the automatic workflow.
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

The tarball is intentionally ignored by Git. `package-lock.json` pins its integrity. The current application contract requires `tcgplayer-private-api` 0.1.0 from the commit recorded in [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md). After that package is published, replace the file dependency with the released semantic version.

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

Open the printed `http://127.0.0.1:47831` address. The UI discovers installed Windows printers and provides independent on/off controls for address labels and packing slips, along with polling, dry-run, label-size, font, PDF scaling, and DPI settings. It listens only on this computer and never receives or displays the seller credentials from `.env.local`.

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

## Enable printing safely

The example uses `windows-native-label` for address text and `windows-pdf` for packing slips. Neither needs a separately installed PDF viewer. Configure each exact Windows printer name; the label adapter also uses the action's configured dimensions, while the PDF adapter controls render DPI and scaling.

The optional `command` PDF adapter remains available for other systems and custom printer tools. It launches the configured executable directly with no shell and supports `{file}`, `{printer}`, and `{job}` argument placeholders.

Before setting `dryRun` to `false`, print synthetic documents with no customer data:

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

This release is a single-seller, single-machine service with a CLI, a loopback-only configuration UI, Windows printer discovery, and versioned JSON persistence. Email acceleration, remote administration, remote shipment mutations, and multi-user operation remain deliberate future extensions rather than hidden assumptions in the core workflow.
