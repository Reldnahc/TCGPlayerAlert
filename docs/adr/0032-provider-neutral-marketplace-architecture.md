# ADR 0032: Provider-neutral marketplace architecture

## Status

Accepted and implemented through Package 9 on 2026-08-25.

## Date

2026-08-24

## Review record

The implementation-readiness review resolved these design questions:

- A provider type and a configured seller connection are different concepts.
  Durable identity uses `connectionId`, so two accounts on one marketplace do
  not collide.
- Provider adapters expose narrow facets. Application services own aggregation,
  documents, pull lists, synchronization, printing, and operator workflows.
- Pagination is normalized at the adapter boundary and completed by the generic
  query service.
- Money uses integer minor units and an explicit ISO currency internally and at
  new server/browser boundaries.
- Static facet support, connection health, and per-order action availability
  are distinct data.
- Aggregate endpoints return provider issues with successful data and have
  defined all-failed behavior.
- Every durable order-number key has an explicit provider-qualified schema
  migration.
- The initial registry is compile-time composition from installed adapters. It
  does not dynamically execute third-party plugin code.

## Context

The application now reads and fulfills orders from TCGplayer and ManaPool, but
the first integration exposed an architectural problem: the application still
treats TCGplayer services, identifiers, statuses, pull-sheet exports, documents,
and authentication as its core model. ManaPool was added beside those services
with explicit branches in the runtime, HTTP routes, and browser.

That shape can support two providers temporarily, but every additional
marketplace would multiply conditionals and inherit accidental TCGplayer
requirements. It also incorrectly classifies locally derivable application
features, such as address labels and packing slips, as unavailable when a
provider does not supply a dedicated endpoint.

The desired product is one seller console and fulfillment workflow over any
number of marketplace connections. Providers supply authoritative marketplace
facts and authorized mutations. The application owns aggregation, normalized
presentation, local documents, picking, rules, printing, synchronization,
reconciliation, and operator workflows.

This decision supersedes the provider-specific portions of ADRs 0001, 0004,
0021, and 0023. Their privacy, validation, confirmation, idempotency, and
reliability requirements remain in force.

## Goals

- Add a marketplace by installing and registering adapters that implement
  narrow capability facets, without editing unrelated providers or adding
  provider branches to application services, HTTP routes, or browser pages.
- Support more than one configured seller account for the same marketplace
  without identity collisions.
- Keep provider SDKs and raw response types outside domain and application
  layers.
- Present one combined order, ready-to-ship, pull-list, and fulfillment
  experience while preserving the exact connection behind every operation.
- Compose application features from normalized data. A provider endpoint is
  one possible implementation, not the definition of the feature.
- Allow connections to expose different optional capabilities without
  pretending they have exact feature parity.
- Isolate connection failures and show partial-failure state without
  suppressing healthy connections.
- Preserve existing TCGplayer behavior while migrating it behind the same
  contracts used by ManaPool and future marketplaces.

## Non-goals

- Requiring every provider to support refunds, payments, messages, feedback,
  inventory mutation, or provider-generated documents.
- Inventing remote mutations that a provider does not authorize.
- Creating one catch-all provider interface with dozens of optional methods.
- Passing raw provider SDK enums, documents, or catalog records through the
  application.
- Merging product lines when exact identity cannot be established safely.
- Runtime installation or execution of untrusted third-party plugins in the
  initial local application.
- Converting every TCGplayer-only workspace into a cross-provider workspace
  before its semantics are understood.

## Terminology and identity

### Provider type

`providerId` identifies an installed adapter type, such as `tcgplayer` or
`manapool`. It is an opaque, stable slug supplied by adapter registration, not a
closed TypeScript union.

### Connection

`connectionId` identifies one configured seller account backed by a provider
adapter. Examples are `tcgplayer-main`, `manapool-main`, or `tcgplayer-store-2`.
Connection IDs are stable configuration keys matching
`^[a-z][a-z0-9-]{0,63}$`. Changing one creates a new logical connection and is
not a cosmetic rename.

A connection descriptor contains only safe presentation data:

```ts
interface MarketplaceConnectionDescriptor {
  readonly connectionId: string;
  readonly providerId: string;
  readonly providerLabel: string;
  readonly connectionLabel: string;
}
```

### Remote entity reference

Every remote entity is qualified by connection, not provider type or display
label:

```ts
interface ProviderOrderRef {
  readonly connectionId: string;
  readonly remoteId: string;
}
```

`remoteId` is the provider's stable, non-empty identifier. It is limited to 256
Unicode characters, must not contain control characters, and is always encoded
as a URL segment at transport boundaries.

The one canonical in-process and persisted map key is:

```ts
function orderRefKey(ref: ProviderOrderRef): string {
  return `${ref.connectionId}/${encodeURIComponent(ref.remoteId)}`;
}
```

Only the shared identity module may encode or decode this key. Application code
must not build identity strings with ad hoc interpolation. Structured
`ProviderOrderRef` values are preferred outside map and JSON object keys.

Display order numbers and labels are never global keys. Caches, browser routes,
reconciliation sets, idempotency keys, pull progress, notification history,
scanner records, and mutation requests use qualified references.

### Order lifecycle

The application owns this lifecycle vocabulary independently of provider SDK
enums:

```ts
type OrderLifecycle =
  | "pending"
  | "ready-to-ship"
  | "shipped"
  | "delivered"
  | "canceled"
  | "refunded"
  | "unknown";
```

An order retains the provider's unmodified status label as `providerStatus` for
display. Each adapter maps its status explicitly. Unknown provider values map
to `unknown` and never become actionable through display-text inference.

## Capability model

Three separate concepts must not be collapsed into one Boolean map.

1. **Facet support** is static: an installed connection has an order reader,
   fulfillment mutator, refund facet, and so on.
2. **Connection health** is runtime state: configured credentials may be
   authenticated, degraded, expired, or unreachable.
3. **Action availability** is evaluated for one normalized entity: a
   mark-shipped facet can exist while a delivered order cannot be marked
   shipped.

### Connection health

```ts
type ConnectionHealthState =
  | "disabled"
  | "not-configured"
  | "checking"
  | "connected"
  | "degraded"
  | "authentication-required"
  | "unavailable";

interface ConnectionHealth {
  readonly state: ConnectionHealthState;
  readonly checkedAt?: string;
  readonly issueCode?: string;
  readonly retryable?: boolean;
}
```

Health messages and codes are safe metadata and never contain credentials,
addresses, remote response bodies, or customer data. Health reads are cached
for 30 seconds. Explicit refresh bypasses the cache. Constructing a client is
not proof that a connection is authenticated.

### Per-order action availability

The application uses stable action IDs:

```ts
type OrderActionId =
  | "view-detail"
  | "print-address-label"
  | "packing-slip"
  | "pirate-ship"
  | "add-tracking"
  | "mark-shipped"
  | "refund";

type ActionAvailability =
  | { readonly state: "available" }
  | {
      readonly state: "unavailable";
      readonly reason:
        | "connection-unavailable"
        | "provider-unsupported"
        | "order-state"
        | "missing-data"
        | "configuration-required"
        | "review-required";
    };
```

The server resolves actions from registered facets, current health, normalized
order data, order lifecycle, local renderer/printer configuration, and safety
policy. The browser renders from that result and contains no provider-name
checks. Adding a new marketplace must not require UI edits; adding a new action
type may require a generic UI component.

## Capabilities the application needs

### Minimum order-workspace integration

A connection needs these facets to participate in the order workspace:

| Capability      | Required data or behavior                                      |
| --------------- | -------------------------------------------------------------- |
| Descriptor      | Stable provider and connection identity plus display labels    |
| Health          | Cached authenticated/degraded state with a safe issue code     |
| Order pages     | All-orders and ready-to-ship queries with opaque pagination    |
| Order detail    | Stable order ID, status, address, totals, and normalized lines |
| Stable line key | Provider line ID or deterministic exact-variant key            |

Order mutations are not part of the minimum. A read-only connection can still
participate in the combined workspace and locally derived documents.

### Required cross-provider application workflows

These are product capabilities and must not be owned by one marketplace
adapter:

| Workflow             | Source                      | Required behavior                                                   |
| -------------------- | --------------------------- | ------------------------------------------------------------------- |
| Combined orders      | Order page readers          | Merge by qualified reference and preserve connection                |
| Combined ready queue | Order page readers          | Normalize lifecycle and reconcile each connection independently     |
| Order detail         | Detail reader               | One provider-neutral presentation model                             |
| Address label        | Normalized address          | Render and print locally when an address exists                     |
| Packing slip         | Normalized detail           | Prefer validated native document; otherwise render locally          |
| Pirate Ship          | Normalized address          | Provider-neutral local preparation                                  |
| Master pull list     | Normalized pull lines       | Combine exact identities across every ready connection              |
| Pull progress        | Qualified order allocation  | Persist minimal connection-qualified quantities                     |
| Synchronization      | Registered readers          | Independent pagination, baseline, and reconciliation per connection |
| Rules and actions    | Normalized events/documents | Qualified idempotency and no provider SDK types                     |
| Shipment scanner     | Combined ready queue        | Resolve and mutate exactly one qualified order                      |
| Notifications        | Normalized events           | Include safe connection identity and display label                  |

