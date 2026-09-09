# Provider-neutral implementation self-reviews

This log records the required compliance review at the end of each work package
from [ADR 0032](../adr/0032-provider-neutral-marketplace-architecture.md).
Each review is based on the live diff and passing repository gates; later
packages must update earlier conclusions if they change the reviewed surface.

## Package 0 — Characterization and enforcement

Date: 2026-08-24

Result: compliant; no open findings.

| Requirement                             | Evidence                                                                                                                                       | Review conclusion                                                                                                |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Characterize TCGplayer-only behavior    | `marketplace-characterization.test.ts` serves the TCGplayer fixture through `/api/orders`                                                      | Current single-provider behavior is locked without changing production code.                                     |
| Characterize ManaPool-only behavior     | The same suite disconnects TCGplayer, verifies it is not called, and serves ManaPool                                                           | The spike's independent-provider behavior is locked.                                                             |
| Characterize simultaneous providers     | The same suite verifies deterministic newest-first aggregation                                                                                 | Current combined behavior is locked.                                                                             |
| Characterize partial failure            | The same suite makes TCGplayer fail and verifies ManaPool data still returns with HTTP 200                                                     | The spike's current partial-failure behavior is explicit for later replacement by typed issues.                  |
| Preserve duplicate display labels       | Both sanitized fixtures use `ORDER-SHARED-100`; the suite proves both remote IDs survive aggregation                                           | Display order numbers are documented as non-unique and cannot safely become identity keys.                       |
| Record legacy locations                 | `legacyMarketplaceLocations` records the unqualified TCGplayer route/hash and spike-era ManaPool query/hash                                    | Packages 4 and 9 have concrete compatibility inputs.                                                             |
| Record every durable schema             | `legacyMarketplaceStateFixtures` covers workflow v1, pull progress v1, shipment tags v2, shipment scans v1, and notifications v1               | Package 7 migration tests have sanitized, production-parser-validated inputs.                                    |
| Fail closed on unsupported durable data | `marketplace-legacy-state.test.ts` verifies all five readers reject version 999 with `PERSISTENCE_ERROR`                                       | No migration may silently reset unsupported state.                                                               |
| Stop new SDK coupling                   | `provider-coupling-baseline.json` plus `architecture-boundaries.test.ts` exactly inventories known SDK-importing files outside adapter folders | Any new out-of-boundary SDK import fails the normal test suite; later packages must shrink the list.             |
| Stop new provider-name branching        | The same boundary test exactly inventories quoted provider IDs outside adapter folders                                                         | A new hard-coded TCGplayer/ManaPool branch fails until deliberately reviewed; target adapter folders are exempt. |

Self-review findings resolved during the checkpoint:

- The first literal baseline over-counted plain text from shell output. The
  executable baseline was corrected to count quoted TypeScript provider IDs.
- Strict lint found an unnecessary fixture type assertion. It was removed.

Verification:

- Focused: 3 files, 10 tests passed.
- Full repository: formatting, ESLint, strict TypeScript, 57 files / 363 tests,
  server build, web build, and browser-extension build passed.
- Dependency audit: 0 vulnerabilities at the configured high severity gate.
- Privacy review: no credential value, personal email address, customer data,
  or real provider response was added; all identities and addresses are
  explicitly synthetic.
- Durable compatibility: Package 0 changes no production schema or write path.

## Package 1 — Identity, lifecycle, money, and contracts

Date: 2026-08-24

Result: compliant; no open findings.

| Requirement                              | Evidence                                                                                                                                   | Review conclusion                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Open provider identity                   | `parseProviderId` accepts a synthetic third-provider slug and has no closed union                                                          | The core can represent installed providers without editing its types.        |
| Account-level identity                   | `parseConnectionId` enforces `^[a-z][a-z0-9-]{0,63}$`; `ProviderOrderRef` qualifies every remote ID by connection                          | Multiple accounts of one provider and duplicate remote IDs remain distinct.  |
| Canonical qualified keys                 | `orderRefKey` and `parseOrderRefKey` are the only codec; hostile and noncanonical encodings are rejected                                   | Display order labels and ad hoc interpolation are not identity.              |
| Provider-independent lifecycle           | `OrderLifecycle` contains the seven accepted application states while `providerStatus` and optional opaque status code remain available    | Provider enum types do not enter the new contract.                           |
| Explicit money                           | `Money` uses uppercase three-letter currency and safe integer minor units; arithmetic rejects mixed currency and overflow                  | New provider adapters cannot introduce floating major-unit arithmetic.       |
| Three capability layers                  | Contracts separately define static facets, `ConnectionHealth`, and per-order `ActionAvailability` with stable action IDs and reasons       | Capability support is not collapsed into connection state or entity state.   |
| Normalized orders and catalog identities | Summary/detail, stable unique `lineKey`, address, totals, attributes, tracking, and namespaced identity precision all have runtime parsers | Sanitized provider data can be normalized without raw SDK records.           |
| Narrow facets                            | Order pages/detail, fulfillment, refunds, documents, pull lines, inventory, and catalog metadata are independent interfaces                | No catch-all marketplace service was introduced.                             |
| Partial-failure contract                 | `ProviderIssue` and `AggregateResult` use connection-qualified safe metadata and the accepted operation vocabulary                         | Package 2 can aggregate failures without exposing raw provider data.         |
| Compatibility without route changes      | Temporary compatibility projections round-trip both Package 0 provider summaries exactly                                                   | Existing HTTP/browser behavior remains unchanged during the foundation step. |
| Boundary compliance                      | Executable Package 0 enforcement finds no SDK import or named-provider literal in `src/marketplaces`                                       | The new core is provider-neutral and depends on no adapter.                  |

Self-review findings resolved during the checkpoint:

- Strict TypeScript exposed the legacy summary's optional provider marker in a
  test. A runtime fixture guard now documents that compatibility assumption.
- Strict lint found one unnecessary string conversion and two Unicode-counting
  constructs. The conversion was removed and code-point limits now use
  `Array.from`, preserving the ADR's Unicode-character semantics.

Verification:

- Focused: identity, normalized contracts, compatibility, and architecture
  boundary suites passed (28 tests in the focused run).
- Full repository: formatting, ESLint, strict TypeScript, 59 files / 389 tests,
  server build, web build, and browser-extension build passed.
