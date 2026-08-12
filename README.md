# TCGPlayerAlert

A local-first, configurable seller automation service. It polls the authoritative TCGplayer ready-to-ship queue, reconciles orders against durable state, evaluates declarative rules, dispatches modular actions, and processes explicitly queued listing and pricing changes at a safe pace.

The first action modules draw an address label through the native Windows print system and render a packing-slip PDF inside the application before sending it to another OS-visible printer. Printer vendors and names are configuration, not application assumptions.

This project is not affiliated with, endorsed by, or supported by TCGplayer. It uses the separately maintained unofficial `tcgplayer-private-api` package and must only access an authorized seller account.

## Current safety defaults

- Every print action and mutation queue is disabled in the committed example. Enable only the individual capabilities you have configured and tested.
- The first successful sync establishes a baseline without processing existing orders.
- Tracking remains manual. Scan-triggered shipment mutation is separately disabled by default and requires both shipment scanning and automatic exact matches to be explicitly enabled.
- Price changes are opt-in jobs in a separate durable queue. Only one is submitted at a time, with a configurable delay, and the queue has its own enable switch.
- Card additions require an exact product-condition SKU and a merchandise profile. Existing eligible listings can be removed only after an inline confirmation. Both use the durable inventory queue and its independent enable switch.
- Internal schedules can release exact Add Cards selections later or build a fresh inventory repricing run. Repricing defaults to review-only; guarded automatic mutation must be enabled per schedule.
- Addresses and document bytes remain in memory and temporary print files only; they are not stored in workflow state or logs.
- Interrupted or ambiguous print submissions become `review-required` and are never retried automatically.
- Discord notifications are disabled by default. When enabled, message alerts omit subjects and bodies, and the webhook URL stays in Windows protected storage or the environment.

## Install on Windows

End users can install the generated per-user Windows package and launch
**TCGPlayerAlert** from the Start menu; they do not need Node.js, npm, Git, or a
terminal. The shortcut runs the service in the background and opens the local
operator console. Configuration and durable state live under
`%LOCALAPPDATA%\TCGPlayerAlert` and survive application upgrades.

Each launch checks the latest stable GitHub Release with a five-second timeout.
Only a newer, exactly named installer with GitHub's matching SHA-256 asset
digest is accepted. An offline, malformed, or unverifiable update is skipped
and the installed version starts normally. See the
[Windows installer guide](docs/WINDOWS_INSTALLER.md) for building, release
publication, local paths, and disabling update checks.

## Requirements

- Node.js 24 or newer for source development (the Windows installer includes its own runtime)
- An authorized TCGplayer seller account signed in through a supported browser
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

The tarball is intentionally ignored by Git. `package-lock.json` pins its integrity. The current application contract requires `tcgplayer-private-api` 0.17.0 from the commit recorded in [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md). After that package is published, replace the file dependency with the released semantic version.

## Configure

The repository uses ignored local files:

- `.env.local` as an optional migration fallback for
  `TCGPLAYER_AUTH_COOKIE` and `TCGPLAYER_SELLER_KEY`
- `config/local.json` for scheduling, rules, actions, and printers

Do not commit either file. The committed [.env.example](.env.example) and [local.example.json](config/local.example.json) contain no secrets or personal printer settings.

Create the local files on a new checkout:

```powershell
Copy-Item .env.example .env.local
Copy-Item config/local.example.json config/local.json
```

The current configuration schema is version 4. Existing version-one,
version-two, and version-three files are migrated safely in memory and are
rewritten as a complete version-four document the next time Settings is saved;
validation and startup never rewrite the file on their own. Discord
notifications remain disabled during migration.

The General settings independently control whether the master pull list groups
provider-identified lands as **Land** and cards with two or more colors as
**Multicolored**. Both settings default to enabled for existing installations,
and changing either one takes effect the next time the pull list loads.

The environment file may remain blank when using the browser connector.

### Browser-managed seller connection

Build the browser-specific connector packages:

```powershell
npm run build:extension
```

For Edge, Chrome, Brave, Vivaldi, and other Chromium-family browsers:

