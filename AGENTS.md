# AGENTS.md

## Purpose

This repository will contain a provider-agnostic automation service for TCGplayer seller fulfillment. Its core workflow is:

1. Observe a mailbox for a credible TCGplayer sale notification.
2. Confirm and retrieve the corresponding order and packing slip through the separately maintained unofficial TCGplayer seller API client.
3. Convert the result into stable internal domain objects.
4. Evaluate user-configurable rules.
5. Dispatch one or more independently configurable actions, such as printing a shipping-address label or printing a packing slip.

The product must remain useful beyond one seller, mailbox, operating system, printer, or workflow. Yahoo Mail and the initial DYMO-label/network-printer workflow are the first integration targets, not assumptions that may leak into the domain model.

## Current Phase

The repository is in bootstrap and architecture-discovery mode. Do not begin application implementation until the user explicitly requests it. Research, design notes, small compatibility experiments, and an inventory of reusable upstream components are acceptable only when requested.

## Product Principles

- Treat an email as a trigger, never as authoritative order data. Confirm the order with TCGplayer before producing fulfillment output.
- Design around capabilities and interfaces, not named vendors. Vendor-specific behavior belongs in adapters.
- Make actions composable. A rule may invoke zero, one, or many actions, and adding a new action must not require editing the email or TCGplayer integrations.
- Keep the first use case simple without hard-coding it. Default configurations may be opinionated; core behavior may not be personal.
- Prefer a small, dependable service over adopting the referenced application's full web/database/deployment stack.
- Make repeated processing safe. Mail polling, API retries, restarts, and duplicate notifications must not print or act twice unless a user explicitly requests a replay.
- Preserve an auditable trail of decisions without retaining more customer data than necessary.

## Intended Boundaries

Keep these concerns separated even if the first version runs as one process:

- **Mail ingestion:** provider authentication, mailbox access, cursors, and message retrieval.
- **Notification interpretation:** identify candidate sale messages and extract only identifiers/hints needed for confirmation.
- **TCGplayer access:** an application-facing adapter around the separately versioned `tcgplayer-private-api` client. Private endpoint details do not belong in this repository.
- **Domain and orchestration:** provider-neutral orders, documents, events, rules, idempotency, retries, and workflow state.
- **Rules:** declarative conditions and action selection, with validation and explainable evaluation results.
- **Actions:** plugins that consume domain data or documents and produce side effects.
- **Printing:** printer discovery/selection, rendering, job submission, and job-result reporting behind a print interface.
- **Configuration and secrets:** validated non-secret configuration separated from credentials and session material.
- **Persistence:** the smallest durable store that safely supports cursors, deduplication, job state, and audit history.

Initial adapters are expected to include:

- Standards-based IMAP where feasible, plus OAuth-aware adapters for major providers whose authentication requires it.
- A TCGplayer seller adapter that depends on the narrow public contract exposed by `Reldnahc/tcgplayer-private-api`.
- A DYMO-compatible address-label action.
- A generic packing-slip print action capable of targeting an operating-system or network printer.

Do not let those initial adapters define the public contracts for future providers or actions.

## API Repository Boundary

The unofficial seller API integration is maintained separately at:

- <https://github.com/Reldnahc/tcgplayer-private-api>

This application repository owns email ingestion, domain orchestration, rules, actions, printing, user configuration, and end-to-end workflow state. The API repository owns only TCGplayer seller authentication/session behavior, private endpoint transport, response validation, order retrieval, and packing-slip retrieval.

- Consume the API client only through its documented npm package exports.
- Use a released semantic version for normal builds. Local adjacent-repository development may use an npm-managed `file:../package` dependency or a packed tarball.
- Never import files directly from `../package/src` or depend on the package repository's internal layout.
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
- Normalize provider data at the boundary. Do not pass raw email messages or raw TCGplayer responses throughout the application.
- Represent external documents as typed metadata plus bytes/streams; do not assume every packing slip is a filesystem path or PDF until verified.
- Side effects must accept an idempotency key and return a structured result.
- Persist workflow state before acknowledging a source event when doing so is required to prevent loss or duplication.
- Put time, randomness, filesystem access, networking, and printing behind injectable boundaries so tests remain deterministic.
- Prefer configuration over conditionals for user-specific rules, printers, labels, and routing.
- Version persisted schemas, rule formats, and plugin contracts from their first durable release.
- Make unsupported capabilities explicit; never silently degrade a requested print or fulfillment action.