### Optional provider facets

The platform defines these facets, but a connection implements only those its
authorized API permits:

- tracking and mark-shipped mutations;
- refund options and mutation;
- provider-native order documents;
- provider-native normalized pull-line export;
- inventory reads and mutations;
- catalog lookup and metadata enrichment;
- payments or payouts;
- messages;
- feedback;
- account and portal links.

## Normalized contracts

Provider integrations implement independent facets instead of one marketplace
service. These contract names and ownership are part of this decision; method
details may gain backward-compatible fields but must retain their direction.

### Paging ownership

Adapters translate one provider page into `OrderPage`. Provider cursors remain
opaque strings. `OrderQueryService` owns complete pagination, duplicate
reference detection, maximum-page enforcement, aggregation, caching, and
partial-failure reporting.

```ts
type OrderScope = "all" | "ready-to-ship";

interface OrderPageQuery {
  readonly scope: OrderScope;
  readonly since?: string;
  readonly cursor?: string;
  readonly pageSize: number;
}

interface OrderPage {
  readonly orders: readonly OrderSummary[];
  readonly nextCursor?: string;
}

interface OrderPageReader {
  readOrderPage(
    query: OrderPageQuery,
    signal?: AbortSignal,
  ): Promise<OrderPage>;
}

interface OrderDetailReader {
  getOrder(ref: ProviderOrderRef, signal?: AbortSignal): Promise<OrderDetail>;
}
```

An adapter must return only references for its configured connection. The query
service rejects a mismatched connection, duplicate qualified order, repeated
cursor, an empty page with a continuation cursor, or a page limit overrun.

`all` queries use a three-calendar-month UTC lookback calculated from the
injected clock. `ready-to-ship` queries do not add a lookback unless an adapter
documents a provider requirement. Successful complete results are cached for
30 seconds per connection and scope; explicit refresh bypasses the cache. A
failed refresh never replaces the last successful value. Page size and maximum
pages come from the validated connection settings.

### Mutations and optional facets

```ts
interface FulfillmentMutator {
  addTracking(
    input: AddTrackingCommand,
    signal?: AbortSignal,
  ): Promise<MutationResult>;
  markShipped(
    input: MarkShippedCommand,
    signal?: AbortSignal,
  ): Promise<MutationResult>;
}

interface RefundProvider {
  getRefundCapabilities(
    ref: ProviderOrderRef,
    signal?: AbortSignal,
  ): Promise<RefundCapabilities>;
  refund(input: RefundCommand, signal?: AbortSignal): Promise<MutationResult>;
}

interface NativeOrderDocumentSource {
  getDocument(
    input: NativeDocumentRequest,
    signal?: AbortSignal,
  ): Promise<FulfillmentDocument>;
}

interface PullLineReader {
  getPullLines(
    refs: readonly ProviderOrderRef[],
    signal?: AbortSignal,
  ): Promise<readonly PullLine[]>;
}

interface InventoryReader {
  /* normalized inventory pagination */
}
interface InventoryMutator {
  /* explicit normalized mutations */
}
interface CatalogMetadataReader {
  /* optional batched enrichment */
}
```

Mutation inputs always carry `ProviderOrderRef`; mutation results echo that ref
and classify `applied`, `already-applied`, or `review-required`. Remote
mutations never retry automatically after an uncertain response.

## Normalized order data

### Money

New domain and transport contracts represent money as safe integer minor units:

```ts
interface Money {
  readonly currency: string; // uppercase ISO 4217 code
  readonly minorUnits: number; // Number.isSafeInteger
}
```

Arithmetic requires matching currency. Aggregates with different currencies
remain separate totals. UI formatting converts minor units only at the display
boundary. Existing major-unit number contracts remain temporary compatibility
projections and are not used by new provider adapters.

### Summary and detail

Normalized summaries and details contain:

- `ProviderOrderRef` and provider-supplied display order number;
- `providerStatus` and normalized `OrderLifecycle`;
- creation timestamp and shipping method label;
- explicit-currency totals;
- normalized recipient and postal address on detail;
- normalized lines with quantity, money, stable `lineKey`, display attributes,
  and catalog identities;
- tracking and fulfillment facts;
- resolved action availability.

Every detail line has a stable `lineKey`. An adapter uses a provider line ID
when available. Otherwise it deterministically derives a key from exact variant
identities and fulfillment-relevant attributes, combines duplicate equivalent
lines within the same order, and contract-tests stability across repeated
reads. Array position is not a stable line key.

Catalog identities are namespaced and declare precision:

```ts
interface CatalogIdentity {
  readonly namespace: string;
  readonly value: string;
  readonly precision: "exact-variant" | "product";
}
```