1. Open the browser's extensions page, such as `edge://extensions` or `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose this repository's `dist/browser-extension/chromium` directory.
4. Pin **TCGPlayerAlert Session Connector**.

For Firefox:

1. Use Firefox 140 or newer, then open a normal window in the profile where you use the TCGplayer
   Seller Portal. Do not use a private window for the connector.
2. Enter `about:debugging#/runtime/this-firefox` in Firefox's address bar.
3. Select **Load Temporary Add-on**.
4. In the file picker, select this exact built file:
   `dist/browser-extension/firefox/manifest.json`. Select the file itself, not
   the `firefox` directory.
5. Confirm that **TCGPlayerAlert Session Connector** appears under **Temporary
   Extensions**.
6. Select Firefox's Extensions button (the puzzle-piece icon), open the gear
   menu beside **TCGPlayerAlert Session Connector**, and select **Pin to
   Toolbar**.

The absolute Firefox manifest path in a default checkout is
`C:\Users\cwmle\Documents\TCGPlayerAlert\TCGPlayerAlert\dist\browser-extension\firefox\manifest.json`.
Firefox removes temporary development add-ons when it restarts, so repeat these
installation steps after every Firefox restart until the Firefox build is
signed through Mozilla. That affects installation persistence only; the saved
application connection survives restarts.

The Firefox manifest requires version 140 or newer so Mozilla's built-in
installation prompt can disclose the required authentication-information
transfer. The connector's exact data handling is documented in its public
[privacy policy](browser-extension/PRIVACY.md). Store-ready ZIP files, listing
assets, privacy answers, permission justifications, and reviewer notes are
produced and documented by `npm run package:extension`; see the
[submission guide](browser-extension/SUBMISSION.md).

Build once, then launch the application:

```powershell
npm run build
npm run start
```

Open the printed `http://127.0.0.1:47831` address. In the TCGplayer connection
panel:

1. Select **Connect** to generate a ten-minute pairing code.
2. Open `https://store.tcgplayer.com/admin` in the browser profile containing
   the connector and sign in normally. Complete MFA or CAPTCHA yourself.
3. Open the pinned connector, enter the displayed code and local port, and
   select **Connect browser**.
4. Wait for the application status to change to **connected**.

The validated seller session is encrypted with Windows DPAPI for the current
Windows account and stored in the ignored `.data` directory. The cookie and
seller key are never returned to the web UI or written to configuration or
logs. The extension stores only its random connector token. It sends a current
cookie when TCGplayer changes that exact cookie and checks every five minutes
while the browser is running, without contacting TCGplayer itself.

When TCGplayer rejects a session, the application marks it expired, pauses
scheduled synchronization, and leaves queued mutations pending. If the browser
still has a renewed session, the connector replaces it automatically. If
TCGplayer logged the browser out, sign in normally and select **Refresh
session** in the connector. Use **Disconnect** in Settings to clear the
application credential and invalidate the connector token.

The authenticated status in the lower-left sidebar includes **Log out**, which
performs the same protected disconnect without signing out of the Seller Portal
browser. While disconnected, the console does not poll seller-data endpoints or
mount seller-data workspaces. It reads connection status once at startup and on
window focus or a reported authentication failure; the two-second local status
check runs only while an explicit pairing code is active and stops when that
code connects or expires.

`npm run configure` remains available when only the console is needed without
the scheduled poller or queue workers.

### Discord notifications

Open **Settings → Notifications**, paste a webhook for a private Discord
channel, select **Save webhook**, and send the synthetic test. On Windows the
URL is encrypted for the current account with DPAPI and is never returned to
the browser after it is saved. `DISCORD_WEBHOOK_URL` is available as an
environment-only fallback.

After the test succeeds, enable the master switch and choose the desired event
types. The long-running `npm start` process can report seller-session expiry,
new unread message activity, a confirmed TCGplayer cancellation of a previously
ready order, and every app-initiated mark-shipped outcome. The first enabled
observation establishes a baseline rather than replaying existing unread
messages or old order changes. Message alerts contain only the unread count and
a Seller Portal link; subjects and bodies stay local.