- Dependency audit: 0 vulnerabilities at the configured high severity gate.
- Privacy review: validators use generic safe error text and do not include
  rejected remote IDs, addresses, provider responses, or credentials.
- Durable compatibility: Package 1 performs no filesystem write, changes no
  state version, and changes no public route or browser hash.

## Package 2 — Registry and synthetic vertical slice

Date: 2026-08-25

Result: compliant; no open findings.

| Requirement                   | Evidence                                                                                                                                                                                                            | Review conclusion                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Compile-time adapter registry | `ProviderAdapterRegistry` validates open provider slugs, duplicate factories, safe labels, and declared facet IDs                                                                                                   | Installed adapters are registered once without a closed provider union.                                            |
| Runtime connection registry   | `MarketplaceConnectionRegistry` validates configured IDs, instantiates enabled connections only, verifies returned descriptors, freezes descriptors/facets, and exposes disabled status separately                  | Multiple accounts and disabled connections do not require generic provider branches.                               |
| Narrow facet lookup           | The registry resolves typed order, mutation, document, pull, inventory, and catalog facets independently                                                                                                            | Unsupported work fails explicitly rather than through a catch-all service.                                         |
| Read-only health              | `ConnectionHealthService` coalesces checks, caches them for 30 seconds, supports force refresh, sanitizes thrown failures, and projects disabled status without probing                                             | Client construction is not treated as authentication proof.                                                        |
| Complete generic paging       | `OrderQueryService` owns sequential pages, opaque cursors, page limits, duplicate qualified references, mismatched refs, and empty continuation rejection                                                           | Adapters translate one page and cannot silently return incomplete success.                                         |
| Query policy and cache        | Tests prove the three-calendar-month UTC lookback including month-end clamping, no ready-order lookback, 30-second complete-result cache, force bypass, and preservation of the previous cache after failed refresh | Query policy is provider-neutral and deterministic.                                                                |
| Aggregate failures            | Healthy empty data counts as success; partial failures retain data plus safe issues; all-failed and no-eligible conditions are distinct typed errors; unhealthy connections are not called                          | Generic services no longer silently omit failed configured connections.                                            |
| Configuration v6              | `CURRENT_CONFIG_VERSION` and the committed example are v6 with synchronization concurrency and connection map; Settings saves omit the singular provider object                                                     | The authoritative application configuration now uses the accepted connection model.                                |
| Pure v5 migration             | `parseMarketplaceConfiguration` and document migration preserve source data, create the default qualified connection, and remove the singular provider on the next successful save                                  | Existing configuration is not mutated or discarded during reads.                                                   |
| Temporary environment overlay | `loadConfig` applies the complete credential pair only in memory, rejects incomplete pairs, stores environment-variable names rather than values, and skips an explicit same-provider connection                    | Current ManaPool setup continues safely through Packages 2–4 without silently persisting secrets or configuration. |
| Third-provider extensibility  | A synthetic third provider is instantiated through factory registration plus v6 configuration only and participates in generic queries                                                                              | No generic HTTP/page change or provider-name branch is needed to add it.                                           |
| Duplicate display labels      | Generic query tests retain equal display order numbers across distinct qualified references                                                                                                                         | Display labels are conclusively not identity keys.                                                                 |

Self-review findings resolved during the checkpoint:

- The first completed v6 parser was staged but not yet authoritative. Review
  rejected that as insufficient; `AppConfig`, the committed example, Settings
  persistence, and runtime loading were migrated to version 6.
- Authentication-required connections were skipped correctly but initially
  labeled as `list-orders` issues. A typed internal health failure now preserves
  the correct `health` operation and retryability.
- Runtime review found status objects were not fully frozen and arbitrary
  uppercase provider exception messages could be mistaken for safe codes.
  Statuses are now frozen and only internal typed contract failures can emit a
  specific issue code; arbitrary errors become `ORDER_QUERY_FAILED`.
- The required ManaPool compatibility overlay adds one temporary provider
  literal in `config.ts`. It is explicitly recorded by the executable coupling
  baseline and must be removed with Package 9 compatibility cleanup.
- Invalid legacy provider identity initially escaped the configuration issue
  aggregator. It is now translated into the normal multi-issue startup error.

Verification:

- Focused: six configuration, registry, health, query, and boundary suites
  passed (77 tests in the integrated focused run).
- Full repository: formatting, ESLint, strict TypeScript, 62 files / 411 tests,
  server build, web build, and browser-extension build passed.
- Dependency audit: 0 vulnerabilities at the configured high severity gate.
- Privacy review: no credential value is serialized, persisted, logged, or
  returned by the overlay; provider failures are reduced to fixed safe codes.
- Durable compatibility: configuration reads remain pure; v1–v5 files are
  rewritten only after a successful Settings save, which atomically produces
  v6 and omits the compatibility `provider` projection.

## Package 3 — TCGplayer adapter migration

Date: 2026-08-25

Result: compliant; no open findings.