Examples include exact TCGplayer SKU, Scryfall printing, MTGJSON UUID,
TCGplayer product, and provider product ID. Core code does not give one catalog
vendor privileged status.

## Adapter and connection registry

The initial implementation has two layers of registration.

1. `ProviderAdapterRegistry` is built at compile time from installed adapter
   factories keyed by `providerId`.
2. `MarketplaceConnectionRegistry` instantiates enabled configured connections
   through those factories and exposes their immutable descriptors and facets.

```ts
interface ProviderAdapterFactory {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly supportedFacets: readonly string[];
  create(context: ProviderFactoryContext): MarketplaceConnection;
}

interface ProviderFactoryContext {
  readonly connectionId: string;
  readonly connectionLabel: string;
  readonly settings: unknown;
  readonly secrets: ProviderSecretAccess;
  readonly now: () => Date;
}

interface ConnectionHealthProbe {
  checkHealth(signal?: AbortSignal): Promise<ConnectionHealth>;
}

interface MarketplaceConnection {
  readonly descriptor: MarketplaceConnectionDescriptor;
  readonly health: ConnectionHealthProbe;
  readonly facets: MarketplaceFacets;
}

interface MarketplaceFacets {
  readonly orderPages?: OrderPageReader;
  readonly orderDetails?: OrderDetailReader;
  readonly fulfillment?: FulfillmentMutator;
  readonly refunds?: RefundProvider;
  readonly nativeDocuments?: NativeOrderDocumentSource;
  readonly pullLines?: PullLineReader;
  readonly inventoryReader?: InventoryReader;
  readonly inventoryMutator?: InventoryMutator;
  readonly catalogMetadata?: CatalogMetadataReader;
}
```

`MarketplaceFacets` is a typed collection of independently optional narrow
facets. It is assembled once and immutable. Generic services request a facet by
connection ID through the registry; they never inspect provider ID.

The adapter factory validates its unknown settings before constructing a
connection. `ProviderSecretAccess` resolves only named server-side secret
references; factories do not read browser state or return secret values.
`ConnectionHealthService` owns the 30-second cache and calls the adapter's
uncached, read-only probe. A separate connection-status projection includes
disabled configured connections using the factory descriptor and static
`supportedFacets`; the active connection registry instantiates enabled
connections only.

The registries must:

- reject invalid and duplicate provider or connection IDs;
- reject an enabled connection whose adapter is not installed;
- expose immutable descriptors and static facet support;
- resolve a qualified reference to exactly one enabled connection;
- report health independently from facet support;
- avoid browser, HTTP, persistence, and printing concerns;
- support synthetic in-memory adapters without network or secrets.

Adding a provider normally requires an API package, adapter modules, one
composition-root factory registration, namespaced configuration, and contract
tests. It does not require generic order route or page changes.

## Derived documents and printing

Address labels and packing slips are application features.

`OrderDocumentService` receives normalized order detail. For packing slips it
uses this deterministic policy:

1. If the connection has a native document facet, request and validate a
   document for the exact qualified order.
2. If native retrieval reports the explicit `unsupported` capability result,
   use the local renderer.
3. Authentication, network, malformed-response, or wrong-order failures do not
   silently fall back; they remain visible provider failures.
4. When no native facet exists, render locally.

The local packing slip contains an application-generated heading, connection
label, display order number and date, ship-to address, line descriptions,
variant attributes, quantities, unit/line totals, subtotal, shipping, tax when
available, and total. Missing optional fee or tax breakdown never invents
values. It does not claim to be an official marketplace invoice.

Address labels always render from the normalized postal address. Pirate Ship
handoff uses the same normalized address and remains a local explicit action.

Printing accepts typed document bytes or a render model and never calls a
marketplace SDK. Downloading and printing use the same document service.
Document bytes and customer data remain in memory and are never logged or
persisted.

## Combined master pull list

`MasterPullListService` consumes normalized ready-order details from all
healthy order connections. It must not call a provider SDK.

An optional `PullLineReader` adapter may efficiently produce normalized lines
and qualified allocations, such as TCGplayer's native multi-order export. When
absent, the service derives pull lines from normalized order details.

Each order line contributes this allocation identity:

```ts
interface PullAllocationRef {
  readonly order: ProviderOrderRef;
  readonly lineKey: string;
}
```

Lines merge into connected components when they share any identical
`CatalogIdentity` marked `exact-variant`. An adapter may mark an identity exact
only when it distinguishes every sellable variant attribute relevant to
fulfillment, including language, condition, and finish where applicable. A
Scryfall printing ID or product ID alone is therefore normally product-level,
while an exact marketplace SKU can be exact-variant. Product-level IDs, names,
set/number text, condition text, and fuzzy matches never merge lines. The
stable displayed row key is the lexicographically smallest exact-identity token
in the component; durable progress remains allocation-based and does not depend
on that row key. Conflicting variant attributes inside one component fail that
component rather than silently combining it.