The cancellation observer reuses the scheduled ready-order snapshot and makes
one exact confirmation request only when an order disappears from that queue.
The message observer runs at the existing order polling cadence. No notification
polling occurs while the master switch is disabled, and opening the web console
does not trigger notification checks.

For UI development without seller credentials, live API calls, or printer output, run `npm run preview:web`. It starts the same compiled console on `http://127.0.0.1:47839` with sanitized in-memory orders, order details, payments, feedback, messages, catalog results, inventory, and jobs.

The interface uses a persistent, keyboard-accessible left navigation rail for Dashboard, Add cards, Orders, Scanner, Messages, Payments, Feedback, Inventory, Settings, and Jobs. Dashboard shows ready-to-ship orders, product/shipping/order totals calculated from those summaries, and compact address-label and packing-slip switches that mirror the full controls in Settings. Its order rows show the buyer, order number, date, shipping type, amount breakdown, and grouped fulfillment actions without loading per-order details. Scheduled polling and Dashboard **Sync now** use the same synchronization coordinator and authoritative ready-order snapshot, so Dashboard reads do not issue a duplicate ready-order search or bypass fulfillment reconciliation. An open Dashboard periodically rereads that local memory snapshot so a completed scheduled sync becomes visible without contacting TCGplayer again. The Orders page remains a separate last-three-months view and never supplies the Dashboard queue. Clicking an order number opens the internal order workspace with the seller-confirmed address, products, totals, tracking, and the existing explicit print and shipment controls. The Orders page also exposes one printable **Master pull list** for the complete authoritative ready-to-ship queue. It combines repeated exact SKUs into total quantities and shows product line, set, collector number, condition, rarity, and optional provider-supplied color metadata. A cold load performs the ready-order search, exports up to 500 orders per pull-sheet request, and batches color enrichment by up to 24 exact product IDs per public marketplace request; it does not confirm every order separately. The assembled list is cached in memory for 30 seconds, and metadata failure leaves the operational list usable with a visible warning. Pull checkboxes persist minimal per-order/SKU quantity progress without changing TCGplayer's order status. Pulled rows are excluded from the working and printed lists by default; **Show pulled** reveals them prechecked, and a later order for the same SKU contributes only its new quantity. Browser printing uses the operating system's normal print dialog and a dedicated ink-conscious layout. When TCGplayer advertises an exact `FullRefund` or `PartialRefund` action, the order workspace offers the corresponding refund flow. A refund always requires a separate **Review refund** step followed by an explicit danger-styled confirmation; the Mark shipped confirmation setting cannot disable it. Partial refunds are bounded by the currently refundable product and shipping amounts after prior refunds. Refund options are cached for five minutes, but the package reconfirms the order and its current capability before mutation. Refund requests are never automatically retried; an uncertain outcome locks the panel until the operator refreshes and reconciles the order in TCGplayer. Refund messages, details, and addresses are never persisted or logged. A cold detail read performs exact seller confirmation and is cached in server memory for 30 seconds; **Refresh** bypasses that cache, and mutations invalidate it. **Open in TCGplayer** remains available from that workspace for capabilities the application does not own. Settings keeps the Mark shipped confirmation enabled by default and allows an operator to turn it off for both Dashboard and Orders. Order labels are displayed exactly as returned by TCGplayer. Shipment controls use the private API package's normalized `SellerOrderStatus` enum, which has an explicit `Unknown` value for unrecognized labels; the application does not interpret display text or create lifecycle labels. After a successful shipment mutation, the shared ready-order snapshot removes the accepted order immediately and the active view reconciles through its appropriate source. Order summaries, details, and pull-sheet product/customer content remain in memory to avoid repeated Seller Portal requests and are not written to application state or logs; only the minimal order number, SKU, pulled quantity, and timestamp are persisted for pull progress.