| Requirement                     | Evidence                                                                                                                                                                                                                                 | Review conclusion                                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Provider-owned SDK work         | `src/providers/tcgplayer/normalized-orders.ts`, `normalization.ts`, `fulfillment.ts`, `documents.ts`, and `pull-lines.ts` contain the order SDK translations and calls                                                                   | Normalized marketplace modules and the root order façade import no provider SDK.                                                          |
| Exhaustive lifecycle mapping    | `tcgplayerLifecycle` has a compile-time-complete record for every installed `SellerOrderStatus`; a table-driven test covers all twelve values                                                                                            | Provider labels and codes remain opaque while application behavior uses the seven normalized lifecycle states.                            |
| One-page translation            | `TcgplayerOrderPageReader` owns only a validated offset cursor and one SDK page; `OrderQueryService` retains complete sequential walks, limits, cache, and partial-failure policy                                                        | The adapter cannot silently substitute its legacy full-list cache for generic pagination.                                                 |
| Normalized summaries and detail | The adapter produces qualified refs, USD minor-unit totals, normalized address and tracking data, unique SKU line keys, exact-variant SKU identities, and product-level product identities                                               | Raw SDK records do not cross the adapter boundary, and cross-provider catalog matching has explicit precision.                            |
| Fulfillment isolation           | `TcgplayerFulfillmentMutator` validates connection ownership, detects the carrier, resolves credentials at call time, and rejects a result for a different remote order                                                                  | Generic mutation routing never selects a provider from an unqualified display number.                                                     |
| Native documents                | `TcgplayerNativeOrderDocumentSource` validates timezone, exact returned order identity, nonempty PDF bytes, and a safe file name                                                                                                         | Document bytes remain an in-memory normalized facet with no SDK dependency in generic callers.                                            |
| Pull export                     | `TcgplayerPullLineReader` validates the exact requested order set and emits one quantity-bearing pull line per qualified order allocation with exact SKU identity                                                                        | Native aggregation is decomposed without losing per-order allocation identity needed by the future combined list.                         |
| Factory and registration        | `createTcgplayerAdapterFactory` validates settings, declares five narrow facets, supports injected browser credentials or environment references, and `createMarketplaceConnectionRegistry` registers the v6 `tcgplayer-main` connection | TCGplayer is installed through the same provider/connection registries used by synthetic providers rather than a generic provider branch. |
| Three capability layers         | The factory declares static facets, its health probe is read-only, and `resolveOrderActions` combines static support, lifecycle, required data, and provider-translated entity permissions                                               | Static support, connection state, and per-order state are not conflated.                                                                  |
| Generic service extraction      | `OrderQueryService`, provider-neutral paging validation, `resolveOrderActions`, and `MarketplaceOrderActionService` own caching, policy, health gating, qualified dispatch, and invalidation                                             | Removing TCGplayer registration leaves the generic query and mutation services valid, as exercised with two synthetic providers.          |
| Compatibility                   | `src/order-management.ts` is only an import-compatible re-export of the isolated legacy TCGplayer workspace; existing order-management and ready-order suites remain green                                                               | Current routes and workflows retain their behavior while Package 4 replaces their named services.                                         |
| Enforced boundary               | The executable architecture test passed after the SDK and literal baseline shrank for migrated root modules; direct SDK search over `src/marketplaces`, `src/order-management.ts`, and `src/ready-orders.ts` is empty                    | Future provider leakage or reintroduction into migrated modules fails CI.                                                                 |

Self-review findings resolved during the checkpoint:

- An environment-backed connection with absent secrets initially reported
  `authentication-required`, which incorrectly implied an expired configured
  session. It now reports `not-configured`; an injected disconnected browser
  session continues to report `authentication-required`.
- The first runtime query composition parsed paging through the TCGplayer
  settings parser. Review moved the shared `pageSize`/`maximumPages` parser to
  `OrderQueryService`, so generic runtime caching has no provider assumption.
- Lifecycle alone initially made fulfillment available for TCGplayer pickup
  orders. Summary normalization now translates the provider status into an
  entity-level allowed-action set, so only `ReadyToShip` exposes tracking and
  shipment mutations.
- Lint identified redundant document-literal checks guaranteed by the SDK
  types and a non-null assertion in secret resolution. The checks were reduced
  to meaningful runtime invariants and secret narrowing is explicit.
- The health test originally proved only its result. It now also proves that a
  health check calls neither order page nor detail endpoints.

Verification:

- Focused: six adapter, generic action, generic query, architecture,
  compatibility order-management, and ready-order files passed (62 tests in
  the integrated focused run before the final runtime-registration assertion).
- Full repository: formatting, ESLint, strict TypeScript, 64 files / 434 tests,
  server build, web build, and browser-extension build passed.
- Dependency audit: 0 vulnerabilities at the configured high severity gate.
- Boundary review: no provider SDK import exists in generic marketplace,
  root order-management façade, or generic ready-order modules; the executable
  coupling baseline passed.
- Privacy review: new provider modules contain no logger, console, or file-write
  path; credentials are resolved through closures, raw provider responses and
  customer data are not logged, and documents remain in memory.
- Durable compatibility: Package 3 introduces no persistent-state write,
  schema change, public route change, or browser hash change.

## Package 4 — ManaPool adapter and provider-neutral order UI

Date: 2026-08-25

Result: compliant; no open findings.

| Requirement                               | Evidence                                                                                                                                                                                     | Review conclusion                                                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| ManaPool adapter owns SDK translation     | `src/providers/manapool/normalization.ts`, `orders.ts`, `fulfillment.ts`, and `factory.ts` contain ManaPool-specific records, paging, lifecycle translation, money conversion, and mutations | Generic order services and browser code receive only normalized contracts.                                             |
| Same narrow facets as other adapters      | The ManaPool factory supplies order pages, details, and fulfillment through the shared adapter registry                                                                                      | ManaPool is composed as a peer provider rather than a service layered on the TCGplayer implementation.                 |
| Registry-based server composition         | `marketplace-order-routes.ts` resolves descriptors, health, reads, documents, and mutations by qualified connection through registry services                                                | Route code has no normal provider-selection branch; the only named mapping is the documented legacy query translation. |
| Generic aggregate HTTP contract           | `/api/orders`, `/api/orders/ready`, `/api/orders/sync`, and qualified connection/order routes return normalized data and safe typed issues                                                   | Partial provider failure returns usable data with HTTP 200; no eligible connection or total failure returns HTTP 503.  |
| Three capability layers reach the browser | Marketplace connection responses expose descriptors, cached health, and static facets while each order carries independent action availability                                               | The UI does not infer action availability from a provider name or connection status alone.                             |
| Qualified browser identity                | Links, detail loading, tracking, shipment, packing-slip, and Pirate Ship calls use `{connectionId, remoteId}` in hashes and HTTP paths                                                       | Duplicate display order numbers cannot collide across providers or accounts.                                           |
| Provider-neutral pages and actions        | Dashboard, orders, detail, master-pull refresh selection, and order actions consume normalized contracts and descriptor labels                                                               | The functional UI renders TCGplayer, ManaPool, and partial failures without provider-specific page branches.           |
| Third-provider extensibility              | `web-orders.test.tsx` and registry/HTTP tests install a synthetic third provider through descriptors and normalized responses only                                                           | Adding a provider does not require edits to generic routes, pages, action components, or decoders.                     |
| Legacy compatibility is isolated          | Unqualified TCGplayer routes/hashes and the recorded ManaPool spike forms translate at route boundaries; legacy scanner/refund contracts use explicit legacy aliases                         | Compatibility does not leak provider unions into the new aggregate order model and remains removable in Package 9.     |
| Provider coupling boundary shrank         | Legacy ManaPool implementations moved under `src/providers/manapool`; root modules are deprecated re-export façades; the executable baseline passes                                          | Provider SDK knowledge is adapter-owned and no new generic coupling was introduced.                                    |
| Privacy-safe failures                     | Provider aggregation emits fixed codes and qualified connection metadata; the new provider and route modules contain no logging path                                                         | Credentials, raw responses, customer addresses, and tokens are not logged or returned in issue text.                   |

