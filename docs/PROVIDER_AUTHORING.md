# Provider authoring guide

This guide is the implementation contract for adding a marketplace without
editing generic order, fulfillment, HTTP, or browser control flow.

## 1. Choose a provider ID and connection settings

Use a lowercase slug accepted by `parseProviderId`. A provider ID identifies
the adapter type; a connection ID identifies one configured seller account.
Never use the provider ID or a display order number as an account-level key.

Define and validate a provider-owned settings object in
`src/providers/<providerId>/factory.ts`. Settings contain non-secret secret
references, paging limits, and behavior flags, never credential values.
Retrieve secrets only through `ProviderFactoryContext.secrets`; protected
Settings values take precedence and environment values are a test/development
fallback.

For API-key credentials, return a `managed-credentials` setup descriptor with
generic field IDs, labels, input types, and secret references. The shared
Connections UI and local credential routes will then save them in
OS-protected storage without adding provider-specific browser code. Never
retain credentials in descriptors, issues, normalized entities, logs, HTTP
responses, or browser storage.

## 2. Implement a factory

Export one `ProviderAdapterFactory` with:

- a stable open `providerId` and human-readable `providerLabel`;
- the exact unique `supportedFacets` the installed adapter can create; and
- a `create(context)` method that returns the context's connection ID and label,
  a bounded health probe, and only the supported facet objects.

The descriptor returned by `create` must exactly match the factory and context.
Register the factory only in the composition root in `src/runtime.ts`. Do not
import a provider adapter from a domain service, route, or web page.

## 3. Normalize at the adapter boundary

Provider SDK types stop under `src/providers/<providerId>/`. Convert them into
the contracts in `src/marketplaces/contracts.ts` before returning:

- `ProviderOrderRef` always contains `connectionId` and opaque `remoteId`.
- Money uses uppercase currency and safe integer minor units.
- Preserve the provider's display status while mapping a conservative
  application lifecycle. Unknown statuses map to `unknown`.
- Every order action has explicit availability. Static adapter capability does
  not imply that a particular order currently allows a mutation.
- Line keys and inventory keys must be stable and unique within their owning
  connection/entity.
- Catalog identities state their namespace and precision. Merge pull-list rows
  only when an exact shared identity proves equivalence.

Call the contract parsers on adapter outputs. Invalid or cross-connection data
must fail closed before it reaches a generic cache or mutation service.

## 4. Add only real facets

Core facets are independent:

- `orderPages` and `orderDetails` for reads;
- `fulfillment` for tracking and shipment mutations;
- `inventoryReader` and `inventoryMutator` for inventory;
- `nativeDocuments`, `pullLines`, and `catalogMetadata` as optional enrichments;
- `refunds` only when the remote API supports a safe, confirmable mutation.

The application can generate an address label and packing slip from normalized
order detail, and can derive pull rows from normalized lines. A provider does
not need native packing-slip or bulk pull-export endpoints.

Account workspaces (`catalog-search`, `repricing`, `payments`, `messages`, and
`feedback`) are optional markers until a cross-provider contract exists. They
must remain connection-scoped and must not become global authentication gates.

## 5. Pagination, health, and failures

- Treat cursors as opaque, validate page size, bound maximum pages, and reject
  repeated cursors.
- Honor `AbortSignal` for every remote read and mutation.
- Health probes are read-only, bounded, and safe to cache. Missing credentials
  return `not-configured`; authentication rejection returns
  `authentication-required`; transient remote failure returns `unavailable` or
  `degraded` with a safe code.
- Aggregate reads preserve successful connections and return sanitized
  `ProviderIssue` values for failures. They return an aggregate failure only
  when every eligible connection fails.
- Never expose response bodies, tokens, email addresses, buyer data, or SDK
  exception text as a provider issue.

## 6. Mutation rules

- Require a qualified reference or inventory key plus connection ID.
- Reconfirm current remote state when the mutation's safety depends on it.
- Use idempotency keys when the provider supports them.
- Never automatically retry a timeout, disconnect, or lost mutation response.
  Return `review-required` when the remote outcome is uncertain.
- Return `already-applied` only from authoritative remote evidence.
- Validate that a provider result belongs to the requested connection and
  entity before invalidating generic caches.

## 7. Required tests

Copy `docs/templates/provider-adapter.contract.test.ts` into
`test/providers/<providerId>-contract.test.ts` and replace only the factory and
sanitized fixtures. Add provider-specific transport tests beside it.

The contract suite must cover:

1. descriptor/factory identity and exact facet declaration;
2. missing credentials and healthy credentialed status without live secrets;
3. normalized list/detail identity, money, actions, and unknown status behavior;
4. bounded pagination, cursor rejection, cancellation, and safe errors;
5. wrong-connection or wrong-entity responses failing closed;
6. mutation `applied`, `already-applied`, and uncertain `review-required` paths;
7. duplicate remote/display IDs across two configured accounts;
8. use through the generic registry, query/action/inventory services, and HTTP
   routes without adding a provider branch; and
9. no real provider calls, secrets, customer data, or document bytes in fixtures.

Run `npm run check`. The architecture test rejects new provider SDK imports and
provider-name branches outside the reviewed boundary.

## Registration checklist

- [ ] Factory and adapter live under `src/providers/<providerId>/`.
- [ ] No generic contract imports an SDK type.
- [ ] Configuration contains secret references only; credential values use
      protected Settings storage.
- [ ] Descriptor and every returned reference use the configured connection ID.
- [ ] Facets and `supportedFacets` agree exactly.
- [ ] Reads validate and normalize all provider data.
- [ ] Health and issues are sanitized and retryability is explicit.
- [ ] Mutations fail closed on uncertain outcomes.
- [ ] Contract, transport, aggregate, HTTP, and dual-account tests pass.
- [ ] README/config examples and dependency records are updated.
