# TCGPlayerAlert

A local-first, configurable seller automation service. It polls the authoritative TCGplayer ready-to-ship queue, reconciles orders against durable state, evaluates declarative rules, dispatches modular actions, and processes explicitly queued listing and pricing changes at a safe pace.

The first action modules draw an address label through the native Windows print system and render a packing-slip PDF inside the application before sending it to another OS-visible printer. Printer vendors and names are configuration, not application assumptions.

This project is not affiliated with, endorsed by, or supported by TCGplayer. It uses the separately maintained unofficial `tcgplayer-private-api` package and must only access an authorized seller account.

## Current safety defaults

- Every print action and mutation queue is disabled in the committed example. Enable only the individual capabilities you have configured and tested.
- The first successful sync establishes a baseline without processing existing orders.
- No tracking or shipment mutation is part of the automatic workflow.
- Price changes are opt-in jobs in a separate durable queue. Only one is submitted at a time, with a configurable delay, and the queue has its own enable switch.
- Card additions require an exact product-condition SKU and a merchandise profile. Existing eligible listings can be removed only after an inline confirmation. Both use the durable inventory queue and its independent enable switch.
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

The tarball is intentionally ignored by Git. `package-lock.json` pins its integrity. The current application contract requires `tcgplayer-private-api` 0.5.4 from the commit recorded in [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md). After that package is published, replace the file dependency with the released semantic version.

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

For UI development without seller credentials, live API calls, or printer output, run `npm run preview:web`. It starts the same compiled console on `http://127.0.0.1:47839` with sanitized in-memory orders, catalog results, inventory, and jobs.

Open the printed `http://127.0.0.1:47831` address. The interface uses a persistent, keyboard-accessible left navigation rail for Dashboard, Orders, Add cards, Inventory, Settings, and Jobs. Dashboard shows ready-to-ship orders, product/shipping/order totals calculated from those summaries, and compact address-label and packing-slip switches that mirror the full controls in Settings. Its order rows show the buyer, order number, date, shipping type, amount breakdown, and grouped fulfillment actions without loading per-order details. If the Orders list is already loaded, Dashboard derives its ready-to-ship view from that in-memory data instead of making another request; repeated page visits also reuse the loaded view until Refresh is selected. The Orders page shows the last three months of orders and provides explicit controls to print or download fulfillment documents, add tracking, mark an order shipped, or open it in the TCGplayer Seller Portal. Order labels are displayed exactly as returned by TCGplayer. Shipment controls use the private API package's normalized `SellerOrderStatus` enum, which has an explicit `Unknown` value for unrecognized labels; the application does not interpret display text or create lifecycle labels. After a successful shipment mutation, both browser order caches are invalidated and the active view is reloaded from TCGplayer. Order data remains in memory and is briefly cached to avoid repeated Seller Portal requests; it is not written to application state or logs.

Polling, printer details, merchandise and pricing profiles, and background-worker configuration remain in Settings. Dashboard switches use the same save banner and do not replace those full controls. Manual order printing, tracking, and shipment changes remain explicit button actions. The UI discovers installed Windows printers and provides independent on/off controls for address labels and packing slips, along with label-size, font, PDF scaling, DPI, and queue settings. Add Cards uses a compact merchandise-profile selector above the catalog search. Each merchandise profile stores language, Seller Portal shipping rate, default condition and printing, and a reference to a shared pricing profile. Each result shows its regular and English Near Mint Foil market prices, a condition selector, a Foil toggle, and `+1`, `+2`, `+3`, `+4`, and `+X` quantity controls. Visible results lazily resolve authoritative SKU details with at most two detail requests in flight: normal-only products disable Foil off, foil-only products force and disable Foil on, and products with both printings remain selectable. A completed detail request replaces only its affected card instead of rebuilding every loaded search result. The add action resolves the same cached details before choosing a SKU, so a fast quantity click follows the forced printing as well. A quantity click immediately prices and queues the exact SKU using those merchandise defaults and the referenced smart pricing policy, then reports success or failure on the row. For a detected isolated low, a pricing profile's `Skip card` action still protects an existing Inventory price, but Add Cards uses the supported seller band because a new listing has no price to preserve. If the selected condition and printing have no SKU in the profile language but exactly one other language is available, Add Cards places confirmation controls in that card's result message before queuing the actual alternate-language SKU. Multiple alternate languages remain an explicit profile-choice error rather than being guessed. Product details remain lazy-loaded and are cached after their first use. Catalog search is ranked by name likeness and includes product images. Inventory search filters existing table rows after a short typing debounce without more API calls or rebuilding the full table, and eligible listings have an inline remove-all confirmation. Jobs shows ten inventory changes and ten price updates per independently paginated page. A definitively failed job may be retried as a new auditable attempt; review-required jobs cannot be retried because their remote outcome may be ambiguous. The UI listens only on this computer and never receives or displays the seller credentials from `.env.local`.