Self-review findings resolved during the checkpoint:

- The first browser migration retained a flat legacy decoder and provider union.
  Scanner/refund compatibility now uses explicitly named legacy aliases while
  marketplace order pages decode only the normalized aggregate contract.
- Master-pull refresh initially selected TCGplayer by identity. It now selects
  connections through the `pull-lines` facet.
- Named ManaPool route-context services and provider branches were removed in
  favor of registry lookup; the remaining named translations are restricted to
  recorded legacy URL inputs.
- A shipment action could race an in-flight list request and lose its refresh.
  Forced loads are now queued and replayed after the active read finishes.
- Full-suite review found marketplace descriptor loading changed the order
  loader function identity and could duplicate polling reads. A stable
  connection reference now keeps a single polling stream.
- The old dashboard, label, and pull-list tests still mocked the retired
  TCGplayer-only response shape. They now protect the same behaviors through
  normalized aggregate responses and qualified action URLs.

Verification:

- Focused: adapter, registry, HTTP, browser, characterization, legacy façade,
  configuration UI, API decoder, and architecture suites passed before the
  repository gate.
- Full repository: formatting, ESLint, strict TypeScript, 66 files / 449 tests,
  server build, web build, and browser-extension build passed.
- Dependency audit: 0 vulnerabilities at the configured high severity gate.
- Boundary review: the only named-provider branches found outside adapter
  folders are the explicitly inventoried legacy compatibility types and route
  translations; the executable coupling baseline passed.
- Privacy review: no credential value, raw provider response, customer data, or
  token was added to logs or safe issue payloads.
- Durable compatibility: Package 4 changes no persistence schema. New browser
  navigation emits qualified hashes; recorded unqualified hashes and ManaPool
  spike hashes remain translated until Package 9.

## Package 5 — Generic documents and printing

Date: 2026-08-25

Result: compliant; no open findings.

| Requirement                           | Evidence                                                                                                                                                                                                                      | Review conclusion                                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider-neutral render models        | `AddressLabelRenderModel` and `PackingSlipRenderModel` are built only from validated normalized order detail and qualified references                                                                                         | Local documents do not consume either provider SDK or raw provider records.                                                                   |
| Native-or-local packing-slip policy   | `OrderDocumentService` uses an optional native document facet first and renders locally only when the facet is absent or explicitly returns `unsupported`                                                                     | ManaPool does not need a packing-slip endpoint, while TCGplayer can retain its exact native document.                                         |
| Fail-closed native validation         | Native output must match the exact qualified order and packing-slip kind, use PDF media and signature, remain within the byte limit, and have a safe filename                                                                 | Authentication, network, malformed-document, and wrong-order failures are never hidden by a local fallback.                                   |
| Unicode-safe local output             | The shared local packing-slip and PDF address-label renderers use the existing canvas PDF backend, wrap overlong words, and preserve Unicode customer and item text                                                           | Valid international addresses and product descriptions do not fail on the former Helvetica encoding limit.                                    |
| Complete local packing slip           | The application-generated PDF identifies itself as non-official and includes connection/order/date, shipping address and method, item attributes, quantity, unit and line prices, subtotal, shipping, optional tax, and total | The fallback is operationally useful without impersonating a marketplace invoice.                                                             |
| Generic manual download and printing  | Qualified HTTP routes dispatch packing-slip downloads and both print action types through `OrderDocumentService` and `OrderPrintService`; the browser calls those routes by qualified ref                                     | TCGplayer, ManaPool, multiple accounts, and future adapters share one route and UI implementation.                                            |
| Generic workflow printing             | The legacy workflow's packing-slip dependency is backed by `OrderDocumentService`, and manual legacy printing translates to exactly one matching registered connection before entering the same print service                 | Compatibility callers retain behavior without making the generic services provider-specific.                                                  |
| Application-owned action availability | `projectDocumentActions` derives local document actions from detail/native facets and configured address-label output; aggregate and detail routes use the projection                                                         | Adapters no longer determine whether an application printer is configured, and missing configuration is reported as `configuration-required`. |
| Provider boundary                     | Searches over `src/fulfillment`, the qualified route, and browser action component find no named-provider control flow; named mappings exist only in the documented legacy route translator                                   | Adding another provider with order detail requires no document, printing, route, or browser branch.                                           |
| Privacy and persistence               | Document bytes and addresses stay in memory, document services contain no logger or filesystem write, and idempotency keys use canonical qualified refs plus a random manual-attempt component                                | No customer/document content enters logs or durable workflow state, and Package 5 adds no schema migration.                                   |

Self-review findings resolved during the checkpoint:

- ManaPool was initially treated as lacking packing slips because it has no
  native endpoint. The action and document policy now recognize a packing slip
  as an application-derived capability and render one from normalized detail.
- The first local renderer transliterated or replaced characters unsupported by
  a built-in PDF font. Both local document renderers now preserve Unicode with
  the installed canvas PDF backend; regression tests cover accented and Japanese
  text, long unbroken values, and multi-page slips.
- Native validation initially relied too heavily on the TypeScript facet type.
  It now revalidates runtime output, including exact qualified identity, kind,
  PDF signature, byte bounds, and safe download filename. Tests prove provider
  errors, wrong-order output, and malformed bytes do not fall back locally.
- Provider-normalized actions initially advertised address printing without
  considering local output configuration. A generic runtime projection now
  returns `configuration-required` until a valid configured label action and
  printer exist, while retaining locally downloadable packing slips.
- Manual print intentionally permits an action whose automation `enabled` flag
  is false. That flag controls unattended workflow execution; an explicit
  operator print remains allowed and still requires a configured action and
  printer.

Verification:

- Focused: document, print action, provider adapter, workflow, generic query,
  qualified browser, and architecture suites passed (62 tests before the final
  configuration-projection regression; 27 tests in the final affected run).