Payments is strictly read-only and detects the payment experience assigned to the authenticated seller. Legacy sellers see TCGplayer's estimated future payments and paginated past-payment history with the displayed sales, fees, refunds, adjustments, and payment totals. A real upcoming row that TCGplayer has not scheduled yet remains visible with `Not scheduled` dates and is excluded from the next-scheduled-date selection. Sellers on the newer Money Movement experience see previous-payout, next-payout, and unpaid-balance summaries; selecting the unpaid balance opens searchable upcoming transactions, while selecting a payout opens its completed transaction details. Payment capability, pages, and upcoming balances are cached for one minute; Money Movement payout details are cached for five minutes. Refresh bypasses the relevant cache. The application neither stores payment data nor requests or displays payment instruments, masked bank details, payment setup, payout approval/rejection/retry, or any other payment mutation. The Seller Portal link follows the account's actual payment experience.

Feedback is also strictly read-only. It shows the current storefront's one-to-five-star ratings, buyer comments, and delivery, item-description, and communication signals. Operators can filter by star rating, comments, and 30-, 90-, or 365-day windows. Feedback pages and aggregate totals are cached in memory for one minute; Refresh bypasses the cache. Provider user keys and order identifiers never enter the browser contract, buyer nicknames are masked server-side, and feedback is not persisted or logged.

Messages shows the authenticated seller's paginated inbox and conversation content, supports exact order-number filtering, and can include deleted threads on request. A red navigation badge shows the unread-message count and refreshes through the dedicated count read once per minute; inbox, count, and thread reads are cached in memory for 30 seconds. Successfully opening an unread conversation marks that thread read and immediately updates its indicator and the shared badge; the per-thread control remains available if that automatic update fails. **Mark all read** scans the active inbox in 100-thread pages and marks only unread conversations sequentially, stopping on the first failure rather than issuing a burst of mutations. The inline composer sends one reply through `tcgplayer-private-api` 0.14.0. Replies are never retried automatically. If delivery becomes uncertain, the composer remains blocked with the draft intact until the operator refreshes the conversation. Deletion, mark-unread, escalation, resolution, and new-conversation creation remain in Seller Portal. Message content and reply drafts are never persisted or logged.

Polling, printer details, merchandise and pricing profiles, and background-worker configuration remain in Settings. Dashboard switches use the same save banner and do not replace those full controls. Manual order printing, tracking, and shipment changes remain explicit button actions. The UI discovers installed Windows printers and provides independent on/off controls for address labels and packing slips, along with label-size, font, PDF scaling, DPI, and queue settings. Add Cards uses a compact merchandise-profile selector above the catalog search. Each merchandise profile stores language, Seller Portal shipping rate, default condition and printing, and a reference to a shared pricing profile. Each result shows its regular and English Near Mint Foil market prices, a condition selector, a Foil toggle, and `+1`, `+2`, `+3`, `+4`, and `+X` quantity controls. Visible results lazily resolve authoritative SKU details with at most two detail requests in flight: normal-only products disable Foil off, foil-only products force and disable Foil on, and products with both printings remain selectable. A completed detail request replaces only its affected card instead of rebuilding every loaded search result. The add action resolves the same cached details before choosing a SKU, so a fast quantity click follows the forced printing as well. In **Now** mode, a quantity click immediately prices and queues the exact SKU using those merchandise defaults and the referenced smart pricing policy. In **Scheduled** mode, it durably records that exact SKU, quantity, merchandise profile, and release time without calculating or freezing a price. For a detected isolated low, a pricing profile's `Skip card` action still protects an existing Inventory price, but Add Cards uses the supported seller band because a new listing has no price to preserve. If the selected condition and printing have no SKU in the profile language but exactly one other language is available, Add Cards places confirmation controls in that card's result message before queuing the actual alternate-language SKU. Multiple alternate languages remain an explicit profile-choice error rather than being guessed. Product details remain lazy-loaded and are cached after their first use. Catalog search is ranked by name likeness and includes product images. Inventory search filters existing table rows without more API calls or rebuilding the full table, its view switch can show only listings with a calculated price change, including changes held for review, and eligible listings have an inline remove-all confirmation. While a preview is loading, its single response streams concrete progress from the existing work: validated seller-inventory products, marketplace comparison batches, exact-SKU market-price batches, exact product checks when required, and finalized listings. Progress reporting does not add TCGplayer requests. Jobs has separate Schedules, Runs, Inventory queue, and Price queue views. Queue histories retain their independent ten-row pagination. A definitively failed mutation job may be retried as a new auditable attempt; review-required jobs cannot be retried because their remote outcome may be ambiguous. The UI listens only on this computer and never receives or displays the seller credentials from `.env.local`.