The existing grouping, binning, foil emphasis, sorting, printing, and optional
metadata behavior remain generic. Enrichment is batched through registered
catalog readers and may use any namespaced identity. Enrichment failure returns
the operational list with a connection-scoped warning.

Pull progress schema version 2 stores only:

- `connectionId`;
- remote order ID;
- stable line key;
- pulled quantity;
- timestamp.

The v1 migration qualifies existing entries with the migrated TCGplayer
connection. Customer and product descriptions remain out of durable state.

## Synchronization and automation

`MarketplaceSyncCoordinator` discovers enabled order connections and runs each
under one coalesced overall synchronization request. Each connection gets an
independent complete page walk, baseline, reconciliation result, and issue.
Connection work runs concurrently up to
`providers.synchronizationConcurrency`, which defaults to 2 and is bounded from
1 through 8. Page reads inside one connection remain sequential.

The overall result is:

```ts
interface AggregateResult<T> {
  readonly data: T;
  readonly issues: readonly ProviderIssue[];
  readonly completedAt: string;
}

interface ProviderIssue {
  readonly connectionId: string;
  readonly operation:
    | "health"
    | "list-orders"
    | "get-order"
    | "document"
    | "pull-lines"
    | "tracking"
    | "mark-shipped"
    | "refund"
    | "inventory";
  readonly code: string;
  readonly retryable: boolean;
}
```

Provider issues contain no remote values. Successful connection data remains
usable. A scheduled synchronization records `partial` when any connection
fails and does not advance the failed connection's baseline or reconciliation
checkpoint.

Rules evaluate each discovered qualified order independently. Idempotency keys
include `orderRefKey`. Scanner matches, shipment ledgers, notification events,
and audit records use the same identity. No background path assumes a
TCGplayer session is a global prerequisite.

## HTTP behavior

New detail and mutation endpoints use connection-qualified paths:

```text
GET  /api/marketplace-connections
GET  /api/orders
GET  /api/orders/ready
POST /api/orders/sync
GET  /api/connections/{connectionId}/orders/{remoteId}
POST /api/connections/{connectionId}/orders/{remoteId}/tracking
POST /api/connections/{connectionId}/orders/{remoteId}/mark-shipped
GET  /api/connections/{connectionId}/orders/{remoteId}/packing-slip
```

Both path segments use strict validation and URL decoding exactly once.
Mutations retain the existing same-origin and content-type protections.

Aggregate endpoint semantics are fixed:

- Return `200` with data and issues when at least one eligible connection
  succeeds, including a healthy empty result.
- Return `503` with only safe provider issues when eligible connections exist
  but all fail.
- Return `503` with `NO_ORDER_CONNECTIONS` when no enabled connection supplies
  the required facet.
- Never report an aggregate request as fully healthy while omitting a failed
  configured connection.

An eligible connection is enabled and supplies the required facet. Before a
provider call, the service reads cached health. `connected` and `degraded`
connections are attempted. A stale or `checking` state triggers one bounded
health refresh. `authentication-required`, `not-configured`, and `unavailable`
connections are not called and contribute a safe issue. Disabled connections
remain visible in connection status but are neither called nor counted as
aggregate failures.

Direct detail or mutation endpoints return the selected connection's typed
error. An unknown or disabled connection is `404`; unsupported facet or action
is `409`; authentication-required is `401`; configuration unavailable is
`503`.

Package 9 removed the legacy unqualified TCGplayer endpoints and hashes and the
spike-era `provider=manapool` query/hash forms. Server and browser navigation now
accept and emit only connection-qualified paths. There is no implicit default
connection at an order boundary.

## Browser behavior

The server supplies connection descriptors, health, static facet support, and
per-entity actions. Browser decoders validate them at runtime. The browser has
no provider union, provider-label switch, or hard-coded connection prerequisite.

Target order hashes use:

```text
#orders/{connectionId}/{remoteId}
```

Orders and pull allocations use qualified keys in component state. Connection
badges display `connectionLabel`; provider label remains available as secondary
context. The Orders and Dashboard workspaces show partial provider issues
without hiding successful data.

Optional workspaces appear when at least one enabled connection exposes their
facet. A workspace may offer a connection filter. Payments, messages, and
feedback remain connection-scoped until a sound cross-provider normalized
model is explicitly accepted.

## Configuration and secrets