`Open in Pirate Ship` on an Orders row confirms the order belongs to the configured seller, briefly caches its address in memory, copies a multiline address to the clipboard, and opens Pirate Ship's Single Label page. Press `Ctrl+V` there to activate Pirate Ship's Paste Address field. If browser clipboard access is unavailable, the application shows the address in a manual-copy prompt instead. The address is never added to the Pirate Ship URL, application state, or logs.

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

1. In **Settings**, create reusable pricing profiles, then create one or more merchandise profiles. A merchandise profile stores language, Seller Portal shipping rate, default condition, default printing, and the pricing profile it uses. Multiple merchandise profiles may share one pricing profile. Referenced pricing profiles cannot be removed.
2. In **Add cards**, select the profile for this batch, then search by card name or enter a bare TCGplayer product number for a direct exact-product lookup. Name searches retrieve one page of up to 24 products and return matching product-line and set choices in the same request. Choose a product line to refresh its available sets, then optionally choose a set to narrow large families such as basic lands without paging through the entire fuzzy result set; each selection makes one bounded search. `Load more` requests exactly one additional page. A normalized likeness score keeps exact names, artwork/name variants, partial names, and typo-tolerant fuzzy matches ordered across loaded pages. Identical search batches and product details are cached briefly, and replaced searches are canceled.
3. On the exact set row, select condition, toggle **Foil** when needed, and choose `+1`, `+2`, `+3`, or `+4`. Use `+X` for any other quantity. Regular and English Near Mint Foil market prices appear beside the set metadata; a dash means no matching live Foil SKU was available for price enrichment.
4. The quantity action immediately selects the exact condition, printing, and profile-language SKU, calculates its price from the selected profile, and adds a durable queue job. The row reports the queued price or a specific validation error. Product details and comparison data are cached in memory, while the worker still rechecks live inventory before submission. For a marketplace item under $5, delivered-price comparison raises a displayed shipping rate below TCGplayer's current $1.49 minimum to $1.49 but never lowers a seller's higher returned rate. The interface still shows the shipping amount TCGplayer returned and identifies a minimum-rate adjustment when one was needed.

The long-running service processes the queue; `npm run configure` only hosts the settings UI. Start `npm start` when queued jobs should be submitted. A disabled inventory queue keeps them pending.

Pending additions for the same SKU are combined. Before every request, the worker re-reads the seller's current quantity and secondary-channel inventory. It submits both the relative addition and the resulting absolute quantity. A changed quantity, custom listing, or secondary-channel listing becomes `review-required` instead of risking an incorrect update. Accepted requests are labeled `submitted` because Seller Portal may finish processing asynchronously.

Inspect or cancel jobs from either the UI or CLI:

```powershell
node dist/cli.js inventory status
node dist/cli.js inventory cancel --job JOB_ID
```

## Reprice listed cards

Create pricing profiles in **Settings**, then use **Inventory**. Pricing profiles can also enable game-specific modules. The first module adds Magic rarity minimums without making more marketplace requests, and the same policy applies when a merchandise profile adds a card.