- Full repository: formatting, ESLint, strict TypeScript, 67 files / 457 tests,
  server build, web build, and browser-extension build passed before the final
  action-projection refinement; the complete gate was rerun after this record.
- Dependency audit: 0 vulnerabilities at the configured high severity gate.
- Boundary review: only the temporary Package 9 compatibility translator names
  the two current providers outside adapter and configuration composition code.
- Privacy review: local PDFs are generated and dispatched in memory; neither
  addresses, document bytes, raw provider responses, nor credentials are logged
  or persisted.
- Durable compatibility: Package 5 introduces no persistent schema or write
  path. Existing unqualified manual and workflow inputs translate at their
  compatibility edges and enter qualified generic services immediately.

## Package 6 — Combined master pull list

Date: 2026-08-25

Result: compliant; no open findings.

| Requirement                  | Evidence                                                                                                                                                                                         | Review conclusion                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider-neutral aggregation | `MasterPullListService` reads normalized ready summaries and either a connection's optional `PullLineReader` or bounded-concurrency normalized order details                                     | Native TCGplayer exports and detail-derived ManaPool lines enter the same generic aggregation path; the service imports no provider SDK.         |
| Exact-only merging           | Pull rows are connected only by identical exact-variant catalog identities; product-level, fuzzy, and display-name matches never merge                                                           | Cross-provider quantities combine only when the adapters supply a shared exact identity, while unmatched lines retain qualified allocation keys. |
| Conflict isolation           | Condition, finish, language, and printing conflicts invalidate only the affected identity component and emit a safe connection-qualified issue                                                   | Ambiguous variants are never silently combined and healthy rows remain usable.                                                                   |
| Qualified allocations        | Every pull line carries quantity-bearing `{connectionId, remoteId, lineKey}` allocations whose sum must equal the displayed row quantity                                                         | Duplicate order numbers, line keys, and catalog identifiers across connections cannot collide.                                                   |
| Optional catalog enrichment  | `CatalogMetadataReader` accepts exact identities and returns multi-valued generic attributes; lookup failure retains the list with a fixed safe warning                                          | Binning and display metadata can improve without becoming a prerequisite for picking.                                                            |
| Partial-failure behavior     | Healthy connections contribute rows and failed connections contribute safe issues; if every applicable source fails, the HTTP route returns a typed 503 rather than an empty-success list        | Operators can distinguish a complete empty list from unavailable provider data.                                                                  |
| Durable pull progress v2     | `JsonQualifiedPullListProgressStore` persists qualified allocation identity, quantity, and timestamp; v1 reads migrate in memory to `tcgplayer-main` and only the next save atomically writes v2 | Reads remain pure, restarts preserve progress, and identical remote IDs from different providers stay independent.                               |
| Shipment pruning             | Successful `markShipped` removes only the shipped qualified order allocations and invalidates the cached list if local cleanup fails                                                             | A completed remote mutation is not made uncertain or retried because of a local projection failure.                                              |
| Generic HTTP and browser UI  | Qualified pull-list routes use opaque `rowKey` values; the page renders combined rows, progress, printing, and connection-labelled issues without provider branches                              | Both current providers and a future detail-capable provider use the same functional UI.                                                          |
| Provider boundary            | TCGplayer catalog lookup and native pull normalization live under `src/providers/tcgplayer`; generic pull modules contain no provider selection or SDK import                                    | Provider-specific product IDs never leak into matching or generic control flow.                                                                  |

Self-review findings resolved during the checkpoint:

- The original normalized allocation shape omitted quantity, which made it
  impossible to remove one order safely from an aggregated row. Allocations
  now carry validated quantities and their sum must equal the row quantity.
- A generic projection initially exposed a numeric TCGplayer product ID for
  compatibility. It was removed from matching and projection; only opaque,
  namespaced catalog identities participate in aggregation.
- Catalog metadata was initially single-valued. The contract now preserves
  multi-valued attributes so enrichment cannot discard valid colors or types.
- Provider and catalog catches initially converted aborted requests into safe
  failure issues. Cancellation is now rethrown, while actual provider failures
  retain the partial-result policy.
- Metadata readers could receive an empty identity request. Empty requests now
  bypass the optional facet, avoiding provider-specific assumptions and calls.
- Older browser test fixtures still published the pre-migration SKU-only
  response. They now exercise opaque row keys, issue arrays, and provider-neutral
  “exact variants” copy.

Verification:

- Focused: generic aggregation, v1/v2 progress migration, TCGplayer adapter,
  qualified HTTP, and both pull-list browser suites passed (27 tests in the
  final affected run).
- Full repository: formatting, ESLint, strict TypeScript, 69 files / 474 tests,
  server build, web build, and browser-extension build passed.
- Dependency audit: 0 vulnerabilities at the configured high severity gate.
- Boundary review: named provider mappings remain only in the documented
  legacy route/progress translators and provider-owned adapter modules; generic
  aggregation and browser control flow contain no provider dispatch branch.
- Privacy review: catalog, pull, and progress services add no logging path;
  credentials, raw responses, customer data, and document content are neither
  logged nor persisted by this package.
- Durable compatibility: v1 pull progress is parsed and migrated without a
  read-time write; the first successful mutation atomically commits v2. The
  old v1 compatibility service and unqualified route remain isolated until
  Package 9 removes supported legacy callers.

## Package 7 — Durable workflow and scanner migration

Date: 2026-08-25

Result: compliant; no open findings.

