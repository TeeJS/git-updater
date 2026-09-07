# git-updater — internals & advanced configuration

The details that used to crowd the README. User-facing overview: [../README.md](../README.md).

## Config shape (`config.json`)

Lives at `%APPDATA%\git-updater\config.json` (override the path with `GITUPDATER_CONFIG`).
Each app is just a repo plus **portable or installer** — git-updater picks the right Windows file
from the latest release automatically (portable → the Windows `.zip`/`.7z`; installer → the
`.exe`/`.msi`, preferring x64).

```jsonc
{
  "portableRoot": "C:/PortableApps",     // portable apps install to <portableRoot>/<repo>
  "repos": [
    { "owner": "ShareX", "repo": "ShareX", "type": "portable" },
    { "owner": "TeeJS", "repo": "tts-stt-windows", "type": "installer" }
  ]
}
```

The chosen file matches the machine's architecture (x64 / arm64 / x86) and, for installers, the
**flavor of the existing install** (an MSI-installed app gets the `.msi`, an EXE-installed app the
`.exe` — never a side-by-side duplicate). Silent-install technology (NSIS / Inno / MSI) is
**detected from the downloaded file's bytes**; an unidentifiable installer is never guessed at —
its own installer window is opened instead (with a normal UAC prompt).

Optional per-app overrides (rarely needed):
- `"asset": "*-win-x64.zip"` (glob or `/regex/`) pins a specific file instead of auto-pick.
- Portable: `"install": { "dir": "D:/Custom" }` to override the folder.
- Installer: `"install": { "kind": "inno", "args": ["/VERYSILENT"] }` — required when detection
  can't identify an unusual installer (`kind` is `msi` | `nsis` | `inno`).
- `"prerelease": true` follows beta releases; `"detect"` / `"process"` override the registry
  match / process name when they differ from the repo name.
- `"tagPrefix": "desktop-v"` pins release lookup to one train, for repos that publish several
  products' releases in one place (e.g. bitwarden/clients also ships `web-v*`/`browser-v*`/
  `cli-v*` — without this, "latest release" can resolve to the wrong product entirely).

You can track the same repo as **both** portable and installed — each is a separate entry with
its own update history.

## Verification & transactional installs

Downloads are verified against GitHub's asset digest, or a checksums file shipped in the release
(`SHA256SUMS`, `<asset>.sha256`, ...) when GitHub has none; a release with neither is logged as a
warning. Portable updates are **transactional**: the new version is staged next to the app folder
and swapped in by directory rename — on any failure (including a crash) the complete previous
version is restored, and your settings files inside the folder are carried across updates.

## Elevation & EDR posture

git-updater uses **no PowerShell and no self-elevation** (both are EDR triggers). Portable
installs under a user-writable `portableRoot` need no admin and just work. An installer that
needs administrator rights falls back to **its own installer window** with a normal UAC prompt
(the row shows "Waiting for installer…" and updates itself when it finishes). Running
git-updater as administrator instead makes those installs fully silent.

Downloads are staged under `%LOCALAPPDATA%\git-updater\staging`, never executed from `%TEMP%`.
No localhost server; the UI talks to the engine over Electron IPC only.

## Auth (optional)

All tracked repos are public, so no token is needed. Set `GITHUB_TOKEN` only to lift the
~60-request/hour unauthenticated GitHub rate limit.

## CLI

```bash
node bin/watch.js check                     # what's new, no download
node bin/watch.js update                    # check + download + apply
node bin/watch.js update --dry-run          # print the plan, run nothing
node bin/watch.js update --only owner/repo  # or owner/repo#installer
node bin/watch.js list-assets owner/repo    # inspect a release's assets
```

## Release & signing

`npm run dist` produces the portable zips and Authenticode-signs `git-updater.exe` via the
`sign.js` hook (Azure Trusted Signing: SignTool + Trusted Signing dlib, silent auth from the
local `Connect-AzAccount` session). Machines without the `.signing/` setup build unsigned with a
warning. Publish with `gh release create vX.Y.Z dist/*.zip`.

**Self-update** (`src/selfupdate.js`) follows the Squirrel.Windows layout: nothing a process is
running from is ever renamed or deleted. The exe at the install root is the **launcher**; updated
versions live in `<root>\app-<version>\`. A flat unzip-and-run install simply *becomes* the
launcher on its first update — its files are never touched again.

- *Check all* also checks git-updater's own releases (`GITUPDATER_SELFUPDATE_OWNER`/`_REPO`
  override the repo) and shows a banner with **Update** (and a dismiss × for the session).
- **Update** runs entirely in the running process: download to `%LOCALAPPDATA%\git-updater\
  self-update\<tag>\`, verify (digest or checksums file), extract into a stage dir under the
  root, rename that fresh folder to `app-<tag>` — the same "fresh install" rename every tracked
  portable app already does — then write `last-apply.json` and start the launcher with
  `--wait-pid <own pid>` and exit. A failure at any step leaves the running version untouched.
- On every start (`electron/main.js`, before the single-instance lock): if `--wait-pid` is
  present, wait for that process to exit (it holds the lock). Then, if a newer `app-*` folder
  exists that isn't the one we're running from, spawn its exe and exit — that's the launcher
  hand-off (Electron boots twice; ~1s). Otherwise run normally.
- On a normal start, `cleanupLeftovers()` removes `app-*` folders older than the running version
  (nothing runs from them any more), stale stage dirs, and day-old downloads. The next `load()`
  consumes `last-apply.json` and warns if the version that came up isn't the one expected.

Why not swap in place: a running Electron process can't have its own directory renamed (dozens
of open DLL/resource handles), and renames done from inside Electron hit EPERM even from a
sibling copy — a known, unresolved class of electron-updater issues. New-folder-plus-launcher
sidesteps it entirely. Cost: the launcher copy stays on disk (~270 MB) next to the current
version. `bin/watch.js` (headless CLI) does not self-update — apply is GUI-only.

## Architecture

```
electron/main.js     Electron main process — window + IPC + native folder dialog; calls the engine
electron/preload.js  narrow contextBridge: the renderer only sees window.api.*
ui/index.html        the renderer (no network; talks over IPC)
ui/scan.html         the Scan this PC window
src/                 the engine (no UI, no shell):
  core.js            IO-free: version compare, Windows-asset pick, installer switches, validation
  github.js          release fetch + download + digest/checksums-file verify (sha256/sha512)
  install.js         transactional portable dir-swap, .7z via 7z-wasm, silent installer
  runner.js          orchestration + progress events; state keyed per (repo + type)
  selfupdate.js       git-updater updating itself: download/verify/extract, detached-helper swap
  state.js           atomic state + cross-process update lock  (%APPDATA%\git-updater)
  detect.js          installed versions/flavor (uninstall registry), running-app check (async)
  catalog.js         known-apps catalog for "Scan this PC"
  log.js             file log -> %APPDATA%\git-updater\logs (Settings -> Open log)
bin/watch.js         headless CLI over the same engine
```

The **open-quake drop-in app** vendors `src/*` into its own folder and drives it from the
panel — same engine, shared `%APPDATA%\git-updater` config/state, cross-process safe via the
engine's state lock.

> Not related to `itzg/github-release-watcher` (a Java release *viewer*). This project supersedes
> the local `github-release-watcher` engine it grew out of.