## Security and Privacy

- Never commit credentials, email addresses used as credentials, passwords, OAuth refresh tokens, cookies, API/session tokens, private keys, customer addresses, packing slips, or real email bodies.
- Do not hard-code a personal mailbox, seller identity, printer name, IP address, or network path. Supply them through local configuration or secret storage.
- Keep `.env*`, credential stores, captured HTTP traffic, downloaded messages, generated packing slips, print spools, and local databases out of Git unless they are sanitized examples explicitly intended for source control.
- Use least-privilege mailbox scopes and read-only access wherever the workflow allows it.
- Encrypt sensitive data in transit and use the platform's protected secret storage at rest when available.
- Redact secrets and customer PII from logs, errors, metrics, test snapshots, and bug reports.
- Give retained customer data an explicit purpose and retention period. Prefer identifiers, hashes, and minimal metadata over raw content.
- Treat message content, API responses, filenames, rule definitions, and printer metadata as untrusted input. Validate sizes, formats, and identifiers.
- Do not mark messages read, move them, delete them, change orders, or print documents merely while testing connectivity.
- Require an explicit opt-in for actions that mutate remote state or incur cost.

## Reliability Requirements

- Use stable event/order identifiers and a durable idempotency record to prevent duplicate actions.
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
- Test duplicate delivery, out-of-order events, restarts, expired authentication, malformed messages, API drift, missing printers, spool failures, and ambiguous print outcomes.
- Do not use real customer PII in fixtures or snapshots. Use reserved domains and obviously synthetic addresses.
- Keep tests deterministic; inject clocks and unique-ID sources.
- A change is not complete while formatter, lint, type checks, tests, or security checks fail.

## Observability

- Use structured logs with correlation IDs linking a mail event, confirmed order, rules evaluation, and action attempts.
- Log outcomes and safe identifiers, not message bodies, addresses, documents, tokens, or cookies.
- Expose actionable health states separately for mail access, TCGplayer access, persistence, and action/printing backends.
- Record why each rule matched or did not match and why each action ran, skipped, retried, or failed.
- Provide a safe operator path to retry or replay work deliberately.

## Configuration and Extensibility

- Validate configuration at startup and report all actionable configuration errors together.
- Separate secret references from ordinary configuration.
- Give each provider/action plugin its own namespaced configuration schema.
- Rules must use documented, versioned fields and operators; do not evaluate arbitrary code from configuration.
- A new mail provider, marketplace adapter, rule predicate, or action should be addable without changing unrelated integrations.
- Printer selections must be configuration values discovered or validated through a printing adapter, not embedded constants.

## Development Workflow

- Keep `main` releasable. Work in focused branches and commits.
- Before editing, inspect the working tree and preserve unrelated user changes.
- Do not commit generated output, local state, captured traffic, secrets, or editor artifacts.
- Update documentation and sanitized configuration examples with behavior changes.
- Use conventional, imperative commit subjects where practical (for example, `docs: define project standards`).
- Review dependency and license impact before adding packages or copying code.
- Prefer a narrow pull request with an explicit validation summary.

## Definition of Done

A change is done only when:

1. Its behavior and boundaries match this document and the current request.
2. Relevant tests cover success, expected failure, and idempotency where side effects are involved.
3. Formatting, linting, type checking, tests, and security checks pass.
4. No secret, PII, real order data, or unsafe fixture is present in the diff or history.
5. Configuration, migration, operational, and attribution documentation is current.
6. Failure behavior is explicit and observable.
7. The diff contains no unrelated changes.

## Early Design Decisions Still Required

Do not silently assume answers to these questions during implementation:

- Runtime/language and packaging model.
- Supported deployment targets and operating systems.
- Mail authentication strategy per provider, including Yahoo app-password/OAuth constraints.
- TCGplayer authentication/session acquisition and renewal boundaries.
- Legal/licensing status of any upstream code to be reused.
- Durable-store choice and customer-data retention defaults.
- Plugin discovery and versioning approach.
- Rules configuration format and user interface.
- Cross-platform printing architecture and DYMO integration strategy.
- Whether packing slips are fetched as PDFs, rendered pages, or another documented format.

Resolve consequential choices with a short architecture decision record before coupling implementation to them.
