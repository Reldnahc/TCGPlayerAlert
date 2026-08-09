# ADR 0002: Local service runtime and extensions

- Status: Accepted
- Date: 2026-08-03

## Context

The first deployment needs to poll one seller account, remember workflow decisions across restarts, and print an address label and packing slip to locally reachable printers. It should remain adaptable without adopting a multi-user web stack before one is needed.

## Decision

- Implement a private Node.js 20.19+ application in strict TypeScript and compile it as ESM.
- Expose a CLI with scheduled service, one-shot synchronization, state status, and configuration validation commands. ADR 0004 adds a loopback-only UI over the same validated configuration model.
- Consume `tcgplayer-private-api` only through an npm-installed immutable tarball during adjacent development, then a semantic registry version after publication.
- Use a versioned, atomically replaced JSON state document for the initial single-process deployment. Persist only order identifiers, workflow/action states, timestamps, safe error classifications, and rule explanations; never persist addresses or document bytes.
- Coalesce overlapping requests in process and serialize independent CLI/service processes with a filesystem lease, heartbeat, and stale-lock recovery. Write an action's durable `running` intent before invoking a side effect; an interrupted `running` action becomes `review-required` on restart instead of being submitted again.
- Define rules as versioned JSON data with a fixed set of fields and operators. Never evaluate user-provided code.
- Define actions and printers through narrow interfaces. Initial actions render a configurable address-label PDF and print the provider packing-slip PDF.
- Use a command-printer adapter that invokes a configured executable directly without a shell. Argument placeholders provide the temporary PDF path, logical job name, and configured printer name. This supports OS-visible DYMO and network printers without coupling the core to one vendor SDK.
- The initial command-printer decision has been superseded as the default by ADR 0003. The adapter remains available as a custom and cross-platform escape hatch.
- Default every side-effecting action and mutation queue to disabled. The first successful sync establishes a baseline and never dispatches existing orders unless `--process-backlog` is explicitly selected.
- Keep tracking and shipment mutations outside the scheduled fulfillment workflow. ADR 0017 separately authorizes an explicitly enabled camera-triggered shipment workflow with its own durable mutation ledger. ADR 0005 separately authorizes an explicit, durable price-update queue.

## Consequences

The first release stays small, portable, testable, and useful on the operator's Windows machine. The JSON store is deliberately limited to a single application process and seller configuration; a multi-process deployment will require a transactional persistence adapter. Printing behavior must be configured and tested for each printer without real customer documents before automatic printing is enabled.
