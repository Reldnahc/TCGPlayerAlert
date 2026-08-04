# AGENTS.md

## Purpose

This repository will contain a provider-agnostic automation service for TCGplayer seller fulfillment. Its core workflow is:

1. Receive a scheduled or operator-requested synchronization signal.
2. Discover the complete authoritative ready-to-ship order queue through the separately maintained unofficial TCGplayer seller API client.
3. Reconcile discovered orders against durable workflow state, confirm unseen orders, and retrieve their packing slips.
4. Convert the result into stable internal domain objects.
5. Evaluate user-configurable rules.
6. Dispatch one or more independently configurable actions, such as printing a shipping-address label or printing a packing slip.

The product must remain useful beyond one seller, scheduling cadence, operating system, printer, or workflow. Hourly polling is the initial default and the DYMO-label/network-printer workflow is the first action set, not assumptions that may leak into the domain model. Email may be added later as an optional wake-up adapter, but it is not part of the initial workflow.

## Current Phase

Application implementation is authorized and active. Build the local-first polling service, durable reconciliation, versioned declarative rules, and modular print actions defined by ADRs 0001 and 0002. Keep remote mutations opt-in and out of the initial automatic workflow until a newly received order is available for supervised compatibility testing.

The accepted order-discovery design is recorded in `docs/adr/0001-polling-first-order-discovery.md`.

## Product Principles

- Treat schedules, manual requests, and optional future notifications only as synchronization signals. TCGplayer is the authoritative order source.
- Design around capabilities and interfaces, not named vendors. Vendor-specific behavior belongs in adapters.
- Make actions composable. A rule may invoke zero, one, or many actions, and adding a new action must not require editing synchronization or TCGplayer integrations.
- Keep the first use case simple without hard-coding it. Default configurations may be opinionated; core behavior may not be personal.
- Prefer a small, dependable service over adopting the referenced application's full web/database/deployment stack.
- Make repeated processing safe. Scheduled polling, manual synchronization, API retries, restarts, and overlapping signals must not print or act twice unless a user explicitly requests a replay.
- Preserve an auditable trail of decisions without retaining more customer data than necessary.

## Intended Boundaries

Keep these concerns separated even if the first version runs as one process:

- **Synchronization triggers:** configurable schedules and an operator-requested `Sync now` capability that enter the same orchestration path.
- **Order discovery:** complete pagination of the authoritative ready-to-ship queue, first-run baseline behavior, and reconciliation against durable state.
- **Optional event acceleration:** future provider adapters may interpret notifications and request an immediate sync, but may not directly create authoritative orders or dispatch actions.
- **TCGplayer access:** an application-facing adapter around the separately versioned `tcgplayer-private-api` client. Private endpoint details do not belong in this repository.
- **Domain and orchestration:** provider-neutral orders, documents, events, rules, idempotency, retries, and workflow state.
- **Rules:** declarative conditions and action selection, with validation and explainable evaluation results.
- **Actions:** plugins that consume domain data or documents and produce side effects.
- **Printing:** printer discovery/selection, rendering, job submission, and job-result reporting behind a print interface.
- **Configuration and secrets:** validated non-secret configuration separated from credentials and session material.
- **Persistence:** the smallest durable store that safely supports cursors, deduplication, job state, and audit history.

Initial adapters are expected to include:

- A configurable scheduler with a 60-minute default interval and an operator-requested `Sync now` entry point.
- A TCGplayer seller adapter that depends on the narrow public contract exposed by `Reldnahc/tcgplayer-private-api`.
- A DYMO-compatible address-label action.
- A generic packing-slip print action capable of targeting an operating-system or network printer.

Do not let those initial adapters define the public contracts for future providers or actions.

## API Repository Boundary

The unofficial seller API integration is maintained separately at:

- <https://github.com/Reldnahc/tcgplayer-private-api>

This application repository owns scheduling, manual synchronization, reconciliation, optional event accelerators, domain orchestration, rules, actions, printing, user configuration, and end-to-end workflow state. The API repository owns only TCGplayer seller authentication/session behavior, private endpoint transport, response validation, order retrieval, and packing-slip retrieval.

- Consume the API client only through its documented npm package exports.
- Use a released semantic version for normal builds. Local adjacent-repository development may use an npm-managed `file:../tcgplayer-private-api` dependency or a packed tarball.
- Never import files directly from `../tcgplayer-private-api/src` or depend on the package repository's internal layout.
- Keep seller credentials and sessions in server-side application code; do not bundle the private API client into browser-delivered code.
- Depend on a released/versioned API-client contract rather than copying its implementation into this repository.
- Keep TCGplayer-specific payloads and endpoint details behind the application adapter.
- Do not add email, rules-engine, UI, printer, or application-persistence behavior to the API repository.
- Do not add reverse-engineered endpoint implementations directly to this application repository.
- Coordinate breaking changes through explicit versions and compatibility tests.

