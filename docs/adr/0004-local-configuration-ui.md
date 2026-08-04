# ADR 0004: Local configuration UI

- Status: Accepted
- Date: 2026-08-03

## Context

Printer names, label stock, PDF scaling, polling cadence, dry-run behavior, and enabled print actions were initially edited in JSON. That remains a useful portable format, but it is unnecessarily error-prone for routine operation. The first deployment is still a trusted, single-user process on one machine; it does not need remote administration, user accounts, or a browser-delivered seller session.

## Decision

- Serve a small configuration UI from the application process on a loopback address only. Do not bind it to the LAN or public network.
- Keep versioned JSON as the canonical non-secret configuration. The UI is an adapter that reads, validates, and atomically replaces that file; it does not introduce another settings database.
- Discover installed Windows printer queues through the operating system and present their exact names as selections. Preserve the existing configured name when a printer is temporarily unavailable.
- Model whether an output runs as an `enabled` property on every action. Rules remain responsible for deciding _when_ an enabled action applies; disabling an action suppresses it globally without editing every rule.
- Show controls from action and printer capabilities. Address-label actions expose stock size, margin, and font size. Windows PDF printers expose DPI and scaling. This pattern can render future action types without coupling the workflow to these first two outputs.
- Never expose seller credentials or session material through the UI or its API. Limit request sizes, require same-origin writes, reject non-loopback hosts, and send a restrictive content security policy.
- Use a configuration revision hash so a stale browser tab cannot overwrite a newer edit. Validate the complete resulting application configuration before replacing the file.
- Host the UI with the long-running scheduler and also provide a `configure` command that runs the settings UI without seller credentials or synchronization.
- Organize the growing operator surface into Add cards, Inventory, Settings, and Jobs tabs. Keep persistent polling, dry-run, printing, and background-worker configuration in Settings; keep action inputs with their workflows; and reserve Jobs for queue history and controls on individual jobs. Preserve each tab's DOM state while navigating, expose the selected tab in the URL hash, remember it locally, and support standard arrow, Home, and End keyboard navigation. Treat the former `automation` tab hash or stored selection as `settings`, and the former `repricing` selection as `inventory`, for compatibility.
- Compare the current persistent-settings projection with the last server-loaded or successfully saved projection. Keep the fixed save banner hidden when they match, including when only preview/search fields change, and show it across tabs while persistent settings are dirty.

## Consequences

Routine printer and worker setup no longer requires hand-editing JSON, while configuration remains inspectable, portable, and compatible with the CLI. Distinct workflows no longer form one continuously scrolling page, action pages are not cluttered with persistent configuration, and changing tabs does not discard searches, previews, selections, or unsaved settings. Printer discovery is Windows-specific in this release; other operating systems can add discovery adapters later. A saved configuration is used by one-shot commands immediately and by the scheduler on its next synchronization cycle. Remote and multi-user administration remain out of scope.