| Requirement                         | Evidence                                                                                                                                                                                                            | Review conclusion                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow state v2                   | JsonStateStore validates and migrates v1 order keys to canonical tcgplayer-main refs, replaces the global checkpoint with per-connection baselines, records per-connection outcomes, and supports aggregate partial | Duplicate remote IDs remain independent, and a failed connection cannot inherit or advance another connection's checkpoint.                               |
| Tag state v3                        | JsonShipmentTagRegistry qualifies assignment keys and v2 hash inputs while its v1/v2 readers preserve existing tag IDs and sequences                                                                                | Existing printed tags remain usable after migration; new assignments are collision-safe across connections.                                               |
| Scan state v2                       | JsonShipmentScanStore migrates v1 records to qualified refs and recovers interrupted mutations as review-required                                                                                                   | An uncertain provider mutation is quarantined under the exact connection and is never retried as another provider's order.                                |
| Notification state v2               | JsonNotificationStateStore qualifies ready-order observations and cancellation keys, nests message observations by connection, and preserves unrelated random shipment delivery keys                                | Cancellation comparison and deduplication cannot collide when two connections use the same remote ID.                                                     |
| Independent bounded synchronization | MarketplaceReadyOrderSource performs complete per-connection reads with providers.synchronizationConcurrency; FulfillmentWorkflow consumes only successful connection snapshots                                     | Tests prove the concurrency limit, complete-page requirement, partial success, all-failure snapshot preservation, and per-connection checkpoint behavior. |
| Qualified application flow          | Rules receive provider-declared workflow fields from normalized summaries/details; actions, documents, idempotency keys, scanner matches, shipment reconciliation, and notifications all carry canonical refs       | The same remote/display number on two connections routes to the exact provider facet and durable record.                                                  |
| Failure isolation                   | Page and health failures become safe connection issues and failed connection summaries; only successful connection IDs may retire tags or cancellation observations                                                 | A failed connection neither blocks healthy scheduled/scanner work nor appears as an empty successful refresh.                                             |
| Session independence                | The scheduled loop always invokes the provider-neutral workflow and notification monitor; the TCGplayer session gate remains only on legacy TCGplayer inventory/pricing workers                                     | ManaPool-only and mixed order/scanner workflows do not require a global TCGplayer session.                                                                |
| Privacy and provider boundaries     | Durable workflow/scan/tag/notification states contain refs, safe statuses, timestamps, and error codes only; generic migrated modules import no provider SDK and contain no provider dispatch branch                | Customer addresses, item content, credentials, documents, and raw provider responses remain ephemeral and absent from logs/state.                         |

Self-review findings resolved during the checkpoint:

- The first scanner and notification migration fixtures still used bare order
  numbers and legacy order shapes. They now exercise normalized orders,
  qualified refs, per-connection issues, and duplicate remote IDs.
- Shipment cleanup originally ran inside the authoritative provider mutation
  try block. A local cache/progress failure could therefore make an applied
  shipment look failed. Cleanup is now isolated and cannot cause an unsafe
  provider retry.
- Ready-source concurrency validation originally fabricated a provider issue
  for an application configuration error. It now fails with a generic contract
  validation error before any connection is labeled unhealthy.
- Notification v2 ref parsing originally relied on a type assertion before
  runtime validation. It now parses every ref directly through the normalized
  identity contract.
- The workflow initially inferred payment from lifecycle, hard-coded seller
  fulfillment, and treated non-USD minor units as whole units. Normalized
  summaries now preserve provider-declared channel, fulfillment, and payment
  fields; missing payment is conservative, and all money is projected to major
  units for the legacy numeric rule engine.
- The original partial-failure test failed on the first page only. Coverage now
  forces a second-page failure and proves that its partial page is discarded,
  its old checkpoint is retained, and healthy connection state still commits.
- The architecture baseline was reduced to record that notification, scanner,
  and browser decoder modules no longer import provider SDKs or contain closed
  provider literals.

Verification:

- Focused: workflow, ready-source concurrency/failure, scanner, tag,
  notification, durable migration, scanner route, and scanner browser suites
  passed (58 tests before the final mid-page/concurrency additions; the full
  suite includes the added cases).
- Full repository: formatting, ESLint, strict TypeScript, 70 files / 477 tests,
  server build, web build, and browser-extension build passed.
- Dependency audit: 0 vulnerabilities at the configured high severity gate.
- Boundary review: provider-name references in Package 7 generic paths are
  limited to explicit legacy-schema/route translators scheduled for Package 9;
  no runtime provider selection depends on them.
- Privacy review: logs use correlation IDs, canonical-ref hashes, operation
  names, counts, and safe error codes; durable state stores no address, buyer,
  line-item, document, credential, or raw-response data.
- Durable compatibility: all four Package 7 readers migrate old state purely in
  memory and atomically write the target schema only on a later successful
  mutation; the cross-package legacy fixture verifies that reads do not alter
  any file.

## Package 8 — Inventory and optional workspaces

Date: 2026-08-25

Result: compliant; no open findings.

| Requirement                         | Evidence                                                                                                                                                                                                                                                 | Review conclusion                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normalized inventory contract       | `InventoryReader`, `InventoryMutator`, validated money, catalog identities, attributes, mutation modes, and runtime parsers live in the provider-neutral marketplace contract                                                                            | Inventory UI and HTTP code do not consume either marketplace SDK or provider record shape.                                                                |
| Complete connection aggregation     | `MarketplaceInventoryService` walks bounded pages per connection with bounded cross-connection concurrency, rejects cursor/item contract violations, preserves duplicate provider keys across connections, and emits safe partial issues                 | One unavailable marketplace does not hide healthy inventory, while an all-provider failure remains a typed aggregate error.                               |
| Exact mutation routing              | Browser and HTTP mutation paths include both connection ID and opaque inventory key; the service health-checks and invokes only that connection's mutator                                                                                                | Duplicate inventory keys on two accounts cannot cause a cross-account write.                                                                              |
| ManaPool inventory                  | `ManaPoolInventoryFacet` preserves native cursors, uses cents directly, exposes stable identities, marks items without a TCGplayer SKU read-only, re-reads exact state, and verifies absolute update results                                             | ManaPool listing quantity and price changes use the same normalized workspace without building on a TCGplayer service.                                    |
| TCGplayer inventory                 | `TcgplayerInventoryFacet` flattens both inventory channels, isolates concurrent pagination snapshots, exposes increase-or-clear semantics, rejects unsafe partial decreases/custom listings, re-reads before mutation, and checks submitted SKU evidence | Existing safe listing reads, increases, clears, and price changes remain available through the generic contract.                                          |
| Functional dual-provider UI         | `InventoryPage` aggregates and labels connections, filters by connection/search, renders normalized variants and money, respects per-item mutation support, and refreshes only after definitive outcomes                                                 | TCGplayer and ManaPool inventory are usable together with no provider branch in the page.                                                                 |
| Capability-driven navigation        | `App` maps optional routes to advertised facets and derives visibility/availability independently from enabled connection health                                                                                                                         | ManaPool-only order, scanner, and inventory workspaces remain available without a global TCGplayer browser session; unsupported optional pages disappear. |
| Connection-scoped legacy workspaces | Payments, messages, and feedback require an eligible advertised connection and reject unknown, unsupported, unhealthy, or ambiguous selection before entering their retained service                                                                     | Optional TCGplayer workspaces no longer behave as global prerequisites; their service replacement remains isolated to Package 9 cleanup.                  |
| Hostile-boundary validation         | Core inventory parsers validate price/mutability coherence, pagination keys and cursors, money, identities, attributes, mutation commands, and provider outcomes; browser decoders reuse the normalized item parser                                      | Malformed provider and HTTP values fail closed instead of entering UI or mutation logic.                                                                  |
| Provider boundary                   | Generic inventory service, route, browser contracts, and page contain no provider SDK import or named provider dispatch                                                                                                                                  | A future inventory adapter needs only registry facets; generic route and UI source do not change.                                                         |