## Upstream Reference and Provenance

The primary behavioral implementation reference for the separate API repository is:

- <https://github.com/todd-skelton/tcgplayer-automation-app>

Research and source reuse based on this reference belong in `tcgplayer-private-api`. Use only the narrow seller-authentication, order, and packing-slip behavior needed by this application. Do not import the upstream application's whole stack.

Before copying or adapting upstream source:

1. Verify the license and any applicable permission for the exact revision being used. A public repository is not automatically licensed for reuse.
2. Record the upstream repository, commit SHA, source paths, license, and the nature of local modifications.
3. Preserve required copyright and attribution notices.
4. Prefer a clean, isolated adapter informed by documented behavior when direct source reuse is not clearly permitted.
5. Never copy upstream secrets, captured sessions, customer data, generated artifacts, or environment files.

The seller interface is private and may change without notice. Keep reverse-engineered request details inside the separate API client and its application adapter, document assumptions, add contract fixtures with sensitive data removed, and fail safely when remote behavior changes. Review applicable TCGplayer agreements and policies before distributing or operating the integration. Do not bypass access controls, defeat security mechanisms, or access data the authenticated seller is not authorized to access.

## Architecture Rules

- Domain code must not import provider SDKs, printer SDKs, web frameworks, database clients, or operating-system print APIs.
- The application may import the private API client only by its npm package name and declared export paths.
- Adapters may depend inward on domain/application contracts; domain/application layers must not depend outward on adapters.
- Model integrations with narrow interfaces and capability-oriented names. Avoid catch-all service classes.
- Normalize provider data at the boundary. Do not pass raw notification messages or raw TCGplayer responses throughout the application.
- Represent external documents as typed metadata plus bytes/streams; do not assume every packing slip is a filesystem path or PDF until verified.
- Side effects must accept an idempotency key and return a structured result.
- Persist discovered-order and intended-action state before side effects when doing so is required to prevent loss or duplication.
- Put time, randomness, filesystem access, networking, and printing behind injectable boundaries so tests remain deterministic.
- Prefer configuration over conditionals for user-specific rules, printers, labels, and routing.
- Version persisted schemas, rule formats, and plugin contracts from their first durable release.
- Make unsupported capabilities explicit; never silently degrade a requested print or fulfillment action.

## Security and Privacy

- Never commit credentials, email addresses used as credentials, passwords, OAuth refresh tokens, cookies, API/session tokens, private keys, customer addresses, packing slips, or real email bodies.
- Do not hard-code a personal mailbox, seller identity, printer name, IP address, or network path. Supply them through local configuration or secret storage.
- Keep `.env*`, credential stores, captured HTTP traffic, downloaded messages, generated packing slips, print spools, and local databases out of Git unless they are sanitized examples explicitly intended for source control.
- If a notification-provider adapter is added, use least-privilege scopes and read-only access wherever the workflow allows it.
- Encrypt sensitive data in transit and use the platform's protected secret storage at rest when available.
- Redact secrets and customer PII from logs, errors, metrics, test snapshots, and bug reports.
- Give retained customer data an explicit purpose and retention period. Prefer identifiers, hashes, and minimal metadata over raw content.
- Treat message content, API responses, filenames, rule definitions, and printer metadata as untrusted input. Validate sizes, formats, and identifiers.
- Connectivity tests must not mutate notification-provider messages, change orders, or print documents.
- Require an explicit opt-in for actions that mutate remote state or incur cost.

## Reliability Requirements

- Use stable event/order identifiers and a durable idempotency record to prevent duplicate actions.
- On first synchronization, establish a baseline without dispatching actions for existing orders unless the operator explicitly chooses to process the backlog.
- Page through the complete ready-to-ship result set before declaring a synchronization successful.
- Prevent concurrent synchronization runs from racing; coalesce or serialize overlapping scheduled and manual requests.
- Keep the polling interval configurable with a 60-minute default, and expose the same workflow through a manual `Sync now` operation.
- Classify failures as retryable, permanent, authentication-related, configuration-related, or user-action-required.
- Use bounded retries with exponential backoff and jitter for transient network failures.
- Never retry printer submissions blindly after an ambiguous result; reconcile job state or require operator review.
- Preserve enough state to resume safely after a crash.
- Quarantine malformed or unrecognized events for inspection without blocking unrelated work.
- Validate that a packing slip belongs to the confirmed seller order before dispatching actions.
- Support a dry-run mode that evaluates and explains rules without causing side effects.
- Make time zones explicit and store machine timestamps in UTC.

## Coding Standards