Configuration version 6 replaces the singular `provider` object with a
connection map:

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
          "pageSize": 100,
          "maximumPages": 100,
          "authCookieEnv": "TCGPLAYER_AUTH_COOKIE",
          "sellerKeyEnv": "TCGPLAYER_SELLER_KEY"
        }
      },
      "manapool-main": {
        "providerId": "manapool",
        "enabled": true,
        "label": "ManaPool",
        "settings": {
          "pageSize": 100,
          "maximumPages": 100,
          "emailEnv": "MANAPOOL_EMAIL",
          "accessTokenEnv": "MANAPOOL_ACCESS_TOKEN"
        }
      }
    }
  }
}
```

Each adapter validates its namespaced settings and resolves its own secret
references through connection-scoped server-side secret access. API
credentials entered in Connections are encrypted with OS-protected storage and
apply immediately. Environment variables remain only as a test/development
fallback. Credential values are accepted by a loopback-only write route but
are never returned to the browser, stored in browser state, or placed in
descriptors, health data, logs, configuration, or durable workflow state.

The environment-independent v5 configuration migration creates one qualified
connection from the existing singular provider settings and preserves the
configured environment-variable names. Package 9 removed the temporary
ManaPool environment overlay. Every additional connection is now explicit in
version-six configuration, and configuration previews/examples never include
credential values.

The Add cards workspace always displays its qualified destination connection.
Catalog, product, preview, and queue requests carry that connection ID, and
the server rejects a destination that is not the one backing the current
catalog workflow. A new provider must supply a connection-scoped catalog
workspace before it can advertise this route; it cannot inherit another
provider's listing service.

## Durable-state migration ledger

All migrations validate old data, transform in memory, and atomically write the
new version on the next successful save. They do not discard invalid state or
silently start empty.

| State document           | Current | Target | Migration                                                                                                                                          |
| ------------------------ | ------: | -----: | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application workflow     |       1 |      2 | Qualify order keys with `tcgplayer-main`; replace global baseline with per-connection baselines; add `partial` sync outcome                        |
| Pull progress            |       1 |      2 | Qualify order and line allocations with `tcgplayer-main`                                                                                           |
| Shipment tag assignments |       2 |      3 | Qualify assignment keys and hash input while preserving assigned tag IDs                                                                           |
| Shipment scan mutations  |       1 |      2 | Qualify records with `tcgplayer-main` and preserve review-required recovery                                                                        |
| Notification state       |       1 |      2 | Qualify ready-order observations; transform parseable `order-canceled` keys; preserve random shipment keys; retain messages under `tcgplayer-main` |

In-memory caches require no migration. Browser pull-list sort preference remains
valid. Old unqualified durable writes are forbidden as soon as the owning
module migrates.

## Module and dependency boundaries

The target ownership is:

```text
src/marketplaces/
  contracts.ts          pure normalized contracts
  identity.ts           validation and canonical keys
  registry.ts           adapter and connection registries
  health.ts             cached health projection
  order-query.ts        pagination, aggregation, cache, provider issues
  order-actions.ts      capability resolution and mutation routing

src/providers/tcgplayer/
  factory.ts            composition and settings validation
  orders.ts             TCGplayer normalization and order facets
  documents.ts          optional native documents and pull export
  inventory.ts          optional inventory facets
  ...                   other provider-only facets

src/providers/manapool/
  factory.ts
  orders.ts
  inventory.ts

src/fulfillment/
  documents.ts          local/native document policy
  packing-slip.ts       local render model and PDF renderer
  pull-list.ts          combined normalized list
  synchronization.ts    multi-connection coordinator