1. Set the profile floor, item or delivered-price basis, condition matching, cent adjustment, whether increases are allowed, and the fallback used when the configured comparable or seller-support evidence is unavailable.
2. Optionally enable **Magic rarity minimums**, enter additional floors for the common rarity names, and use **Add rarity** for any other rarity returned by TCGplayer. Blank or unmatched rarities use the general floor; configured rarity floors may raise but never lower it.
3. Add ordered value ranges. For each range, choose the minimum number of qualifying comparable listings, lowest listing or market price, and the percentage to use.
4. Choose **Seller price bands** to count distinct sellers rather than raw listings. Set how many sellers must support a band, the percentage width of that band, and the isolated-low gap that triggers **Use supported band** or **Skip card**. **Ignore gap** disables gap handling. **First vs second (legacy)** remains available for older policies.
5. Select the profile in **Inventory**, click **Update preview**, review the market, absolute low, seller support, supported band, proposed price, and explanation, then queue selected rows.

The Inventory search box filters the already-loaded preview by card, set, product line, condition, printing, language, TCGplayer product number, or SKU number. Filtering is entirely browser-local and does not make more TCGplayer requests. An eligible row can also be removed in full with **Remove** and its inline confirmation. Removal creates a durable inventory job; it does not mutate inventory directly from the browser.

Ranges are chosen by the lowest qualifying listing, falling back to market price only when no comparable exists. This prevents a product-level market figure from placing a particular condition or printing in the wrong risk tier. Comparable searches merge ordinary marketplace channel-0 listings with verified channel-1 Direct offers, then apply exact product, printing, language, and condition rules. A channel-1 record is eligible only when TCGplayer simultaneously reports a Direct listing, Direct-capable product, Direct seller, positive Authentication Center inventory, the `standard` listing type, and the `DirectViewable` seller program. Missing evidence fails closed. Seller-band analysis first keeps only each seller's cheapest eligible listing across both channels, so one seller cannot create artificial support with several listings. Starting at the absolute low, it finds the cheapest price whose configured percentage window contains the required number of distinct sellers. The isolated-low gap compares the absolute low with that supported band's starting price. A low already supported by enough sellers remains the reference; an unsupported low can be ignored only when a supported band exists above it. When minimum comparables, seller-band support, or the selected price source is unavailable, the profile may wait, use the higher of market and lowest, prefer market then lowest, or prefer lowest then market. If the selected fallback has neither source, the item remains unqueued with a warning rather than a listing failure. These calculations reuse the preview's marketplace response and do not make a request per card.

Marketplace inventory and comparison data are cached in memory for ten minutes. Each snapshot groups listings by printing, language, and the profile's exact allowed-condition range, then searches ordinary marketplace and Direct channels separately with explicit U.S. buyer context. Product IDs remain batched in groups of 24 for the normal fast path. When a delivered-price decision would depend on a returned shipping rate above $1.49, the repricer treats the embedded spotlight sample as suspicious and requests one exact, price-plus-shipping-sorted page of up to 50 listings for only that product. It does not paginate further. The exact result replaces the spotlight sample for that comparison key and is cached with the snapshot; a failed exact check makes the row non-queueable. For sub-$5 marketplace listings, returned shipping below $1.49 is raised to the minimum while higher seller-defined shipping remains unchanged. Verified Direct listings retain their returned shipping. **Force marketplace refresh** deliberately reloads the snapshot. Simultaneous preview requests share in-flight loads, and the interface shows when the snapshot was captured. The cache is process-local, expires automatically, and contains no credentials.

Each refreshed preview also shows **Listed inventory value**, calculated from the current item price times quantity for every live marketplace listing in the preview. Shipping is excluded from this inventory-value total.

The editable **Smart conservative** starter profile uses delivered price, 100% pricing, a 5% seller-band width in every tier, and the higher of market price or the lowest exact qualifying listing when its normal evidence requirement cannot be met:

- Up to $1: require two distinct sellers in a 5% band. A profile can explicitly lower this to one seller for sparse low-value inventory.
- $1.01-$5: require two distinct sellers in a 5% band; use that band when a singleton low is at least 3% below it.
- $5.01-$25: require two distinct sellers in a 5% band; use that band at a 3% isolated-low gap.
- $25.01-$100: require three total comparables and two sellers in a 5% band; skip for review at a 3% isolated-low gap.
- Above $100: use the same three-comparable, two-seller evidence floor and skip isolated lows at 3%.