The Inventory table groups current, market, and proposed prices together and shows the signed dollar and percentage change. The Change column sorts by percentage in either direction; increases and decreases use distinct colors, and absolute changes over 10% receive a stronger row highlight.

The Dashboard can also print a pasted multiline address through the saved address-label printer and layout. This explicit manual action works independently of the automation enable switch and does not add the pasted address to durable application state or logs.

Scanner is the opt-in production AprilTag workflow. When shipment scanning is enabled, configured order-address labels receive a stable 14 mm `tag36h11` marker derived from a versioned hash of the order number; the marker contains no order or customer data. A separately enabled background-camera adapter belongs to the long-running app process, so closing the operator console does not stop capture or detection. Select the camera under **Settings → Scanning** and keep `npm start` running. The Scanner page shows a once-per-second grayscale preview copied from that backend stream; it never opens the camera itself. The preview is downsampled, served only through the no-cache loopback UI, overwritten in memory, and never saved or logged. After five matching camera reads, the server performs one fresh authoritative ready-to-ship search and requires exactly one matching order. Review mode pauses for an explicit shipment action; automatic mode marks the exact match shipped immediately without an open page. Zero matches, tag collisions, repeated successful scans, interrupted mutations, and uncertain seller responses never guess or retry. Mutation intent and outcomes are kept in `.data/shipment-scans.json` without buyer or address data. Scanner status, camera discovery, preview reads, and ordinary frames do not issue seller requests. Optional host-system success and failure sounds supplement the visual result.

`Open in Pirate Ship` on an Orders row reserves a new browser tab, confirms the order belongs to the configured seller, briefly caches its address in memory, copies a multiline address to the clipboard, and navigates only that new tab to Pirate Ship's Single Label page. Press `Ctrl+V` there to activate Pirate Ship's Paste Address field. If browser clipboard access is unavailable, the application shows the address in a manual-copy prompt instead. If pop-ups are blocked, the local app stays open and asks the operator to allow them; it never replaces the local tab with Pirate Ship. The address is never added to the Pirate Ship URL, application state, or logs.

All third-party destinations, including TCGplayer Seller Portal links, open in
a new tab. Navigation within the local operator app stays in the current tab.

Validate non-secret configuration without contacting TCGplayer or printing:

```powershell
npm run build
npm run config:validate
```

Dashboard snapshot requests are strictly read-only. Opening the Dashboard and its five-second local refresh never starts reconciliation, seller discovery, printing, or another configured fulfillment action. Before scheduled polling has produced a snapshot, the page says so explicitly. **Sync now** is a separately guarded mutation and is the only Dashboard control that invokes the fulfillment workflow.

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

The scheduler, Dashboard **Sync now**, and separately invoked command-line syncs use the same workflow. In-process requests are coalesced, and the filesystem lease prevents separate processes from reconciling or dispatching actions concurrently.

All seller-backed features in one running process share one private-API client. Its request starts retain the package's 250 ms spacing, and a FIFO governor permits at most two network attempts in flight across the entire application. Aggregate pressure can be inspected locally without exposing request targets or seller/customer data (replace the port when `--port` is used):

```powershell
Invoke-RestMethod http://127.0.0.1:47831/api/provider/requests
```

## Add cards to inventory

Open the settings screen and use **Add cards**:

1. In **Settings**, create reusable pricing profiles, then create one or more merchandise profiles. A merchandise profile stores language, Seller Portal shipping rate, default condition, default printing, and the pricing profile it uses. Multiple merchandise profiles may share one pricing profile. Referenced pricing profiles cannot be removed.
2. In **Add cards**, select the profile for this batch, then search by card name or enter a bare TCGplayer product number for a direct exact-product lookup. Name searches retrieve one page of up to 24 products and return matching product-line and set choices in the same request. Choose a product line to refresh its available sets, then optionally choose a set to narrow large families such as basic lands without paging through the entire fuzzy result set; each selection makes one bounded search. `Load more` requests exactly one additional page. A normalized likeness score keeps exact names, artwork/name variants, partial names, and typo-tolerant fuzzy matches ordered across loaded pages. Identical search batches and product details are cached briefly, and replaced searches are canceled.
3. On the exact set row, select condition, toggle **Foil** when needed, and choose `+1`, `+2`, `+3`, or `+4`. Use `+X` for any other quantity. Regular and English Near Mint Foil market prices appear beside the set metadata; a dash means no matching live Foil SKU was available for price enrichment.
4. Choose **Now** to price and queue the exact SKU immediately. Choose **Scheduled** and a future local release time to retain the exact selection for later. At release, the service reloads the merchandise profile and its pricing profile, gets a fresh authoritative preview, and only then hands a queueable mutation to the existing inventory queue. The row reports the queued or scheduled result. Product details and comparison data are cached in memory, while the worker still rechecks live inventory before submission. For a marketplace item under $5, delivered-price comparison raises a displayed shipping rate below TCGplayer's current $1.49 minimum to $1.49 but never lowers a seller's higher returned rate. The interface still shows the shipping amount TCGplayer returned and identifies a minimum-rate adjustment when one was needed.

The long-running service processes the queue; `npm run configure` only hosts the settings UI. Start `npm start` when queued jobs should be submitted. A disabled inventory queue keeps them pending.

## Schedule internal jobs

Use **Jobs → Schedules** to create once, interval, daily, or weekly inventory repricing schedules. Daily and weekly schedules retain an IANA timezone and handle daylight-saving changes as wall-clock schedules. Missed recurring slots coalesce into one run instead of replaying a burst. **Run now** creates an auditable run from the current schedule definition.

Review-only repricing is the default. It loads current inventory and marketplace evidence at execution, retains the proposal as run history, and does not enqueue price mutations. Open the result in Inventory to perform the normal operator-reviewed flow. Automatic repricing must be selected explicitly and has independent caps for update count, percentage and dollar decreases, percentage increases, and the proportion of rows blocked by safety checks. Any breached row stays out of the mutation queue; a breached batch-wide cap stops the safe remainder for review as well.

The scheduler stores only schedule intent, exact listing identifiers, quantities, and bounded run reports in the file beside the configured workflow state (`<stateFile>.internal-jobs.json`). It does not store marketplace response bodies or credentials. Runs execute one at a time and pause while authoritative order synchronization is active. Their final handoff to the existing price or inventory queue carries a stable source-run id, so recovery after a process interruption cannot create a second mutation batch. `npm run configure` may edit schedules but does not execute them; keep `npm start` running for due jobs.

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

Ranges are chosen by the lowest qualifying listing, falling back to market price only when no comparable exists. Market values come from the exact ProductConditionId SKU, so condition, printing, and language cannot silently borrow a product-level or nonfoil price. Comparable searches merge ordinary marketplace channel-0 listings with verified channel-1 Direct offers, then apply exact product, printing, language, and condition rules. A channel-1 record is eligible only when TCGplayer simultaneously reports a Direct listing, Direct-capable product, Direct seller, positive Authentication Center inventory, the `standard` listing type, and the `DirectViewable` seller program. Missing evidence fails closed. Seller-band analysis first keeps only each seller's cheapest eligible listing across both channels, so one seller cannot create artificial support with several listings. Starting at the absolute low, it finds the cheapest price whose configured percentage window contains the required number of distinct sellers. The isolated-low gap compares the absolute low with that supported band's starting price. A low already supported by enough sellers remains the reference; an unsupported low can be ignored only when a supported band exists above it. A profile independently chooses whether an entirely unsupported seller ladder waits for review or invokes its sparse-market fallback. Minimum-comparable and missing-source cases continue to use that fallback. If the selected fallback has neither source, the item remains unqueued with a warning rather than a listing failure.