```

Provider API packages may be imported only from `src/providers/<providerId>/`
and temporary compatibility files explicitly listed during migration. ESLint
`no-restricted-imports` rules enforce this after the TCGplayer adapter is moved.
Domain and application modules do not import provider adapters. Provider
factories depend inward on normalized contracts.

Tests follow the same boundary:

- pure contract and application tests use synthetic adapters;
- each provider adapter has sanitized normalization and transport contract
  fixtures;
- route and browser tests use the registry with synthetic connections;
- live compatibility remains opt-in, read-only, and outside the normal suite.

## Current implementation gaps

The current ManaPool spike proves connectivity and manual order fulfillment,
but it is not the target architecture.

| Area                       | Current coupling or gap                           | Target                                                  |
| -------------------------- | ------------------------------------------------- | ------------------------------------------------------- |
| Provider identity          | Closed two-provider union                         | Installed provider types plus configured connection IDs |
| Status                     | TCGplayer SDK enum in shared order code           | Application lifecycle plus raw provider status          |
| Money                      | Major-unit numbers without currency               | Integer minor units and explicit currency               |
| Runtime                    | Named TCGplayer and ManaPool services             | Connection registry and generic application services    |
| Routes                     | Explicit ManaPool branches and TCGplayer defaults | Qualified registry lookup                               |
| Browser                    | Provider switches and TCGplayer connection gates  | Descriptor and action-driven UI                         |
| Health                     | ManaPool client construction means connected      | Cached read-only health check                           |
| Address labels             | ManaPool disabled                                 | Local normalized-address rendering                      |
| Packing slips              | TCGplayer provider PDF only                       | Native-or-local document service                        |
| Pull list                  | TCGplayer export and unqualified progress         | Combined lines and qualified allocations                |
| Background sync            | TCGplayer ready source                            | Independent registered connection readers               |
| Scanner                    | TCGplayer order-number identity                   | Qualified combined ready queue                          |
| Inventory                  | ManaPool client exists but UI is TCGplayer-only   | Optional inventory facets and connection-aware UI       |
| Refunds                    | ManaPool API exposes no mutation                  | Unavailable until an authorized facet exists            |
| Payments/messages/feedback | TCGplayer-only services                           | Optional connection facets, not core prerequisites      |

## Implementation work packages

Every package ends with formatting, lint, type checks, focused tests, full tests,
and a review of durable compatibility. Do not combine all packages into one
rewrite.

### Package 0: Characterization and enforcement

- Add synthetic-provider fixtures and characterize current TCGplayer-only,
  ManaPool-only, simultaneous, partial-failure, and duplicate-label behavior.
- Add a temporary allowlist documenting every provider SDK import outside the
  target adapter folders; shrink it in each later package.
- Record legacy route, hash, and state fixtures used by migration tests.
- Stop adding new provider-name branches.

Exit: current behavior and every legacy schema to migrate have fail-safe
fixtures.

### Package 1: Identity, lifecycle, money, and contracts

- Add `src/marketplaces/contracts.ts` and `identity.ts` with runtime validation.
- Introduce connection-qualified refs, lifecycle mapping target types, money,
  catalog identities, health, actions, and provider issues.
- Add canonical key round-trip and hostile-input tests.
- Keep compatibility projections so no production route changes yet.

Exit: the new contracts contain no provider imports and can represent all
sanitized TCGplayer and ManaPool fixtures without data loss.

### Package 2: Registry and synthetic vertical slice

- Implement both registries and facet lookup.
- Add configuration version 6, its v5 migration, and the temporary ManaPool
  environment compatibility overlay.
- Add synthetic read-only, mutable, failing, and third-provider adapters.
- Implement generic complete pagination and aggregate issue semantics.
- Exercise one internal aggregate order query without changing public routes.

Exit: a third synthetic connection is added through registration and
configuration only, and generic code handles duplicate display order numbers
correctly.

### Package 3: TCGplayer adapter migration

- Move TCGplayer order normalization, status mapping, pages, detail,
  fulfillment, native documents, and pull export into provider adapter modules.
- Split generic caching, action policy, pull projection, and document dispatch
  out of `OrderManagementService`.
- Register `tcgplayer-main` and preserve current behavior through compatibility
  facades.
- Enable import-boundary lint enforcement for migrated modules.

Exit: removing TCGplayer registration leaves generic services valid, and no
generic order module imports `tcgplayer-private-api`.

### Package 4: ManaPool migration and generic HTTP/UI

- Rework the ManaPool spike as the same order and fulfillment facets.
- Replace named route-context services and provider branches with registry
  lookup and aggregate services.
- Add provider descriptors, cached health, static facets, per-order actions,
  and partial issues to server and browser contracts.
- Emit qualified routes and keep legacy TCGplayer translations.

Exit: real TCGplayer and ManaPool plus a synthetic third provider use unchanged
generic order routes and pages.

### Package 5: Generic documents and printing

- Add normalized address-label and packing-slip render models.
- Put TCGplayer native packing-slip retrieval behind its optional facet.
- Add the local PDF renderer and use it for ManaPool.
- Route download, manual print, and workflow print actions through
  `OrderDocumentService`.

Exit: either real provider can download and print a packing slip and print an
address label without provider checks outside adapters.

### Package 6: Combined master pull list

- Move pull grouping, binning, progress, and projection into generic modules.
- Adapt TCGplayer native export to `PullLineReader`; derive ManaPool lines from
  normalized detail.
- Implement exact-identity merging and provider-qualified allocations.
- Migrate pull progress v1 to v2 and expose one printable list with issues.

Exit: simultaneous ready orders merge only when exact, and shipping one order
removes only its allocation.

### Package 7: Durable workflow and scanner migration

- Migrate workflow, scanner, shipment tags, and notification schemas according
  to the ledger.
- Synchronize enabled connections independently with per-connection baselines.
- Route rules, actions, scanner matches, shipment reconciliation, and
  notifications through qualified refs.
- Remove the global TCGplayer-session prerequisite from unrelated work.

Exit: scheduled and scanner workflows operate with either connection alone or
both, and failed connections neither block nor appear successful.

### Package 8: Inventory and optional workspaces

- Define normalized inventory facets and a connection-aware inventory UI.
- Migrate existing TCGplayer behavior, then connect ManaPool inventory.
- Expose payments, messages, feedback, refunds, and future features from
  connection facets only where normalized semantics are sound.

Exit: optional pages and controls come from capabilities and are not
prerequisites for the order workflow.

### Package 9: Compatibility removal and authoring guide

- Remove old unqualified endpoints, closed provider unions, named service
  fields, compatibility projections, and temporary import allowlists after
  supported callers migrate.
- Update superseded ADR language, README, configuration examples, and operator
  documentation.
- Add a provider-authoring guide and sanitized adapter contract-test template.

Exit: provider names occur in provider adapters, adapter registration,
provider-specific tests and copy, and configuration examples—not generic order,
fulfillment, route, or browser control flow.

## Required acceptance scenarios

Implementation is complete only when automated tests cover:

1. TCGplayer configured alone.
2. ManaPool configured alone.
3. Two accounts on one provider with duplicate remote and display IDs.
4. Both providers with overlapping exact products in the ready queue.
5. A synthetic third provider with no generic route or order-page edits.
6. One connection unauthenticated while another remains operational.
7. One connection failing midway through pagination without erasing healthy
   data or advancing its checkpoint.
8. All eligible connections failing with the defined aggregate `503` response.
9. Local and provider-native packing-slip generation and wrong-document
   rejection.
10. Qualified tracking and shipment mutations for duplicate display numbers.
11. Combined pull progress surviving restart without cross-connection
    collision.
12. Product-level or fuzzy identities refusing to merge pull rows.
13. Scanner and scheduled synchronization routing the exact qualified order.
14. A read-only connection with no mutation controls.
15. Every v5, v1, and v2 durable migration in the migration ledger.
16. Malformed descriptors, refs, money, capabilities, and issues rejected by
    browser decoders without exposing values.
17. No credential, customer, document, or raw response values in logs,
    persisted state, health, or provider issues.

## Implementation guardrails

- Do not add another provider branch as an interim shortcut.
- Do not move provider SDK types into generic contracts to make adapters easier.
- Do not replace stable remote IDs with display labels.
- Do not make native packing-slip or pull-export endpoints mandatory provider
  capabilities.
- Do not silently drop provider errors from aggregate results.
- Do not migrate durable keys without a tested backward reader and atomic write.
- Do not delete compatibility paths until their consumers and migration tests
  are gone.
- Do not perform live provider mutations as part of compatibility testing.

## Consequences

This migration does more foundational work before feature parity, but it
prevents each marketplace or seller account from becoming another parallel
application. TCGplayer becomes the first adapter rather than the implicit
domain. ManaPool becomes the second adapter rather than a special case. Local
documents and pull-list composition become reusable product capabilities.

The registries and normalized contracts add explicit abstraction, but make
health, partial failure, identity, optional capabilities, and multiple accounts
testable. Small work packages preserve mature printing, fulfillment,
pull-progress, and reconciliation behavior while moving their ownership to the
correct layers.

## Shared read capabilities and optional workspaces

Read-only facets are application capabilities, not private helpers for the
connection that owns them. The master pull-list service may batch the combined
set of catalog identities through every enabled catalog-metadata reader and
apply returned attributes to any matching pull line. This lets one catalog
source restore color, card type, and bin inputs for another marketplace without
either adapter importing or calling the other. A metadata-reader failure is a
safe partial issue and never removes otherwise usable pull lines.

Provider-specific operator workspaces remain separate components selected from
static facet support. The Inventory route composes authoritative local stock
with an optional repricing workspace when any configured connection advertises
the repricing facet. Local inventory does not inherit repricing behavior, and
adding a provider without that facet does not expose unsupported mutations.

## Local inventory follow-on

[ADR 0033](0033-local-inventory-ledger.md) supersedes this ADR's original
Inventory-page mutation workflow and the later Add Cards listing-destination
checkpoint. Provider inventory facets remain the normalized boundary for
reading remote listings and for future explicit provider commands, but remote
listing quantities are not application stock authority.

The implemented Inventory page edits durable local `onHand` stock and renders
provider listings as read-only observations. Add Cards uses a capable
connection only as a catalog metadata source. Neither workflow publishes,
cross-posts, mirrors, or mutates marketplace inventory. Any future publication
or shared-stock synchronization requires its own decision record and safety
model.