This is a conservative starting policy, not a claim that the thresholds maximize profit. TCGplayer confirms that customer visibility is ordered by item price plus shipping and describes Market Price as an average of recent condition-specific sales. The default therefore uses printing-, language-, and condition-filtered live comparables, treats agreement between independent sellers as stronger evidence than one listing, and holds high-value isolated lows for operator review. Calibrate the editable tiers against your own sell-through time, margin, and repricing history.

The editable **Sell now** starter profile uses delivered price, allows increases, ignores gaps, prefers the lowest exact qualifying listing, undercuts it by one cent, and uses market price only when no qualifying listing exists. Both starter profiles may be renamed, changed, duplicated, or deleted. A one-time configuration marker prevents Sell now from being recreated after deletion.

The default same-or-better rule treats conditions as `Near Mint > Lightly Played > Moderately Played > Heavily Played > Damaged`. For example, a Moderately Played card at $3 can match a qualifying Lightly Played listing at $2. Printing and language must also match. Price increases are off by default, the undercut is zero cents by default, and the configured minimum is a hard floor.

Custom listings and SKUs with secondary-channel inventory are shown but skipped because their inventory state cannot be preserved safely. Their automatic removal control is unavailable for the same reason. Immediately before each price, addition, or removal mutation, the worker re-reads the live listing. A removal proceeds only when the exact live quantity still matches the preview; a changed quantity becomes `review-required`, while a listing already at zero is treated as safely complete. A removal supersedes any still-pending addition or removal for the same SKU.

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

Pending jobs for the same SKU/channel are superseded by the newest price. The service keeps one mutation request in flight, waits for TCGplayer to accept it, and then applies the configured cooldown before claiming the next job. The default cooldown is one second. An `applied` queue status means Seller Portal accepted the update; TCGplayer documents that site-visible prices may lag by up to five minutes, and configured rounding or Direct price floors can make the displayed price differ from the submitted price. A definite HTTP 429 is delayed for five minutes. Authentication and validation failures stop as failed, while a timeout, disconnect, or lost mutation response becomes `review-required` and is never resubmitted automatically.

One preview action can durably queue every selected listing in that server-held preview; there is no fixed listing-count cap. Queue creation is one atomic local operation, but submission remains deliberately sequential. A 200-listing batch therefore takes at least 199 seconds with the default one-second cooldown, plus the time required for each live-state check and accepted mutation. Progress is visible in **Jobs**.

## Enable printing safely

The example uses `windows-native-label` for address text and `windows-pdf` for packing slips. Neither needs a separately installed PDF viewer. Configure each exact Windows printer name; the label adapter also uses the action's configured dimensions, while the PDF adapter controls render DPI and scaling.

The optional `command` PDF adapter remains available for other systems and custom printer tools. It launches the configured executable directly with no shell and supports `{file}`, `{printer}`, and `{job}` argument placeholders.

Before enabling either automated print action, print synthetic documents with no customer data:

In the Settings tab, each printer card has a `Print test label` or `Print test sheet` button. A test uses the printer and page settings currently visible in the form, including unsaved changes, without saving them. Clicking either button submits a real print job containing synthetic data only; the output does not need to be enabled for automation first.

The same tests are available from the CLI:

```powershell
node --env-file=.env.local dist/cli.js print test --action print-address-label
node --env-file=.env.local dist/cli.js print test --action print-packing-slip
```

Replace all `CHANGE_ME_*` values before enabling an automated print action; configuration validation rejects an enabled action that still uses a placeholder printer. Enable only the outputs whose synthetic tests route correctly. See [docs/PRINTING.md](docs/PRINTING.md) for adapter details and failure behavior.

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

This release is a single-seller, single-machine service with a CLI, a loopback-only configuration UI, Windows printer discovery, durable fulfillment state, profile-driven one-click exact-SKU inventory additions, searchable inventory with operator-confirmed exact-SKU removal, profile-driven preview-first smart repricing, optional Magic rarity floors, and paced mutation queues. Email acceleration, remote administration, remote shipment mutations, bulk inventory ingestion, barcode scanning, unattended scheduled repricing, per-card pricing floors, and multi-user operation remain deliberate future extensions rather than hidden assumptions in the core workflow.