Marketplace inventory, exact-SKU market prices, and comparison data are cached in memory for ten minutes. Exact market prices are read in sequential batches of up to 24 unique SKUs; repeated previews and seller-inventory invalidation reuse those price points until expiry. Each snapshot groups listings by printing, language, and the profile's exact allowed-condition range, then searches ordinary marketplace and Direct channels separately with explicit U.S. buyer context. Product IDs remain batched in groups of 24 for the normal fast path. When a delivered-price decision would depend on a returned shipping rate above $1.49, the repricer treats the embedded spotlight sample as suspicious and requests one exact, price-plus-shipping-sorted page of up to 50 listings for only that product. It does not paginate further. The exact result replaces the spotlight sample for that comparison key and is cached with the snapshot; a failed exact check makes the row non-queueable. For sub-$5 marketplace listings, returned shipping below $1.49 is raised to the minimum while higher seller-defined shipping remains unchanged. Verified Direct listings retain their returned shipping. **Force marketplace refresh** deliberately reloads the inventory and comparison snapshot; unexpired exact-SKU prices remain reusable. Simultaneous preview requests share in-flight loads, and the interface shows when the snapshot was captured. The cache is process-local, expires automatically, and contains no credentials.

Each refreshed preview also shows **Listed inventory value**, calculated from the current item price times quantity for every live marketplace listing in the preview. Shipping is excluded from this inventory-value total.

The editable **Smart conservative** starter profile uses delivered price, 100% pricing, a 5% seller-band width in every tier, and exact-SKU market prices. It waits for review when no seller band has the required support. Its separate sparse-market fallback remains the higher of exact-SKU market or the lowest qualifying listing for other missing-evidence cases. It also blocks an automatic decrease for review when the change exceeds both 25% and $0.50; both thresholds and the guard itself are editable:

- Up to $1: require two distinct sellers in a 5% band. A profile can explicitly lower this to one seller for sparse low-value inventory.
- $1.01-$5: require two distinct sellers in a 5% band; use that band when a singleton low is at least 3% below it.
- $5.01-$25: require two distinct sellers in a 5% band; use that band at a 3% isolated-low gap.
- $25.01-$100: require three total comparables and two sellers in a 5% band; skip for review at a 3% isolated-low gap.
- Above $100: use the same three-comparable, two-seller evidence floor and skip isolated lows at 3%.

This is a conservative starting policy, not a claim that the thresholds maximize profit. TCGplayer confirms that customer visibility is ordered by item price plus shipping and describes Market Price as an average of recent condition-specific sales. The default therefore uses exact-SKU market values and printing-, language-, and condition-filtered live comparables, treats agreement between independent sellers as stronger evidence than one listing, and holds unsupported seller ladders or unusually large decreases for operator review. Calibrate the editable tiers and decrease thresholds against your own sell-through time, margin, and repricing history.

The editable **Sell now** starter profile uses delivered price, allows increases, disables the automatic-decrease review guard, ignores gaps, prefers the lowest exact qualifying listing, undercuts it by one cent, and uses exact-SKU market price only when no qualifying listing exists. Both starter profiles may be renamed, changed, duplicated, or deleted. A one-time configuration marker prevents Sell now from being recreated after deletion.

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
npx playwright install chromium
npm run test:browser
```

Tests use synthetic orders, documents, providers, stores, and printers. Ordinary tests never contact TCGplayer or a real printer.
The browser regression starts a separate synthetic preview server, initializes
the manual-upload AprilTag WebAssembly worker, uploads a generated synthetic tag
to the production Scanner workspace, and resolves a synthetic ready order. Separate server tests run the same generated tag through the background Node detector and exercise the service-owned camera loop with injected frames. They do not request camera
permission, contact TCGplayer, mutate an order, or use the normal application
process.

## Current boundaries

This release is a single-seller, single-machine service with a CLI, a loopback-only configuration UI, Windows printer discovery, durable fulfillment state, profile-driven immediate and scheduled exact-SKU inventory additions, searchable inventory with operator-confirmed exact-SKU removal, profile-driven preview-first smart repricing, guarded internal repricing schedules, optional Magic rarity floors, paced mutation queues, and an opt-in service-owned production shipment scanner with durable duplicate protection. The app must remain running for scheduled jobs and background camera work; installing it as an operating-system service or login task is a separate deployment concern. Email acceleration, remote administration, bulk inventory ingestion, per-card pricing floors, and multi-user operation remain deliberate future extensions rather than hidden assumptions in the core workflow.