The concrete application runtime and toolchain must be recorded in an architecture decision before implementation. The selected runtime must consume the private API through npm. Once selected, configure one canonical formatter, linter, strict type checker (when supported), test runner, and dependency-audit command.

All production changes must follow these rules:

- Use clear names and small, cohesive modules. Optimize for maintainability over cleverness.
- Keep business rules pure where practical and side effects at the boundaries.
- Use explicit types/contracts for public APIs and integration payloads. Avoid untyped escape hatches.
- Validate all external input at runtime even when static types exist.
- Return or throw meaningful, typed errors with safe context; do not swallow exceptions.
- Do not log-and-rethrow the same failure at multiple layers.
- Avoid hidden global state and service locators. Pass dependencies explicitly.
- Keep functions focused and control flow shallow. Extract policy from transport and serialization code.
- Comments should explain decisions and constraints, not narrate obvious code.
- Delete dead code instead of commenting it out.
- Pin dependency ranges deliberately, commit the lockfile, and justify large or security-sensitive dependencies.
- Maintain backward compatibility for persisted data and documented extension contracts, or provide a migration.
- Use UTF-8, platform-neutral paths, and cross-platform process APIs unless an adapter is intentionally platform-specific.

## Testing Standards

- Every bug fix requires a regression test that fails for the original defect.
- Unit-test domain rules, parsing, idempotency, retry classification, and orchestration without live services or printers.
- Contract-test each adapter against sanitized fixtures that reflect observed provider behavior.
- Integration tests may exercise local test doubles or sandbox accounts, but must be opt-in when they require network access, credentials, printers, or remote mutations.
- End-to-end tests must use dedicated test data and default to dry-run/no-print behavior.
- Test first-run baselining, pagination, duplicate discovery, overlapping scheduled/manual requests, restarts, expired authentication, API drift, missing printers, spool failures, and ambiguous print outcomes.
- Do not use real customer PII in fixtures or snapshots. Use reserved domains and obviously synthetic addresses.
- Keep tests deterministic; inject clocks and unique-ID sources.
- A change is not complete while formatter, lint, type checks, tests, or security checks fail.

## Observability

- Use structured logs with correlation IDs linking a synchronization attempt, confirmed order, rules evaluation, and action attempts.
- Log outcomes and safe identifiers, not notification bodies, addresses, documents, tokens, or cookies.
- Expose actionable health states separately for scheduling, TCGplayer access, persistence, and action/printing backends. Add notification-provider health only when such an adapter exists.
- Record why each rule matched or did not match and why each action ran, skipped, retried, or failed.
- Provide a safe operator path to retry or replay work deliberately.

## Configuration and Extensibility

- Validate configuration at startup and report all actionable configuration errors together.
- Separate secret references from ordinary configuration.
- Give each provider/action plugin its own namespaced configuration schema.
- Rules must use documented, versioned fields and operators; do not evaluate arbitrary code from configuration.
- A new synchronization trigger, notification provider, marketplace adapter, rule predicate, or action should be addable without changing unrelated integrations.
- Printer selections must be configuration values discovered or validated through a printing adapter, not embedded constants.

## Development Workflow

- Keep `main` releasable and work directly on it by default. Do not create feature branches or pull requests unless the user explicitly requests them.
- Push focused, validated commits directly to `origin/main` after confirming the diff contains only intended application changes.
- Synchronize with `origin/main` using a fast-forward-safe workflow before pushing. Never force-push or rewrite published `main` history without explicit user authorization.
- Before editing, inspect the working tree and preserve unrelated user changes.
- Do not commit generated output, local state, captured traffic, secrets, or editor artifacts.
- Update documentation and sanitized configuration examples with behavior changes.
- Use conventional, imperative commit subjects where practical (for example, `docs: define project standards`).
- Review dependency and license impact before adding packages or copying code.
- Report the pushed commit and validation summary separately for this repository.

## Definition of Done

A change is done only when:

1. Its behavior and boundaries match this document and the current request.
2. Relevant tests cover success, expected failure, and idempotency where side effects are involved.
3. Formatting, linting, type checking, tests, and security checks pass.
4. No secret, PII, real order data, or unsafe fixture is present in the diff or history.
5. Configuration, migration, operational, and attribution documentation is current.
6. Failure behavior is explicit and observable.
7. The diff contains no unrelated changes.

## Outstanding Design Decisions

- Whether and when optional notification providers should be added; provider authentication remains deferred until one is selected.
- Whether TCGplayer session acquisition or renewal remains entirely operator-owned.
- Which non-Windows or direct-network printer adapters should follow the initial native Windows adapters.
- Whether a later multi-user or remote deployment warrants replacing the single-process JSON store with a transactional database.
- Whether a web operator interface is needed beyond the initial CLI.

Record consequential changes with a short architecture decision record before coupling implementation to them.
