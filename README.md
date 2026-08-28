# git-updater

On-demand Windows GUI that updates a hand-picked list of apps distributed via **GitHub releases** —
**portable** apps get their files swapped in place, **installed** apps get a silent install. A
self-hosted **Ninite replacement**: you own the list, it pulls straight from GitHub.

A native **Electron** window: add repos, pick a portable-apps folder, Check and Update. **On-demand**
— nothing runs until you open it, and closing the window exits every process. **EDR-conscious by
design**: no localhost server, no PowerShell/shell, no self-elevation, installers never run from
`%TEMP%`.

> Not related to `itzg/github-release-watcher` (a Java release *viewer*). This project supersedes the
> local `github-release-watcher` engine it grew out of and reuses its IO-free `src/core.js`.

## Run (development)

```bash
npm install
npm start          # launches the Electron app
```

Config + state live under `%APPDATA%\git-updater\` (override config with `GITUPDATER_CONFIG`).

## Build installers

```bash
npm run dist       # -> dist/  : per-user NSIS installer + portable ZIP (x64; add --arm64 for arm)
```

Signing (recommended — the biggest EDR/SmartScreen trust lever) uses Azure Trusted Signing:
`az login`, then `npm run dist:signed` (see the windows-app-signing notes). An unsigned build works
but will draw SmartScreen/EDR warnings until it earns reputation.

## CLI (optional — scripting / OpenQuake sidecar)

The engine is also a headless CLI (no shell, no elevation tricks):

```bash
node bin/watch.js check                     # what's new, no download
node bin/watch.js update                     # check + download + apply
node bin/watch.js update --dry-run           # print the plan, run nothing
node bin/watch.js update --only owner/repo   # or owner/repo#installer
node bin/watch.js list-assets owner/repo     # inspect a release's assets
```

OpenQuake (also Electron) loads the same engine directly — no separate runtime, no server.

## Config shape (`config.json`)

Each app is just a repo plus **portable or installer** — git-updater picks the right Windows file
from the latest release automatically (portable → the Windows `.zip`/`.7z`; installer → the `.exe`/`.msi`,
preferring x64).

```jsonc
{
  "portableRoot": "C:/PortableApps",     // portable apps install to <portableRoot>/<repo>
  "repos": [
    { "owner": "ShareX", "repo": "ShareX", "type": "portable" },
    { "owner": "TeeJS", "repo": "tts-stt-windows", "type": "installer" }
  ]
}
```

The chosen file matches the machine's architecture (x64 / arm64 / x86). For installers, the
silent-install technology (NSIS / Inno / MSI) is **detected from the downloaded file's bytes**. If a
particular installer can't be identified, the update **fails safely** rather than guessing — set an
explicit `install.kind` for it (see below).

Optional overrides (rarely needed):
- `"asset": "*-win-x64.zip"` (glob or `/regex/`) pins a specific file instead of auto-pick.
- Portable: `"install": { "dir": "D:/Custom" }` to override the folder.
- Installer: `"install": { "kind": "inno", "args": ["/VERYSILENT"] }` — required when detection can't
  identify an unusual installer (`kind` is `msi` | `nsis` | `inno`).

You can track the same repo as **both** portable and installed — each is a separate entry with its
own update history.

## Elevation

git-updater uses **no PowerShell and no self-elevation** (both are EDR triggers). Portable installs
under a user-writable `portableRoot` (e.g. `C:/PortableApps`) need no admin and just work. An
installer that requires administrator rights, or a portable target under a protected directory
(e.g. `Program Files`), will fail with a clear message — **run git-updater as administrator**
(right-click → *Run as administrator*) for those updates.

Downloads are staged under `%LOCALAPPDATA%\git-updater\staging`, never executed from `%TEMP%`.

## Auth (optional)

All tracked repos are public, so no token is needed. Set `GITHUB_TOKEN` only to lift the
~60-request/hour unauthenticated GitHub rate limit.

## Architecture

```
electron/main.js   Electron main process — window + IPC + native folder dialog; calls the engine
electron/preload.js  narrow contextBridge: the renderer only sees window.api.*
ui/index.html      the renderer (no network; talks over IPC)
src/               the engine (no UI, no shell):
  core.js          IO-free: version compare, Windows-asset pick, installer switches, validation
  github.js        release fetch + asset download + sha256 verify
  install.js       portable swap (manifest + rollback), .7z via 7z-wasm, silent installer, prune
  runner.js        orchestration; state keyed per (repo + type)
  state.js         atomic state + cross-process update lock  (%APPDATA%\git-updater)
bin/watch.js       headless CLI over the same engine
```

**OpenQuake** (also Electron/Node) loads `src/*` directly in its main process and renders an
"Application Updates" panel — same engine, no separate runtime, no server, no sidecar.