Self-review findings resolved during the checkpoint:

- The first TCGplayer reader stored one mutable pagination snapshot, so two
  overlapping browser reads could make one cursor continue through the other
  request's data. Cursors now carry an opaque snapshot ID and a bounded map
  isolates walks; regression coverage interleaves two reads.
- A price-mutable item initially allowed its current price to be absent, which
  forced the browser to guess USD. The runtime contract now requires a price
  whenever price mutation is advertised.
- A selected-connection inventory read initially relied on a generic thrown
  validation error. The HTTP boundary now returns explicit 404, 409, 401, or
  503 results for unknown, unsupported, unauthenticated, or unavailable
  connections before provider access.
- TCGplayer clearing an already-empty listing could submit a meaningless
  removal merely because a requested price differed. It now returns
  `already-applied` for an empty target and current listing.
- The old browser suite asserted the replaced TCGplayer repricing preview.
  Tests now exercise combined TCGplayer/ManaPool inventory, connection and text
  filters, qualified writes, safe partial issues, and ManaPool-only navigation.
- Optional legacy account routes initially rejected test/runtime compositions
  that intentionally supply only the compatibility account service. They now
  enforce registry capability selection whenever the production marketplace
  runtime is present, while retaining the isolated Package 9 compatibility
  construction path.

Verification:

- Focused: generic inventory service, both provider inventory facets, registry,
  qualified HTTP, dual-provider browser inventory, and capability navigation
  suites passed (66 tests in the final affected runs).
- Full repository: formatting, ESLint, strict TypeScript, 73 files / 492 tests,
  server build, web build, and browser-extension build passed.
- Boundary review: inventory provider names occur only in adapter-owned code,
  adapter tests, test fixtures, and configuration composition; generic
  inventory route/UI control flow contains no provider selection branch.
- Privacy review: inventory issues expose only connection, operation, fixed
  code, and retryability; raw provider responses, credentials, item snapshots,
  and mutation bodies are neither logged nor persisted by this package.
- Durable compatibility: Package 8 adds no durable inventory cache or schema.
  Existing workflow migrations remain untouched, and authoritative inventory
  state is re-read from its qualified provider before every mutation.

## Package 9 — Compatibility removal and provider authoring

Date: 2026-08-25

Result: compliant; no open findings.

| Requirement                        | Evidence                                                                                                                                                                                                          | Review conclusion                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Qualified order boundary           | The server and browser accept only `connectionId` plus remote ID for detail and mutation routes; unqualified detail/refund aliases and provider query/hash translations were deleted                              | Duplicate IDs cannot fall through to an implicit provider or account.                                                 |
| One normalized order stack         | The legacy ready-order, order-management, synchronization, ManaPool projection, and closed provider-union modules and tests were removed; runtime/CLI use the registry services only                              | ManaPool is not layered on a TCGplayer domain model, and a third adapter does not need another parallel service tree. |
| No compatibility projections       | Legacy summary projections, hidden `config.provider`, global order-service fields, and refund aliases were removed; money conversion remains as a provider-neutral utility                                        | Current callers consume normalized contracts directly.                                                                |
| Explicit configuration             | The temporary ManaPool environment overlay was removed; version-six example and local operator configuration declare both connections with secret references only                                                 | Startup behavior is determined by saved connections rather than ambient provider discovery.                           |
| Capability-driven browser          | Marketplace connection state is shared through `MarketplaceConnectionsContext`; navigation, unavailable states, and message polling derive from enabled healthy facets, while TCGplayer pairing stays in Settings | A disconnected TCGplayer session no longer gates unrelated providers or leaves a global seller-session footer.        |
| Connection-scoped account services | Payments, feedback, and messages are supplied through a connection-keyed account-service map and validated against the matching registry facet and health                                                         | Retained TCGplayer workspaces are optional per-connection capabilities rather than named global route dependencies.   |
| Finished SDK boundary              | Provider SDK imports are confined to `src/providers/<providerId>/`; the temporary coupling baseline was deleted and the architecture test now requires zero imports outside that boundary                         | The allowlist cannot silently preserve or grow architectural debt.                                                    |
| Durable migration composition      | Generic state readers no longer contain a TCGplayer connection constant; the composition root supplies the explicit legacy migration target, and a legacy document fails closed without one                       | Migration compatibility does not become current provider selection logic.                                             |
| Operator and author documentation  | README, version-six example, ADR status/language, provider-authoring guide, and a compiled sanitized contract-test template describe the implemented architecture                                                 | The next provider has an implementation checklist and executable starting point.                                      |

Self-review findings resolved during the checkpoint:

- Removing the global authentication footer initially made unread-message
  polling unconditional. A shared marketplace-connections context now starts
  the poll only when a healthy enabled connection advertises `messages`.
- Retained payment/message/feedback routes initially still received three
  global service fields. They now resolve one qualified connection and obtain
  the corresponding service from a validated connection-keyed map.
- Provider-specific account modules still imported the TCGplayer package from
  root-level files. A provider-owned SDK boundary now contains the external
  import, and the architecture test enforces the final zero-import rule without
  a baseline file.
- State-schema migration readers initially embedded `tcgplayer-main`. They now
  require a composition-supplied target before reading an old unqualified
  schema and leave already-qualified schemas provider-neutral.
- Payment transaction rows could no longer safely link an unqualified order
  number after legacy hashes were removed. They now display the provider text
  without inventing a connection-qualified route.
- The authoring template initially lived outside the TypeScript project. It is
  now included in typecheck/lint so the copyable contract skeleton cannot rot.

