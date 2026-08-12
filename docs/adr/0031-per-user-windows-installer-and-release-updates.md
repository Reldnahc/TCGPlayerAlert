# ADR 0031: Per-user Windows installer and release updates

- Status: Accepted
- Date: 2026-08-11

## Context

The local application currently requires a source checkout, a separately installed Node.js runtime, npm commands, and hand-created configuration. An operator should instead be able to install it and launch it like an ordinary Windows application. Installed state must survive application upgrades, and an unavailable update service must not prevent fulfillment work.

Updating an installed checkout with Git would require shipping developer tooling and a mutable repository. A partial pull, local edit, dependency change, or interrupted build could leave the application unable to start. Git commits also do not provide a directly installable, independently verified runtime artifact.

## Decision

- Produce a per-user x64 Inno Setup installer. Install under the current user's local application directory without requiring administrator access.
- Ship a pinned official Node.js 24 LTS executable, compiled server and browser assets, production npm dependencies, a hidden Windows launcher, and shortcuts. The operator does not need Node.js, npm, Git, or a terminal.
- Keep mutable configuration, workflow state, protected seller-session material, print spools, update downloads, and logs under `%LOCALAPPDATA%\TCGPlayerAlert`. Never overwrite that directory during an application upgrade or ordinary uninstall.
- On first launch, derive the user configuration from the sanitized example and replace every writable relative path with an absolute per-user path. Existing configuration is preserved on later launches.
- Before starting the service, query the repository's latest stable GitHub Release with a bounded timeout. Accept only a strictly newer stable semantic version and the exact versioned x64 installer asset. Require GitHub's `sha256:` release-asset digest, verify the complete download, and then run the installer in unattended current-user mode.
- Fail open when the release service is unavailable, malformed, rate-limited, or unverifiable. Record a safe local launcher event and start the installed version normally. A user may set `checkOnLaunch` to `false` in `%LOCALAPPDATA%\TCGPlayerAlert\updates.json`.
- Use Git only for source development. Release updates use immutable installer assets and never execute `git pull`, install an unpinned branch, or run remote source from an installed directory.
- Do not require Authenticode signing in this phase. SHA-256 verification protects release integrity after retrieval but does not remove Windows' unknown-publisher warning on the first manual install.

## Consequences

Launching a shortcut checks for a verified update, starts the loopback service in the background, waits for it to become ready, and opens the operator console in the default browser. A second shortcut launch opens the already-running console. Network or GitHub failures can add up to the bounded update-check delay but do not block the application.

Releases must attach an installer named `TCGPlayerAlert-Setup-<version>-win-x64.exe` to a matching stable `v<version>` tag. The installer build verifies the official Node.js archive checksum and emits its own `.sha256` file for release operations. Code signing can be added later without changing the update contract.
