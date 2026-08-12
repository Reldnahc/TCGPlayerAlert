# Windows installer and updates

## Build prerequisites

- Windows x64
- Node.js 24 or newer for the build machine
- Inno Setup 6 (`JRSoftware.InnoSetup` in WinGet)
- The private API tarball already present under `.packages` and a synchronized `package-lock.json`

Build the runnable installer:

```powershell
npm.cmd run package:windows
```

The command builds the server, web console, and browser connectors; installs only production dependencies into an isolated staging directory; downloads the pinned official Node.js runtime; verifies its published SHA-256 checksum; and compiles the installer. It does not prune or otherwise change the repository's development dependencies.

Outputs are ignored by Git:

- `artifacts/windows/TCGPlayerAlert-Setup-<version>-win-x64.exe`
- `artifacts/windows/TCGPlayerAlert-Setup-<version>-win-x64.exe.sha256`
- `artifacts/windows/stage/` for inspection and smoke testing

Use `npm.cmd run package:windows:stage` when only the unpacked payload is needed.

## Installed behavior

The default per-user installation directory is `%LOCALAPPDATA%\Programs\TCGPlayerAlert`. Mutable application files are separate under `%LOCALAPPDATA%\TCGPlayerAlert`:

- `config\local.json` — persistent application settings
- `data\` — workflow and encrypted session state
- `spool\` — temporary printer jobs
- `logs\service.log` and `logs\launcher.log`
- `updates.json` and `updates\` — update preference and verified downloads

The Start menu shortcut launches without a console window. It checks for updates, starts the local service, and opens `http://127.0.0.1:47831`. If the service is already running, the shortcut just opens it.

Set `"checkOnLaunch": false` in `updates.json` to disable launch-time update checks. The environment variable `TCGPLAYER_ALERT_DISABLE_UPDATES=1` is also available for diagnostics.

## Publish a compatible release

1. Update the stable semantic version in `package.json` and `package-lock.json`.
2. Run the complete validation suite and `npm.cmd run package:windows`.
3. Create the Git tag `v<version>` from the validated commit.
4. Create a non-draft, non-prerelease GitHub Release for that tag.
5. Upload the exact generated `.exe` and `.sha256` files.
6. Wait until GitHub reports the installer's `sha256:` asset digest, then verify the latest-release API response before announcing the release.

The launcher accepts only an exact filename/version match downloaded from GitHub with a matching SHA-256 digest. A release that omits or renames the installer is ignored safely.

Git is intentionally not part of the installed update path. It remains appropriate for developer checkouts, where source changes, dependency installation, builds, and validation are visible and recoverable.