Verification:

- Full repository: formatting, ESLint, strict TypeScript, 65 files / 437 tests,
  server build, web build, and Firefox/Chromium extension builds passed through
  `npm run check`.
- Local operator configuration: `npm run config:validate` passed against the
  explicit version-six TCGplayer and ManaPool connection map without exposing
  credential values.
- Boundary review: direct provider SDK imports occur only under provider-owned
  folders; quoted provider IDs in application source occur only in adapter
  registration/provider-specific composition, as enforced by the architecture
  suite.
- Privacy review: the new account-service registry stores service references
  keyed by connection ID only; descriptors, state migrations, issues, docs, and
  browser state contain no credentials or raw provider responses.

## Operator credential and destination hardening

Date: 2026-08-25

Result: compliant; no open findings.

| Requirement                      | Evidence                                                                                                                                                                                                          | Review conclusion                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Settings-managed API credentials | `MarketplaceCredentialManager` persists connection-scoped values through the platform protected text store; the adapter setup descriptor supplies generic fields; local GET responses expose presence/source only | ManaPool credentials are entered under Settings > Connections and apply immediately. Environment variables are retained only as a test/development fallback. |
| Secret precedence and isolation  | The registry scopes secret access by connection; protected values override environment fallbacks; unit coverage reloads persisted values and proves a second connection cannot read them                          | Additional API-key providers can reuse the mechanism without global credentials or provider branches in shared UI.                                           |
| Explicit listing destination     | Add cards displays the qualified capable connection, carries it through catalog/product/preview/queue requests, and the server returns 409 for a different connection                                             | Adding a card currently targets the displayed TCGplayer connection only; ManaPool inventory is unchanged.                                                    |
| Workflow navigation              | The sidebar is grouped into Overview, Selling, Fulfillment, Account, Automation, and System; Labels follows Orders and Scanner; Settings is last                                                                  | Navigation order follows the seller workflow instead of historical feature arrival.                                                                          |

Verification:

- Full repository gate: formatting, ESLint, strict TypeScript, 66 test files /
  439 tests, server build, web build, and Firefox/Chromium extension builds.
- Live loopback service: both configured connections report connected;
  ManaPool reports `managed-credentials`; an add-card catalog request carrying
  the ManaPool connection ID is rejected with HTTP 409.
- Privacy review: credential values are written only through the loopback API
  into OS-protected storage, are cleared from form state after save, and are
  absent from read responses, browser storage, logs, and configuration.

The explicit listing-destination row above is a historical checkpoint and is
superseded by ADR 0033 and the local-inventory implementation below.

## Local inventory source of truth

Date: 2026-08-25

Result: compliant; no open findings.

| Requirement                | Evidence                                                                                                                                                                         | Review conclusion                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Durable local authority    | `LocalInventoryService` serializes mutations; `JsonLocalInventoryStore` validates version 1 state and atomically replaces a mode-0600 file                                       | Unlisted physical stock has a stable application-owned identity and survives restart without depending on a provider read. |
| Exact variant merging      | Local additions require an exact-variant catalog identity; duplicate exact identities across local items fail validation                                                         | Product-level or fuzzy metadata cannot silently combine distinct conditions, printings, or languages.                      |
| Observation-only providers | `projectLocalInventoryWorkspace` links listings only by exact identity; unmatched listings remain visible and provider failures become safe issues                               | Remote reads neither seed nor overwrite local `onHand`, including when every provider read fails.                          |
| Local Add Cards            | The browser resolves one exact SKU and posts to `/api/local-inventory/catalog-items`; the route uses the qualified connection as metadata source and calls only the local ledger | Adding a card creates no listing, queue job, cross-post, or provider quantity change.                                      |
| Local quantity editing     | Inventory renders local stock before a separate marketplace-observations table and PUTs only `/api/local-inventory/items/{localInventoryId}`                                     | The editable number is explicitly physical local stock; all marketplace listing quantities are read-only.                  |
| Browser-safe contracts     | Local item parsers live in `local-inventory-contracts.ts`, separate from filesystem/crypto persistence                                                                           | The production web bundle contains no Node persistence dependency.                                                         |
| Mutation exclusion         | The HTTP test exercises local add and quantity update while observing an installed provider inventory mutator and requires zero commands                                         | The no-marketplace-mutation invariant is executable rather than copy-only guidance.                                        |

Safety scope:

- Cross-posting, provider-to-provider mirroring, automatic publication, and
  remote quantity reconciliation are absent.
- Existing provider mutation services remain compatibility infrastructure but
  are not called by the local Add Cards or Inventory workflows.
- Future shared-stock publication requires a separate ADR covering
  reservations, order timing, idempotency, uncertain outcomes, and operator
  reconciliation.

Focused verification: strict TypeScript, production web build, and 22 local
ledger/workspace/browser/HTTP tests passed. The browser test also proves Add
Cards does not call the legacy inventory-addition queue.

Full repository gate: formatting, ESLint, strict TypeScript, 69 test files /
448 tests, server build, web build, and Firefox/Chromium extension builds
passed.

### Bootstrap and sale deduction follow-on

The local ledger is now version 2. Version 1 reads migrate in memory; the next
successful local mutation atomically writes items, tracking activation, and a
qualified-order deduction map. A confirmed order changes quantities and writes
its idempotency result in one store replacement, so a workflow retry after any
later failure observes `already-applied` rather than deducting twice.

The one-time import planner unions listings by any shared exact identity,
skips existing local matches and non-exact listings, and suggests the maximum
observed quantity for each group. Review and confirmation are separate browser
and HTTP operations; confirmation performs a fresh provider read and one
atomic missing-item initialization. Synthetic providers expose inventory
mutators during the HTTP test, which verifies zero mutation calls across the
preview, initial import, and repeated no-op import.

Order confirmation invokes the local deduction before rules and actions. A
local persistence failure marks the order retryable and prevents printing;
once persistence recovers, processing continues. Baseline orders remain
untouched, subsequent exact sales deduct once, and matched shortages clamp at
zero while recording deducted, unmatched, and shortage totals without buyer or
line descriptions.

Verification: focused bootstrap/deduction/browser/HTTP coverage passed 37
tests. The full repository gate passed formatting, ESLint, strict TypeScript,
69 test files / 456 tests, server and web builds, and Firefox/Chromium extension
builds.
