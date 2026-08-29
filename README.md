# git-updater

On-demand Windows GUI that updates a hand-picked list of apps distributed via **GitHub releases** —
**portable** apps get their files swapped in place, **installed** apps get a silent install. A
self-hosted **Ninite replacement**: you own the list, it pulls straight from GitHub.

A native **Electron** window, app-centric: each row shows the app, its **installed version**
(read from Windows, not just update history), the **available version**, live status
(Downloading 42% → Verifying → Installing), and a per-row Check/Update/Install button with an
overflow menu (Edit, Force reinstall, Close app & update, View release, Open folder, Stop
tracking). Batch updates run as a queue, one app at a time. **On-demand** — nothing runs until
you open it, and closing the window exits every process. **EDR-conscious by design**: no
localhost server, no PowerShell/shell, no self-elevation, installers never run from `%TEMP%`.

**Scan this PC** finds installed programs git-updater already recognizes (a curated catalog of
120+ apps with known GitHub repos — browsers, media, dev tools, AI tools, runtimes) and adds the
ones you pick, with Select all / Add selected.

> Not related to `itzg/github-release-watcher` (a Java release *viewer*). This project supersedes the
> local `github-release-watcher` engine it grew out of and reuses its IO-free `src/core.js`.

## Run (development)

```bash
npm install
npm start          # launches the Electron app
```

Config + state live under `%APPDATA%\git-updater\` (override config with `GITUPDATER_CONFIG`).

## Build (portable — run as is)

git-updater itself is **portable only**: unzip anywhere, run `git-updater.exe`. Nothing installs.

```bash
npm run dist       # -> dist/  : portable ZIPs (x64 + arm64)
```

Signing (recommended — the biggest EDR/SmartScreen trust lever) uses Azure Trusted Signing:
`az login`, then `npm run dist:signed` (see the windows-app-signing notes). An unsigned build works
but will draw SmartScreen/EDR warnings until it earns reputation.

## Self-update

**Check all** also checks git-updater's own GitHub releases (nothing runs at startup). If a newer
release exists, a banner links to the download page.

Publishing a release: `gh release create vX.Y.Z dist/*.zip`.

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

The chosen file matches the machine's architecture (x64 / arm64 / x86) and, for installers, the
**flavor of the existing install** (an MSI-installed app gets the `.msi`, an EXE-installed app the
`.exe` — never a side-by-side duplicate). Silent-install technology (NSIS / Inno / MSI) is
**detected from the downloaded file's bytes**; an unidentifiable installer is never guessed at —
its own installer window is opened instead (with a normal UAC prompt).

Downloads are verified against GitHub's asset digest, or a checksums file shipped in the release
(`SHA256SUMS`, `<asset>.sha256`, ...) when GitHub has none; a release with neither is logged as a
warning. Portable updates are **transactional**: the new version is staged next to the app folder
and swapped in by directory rename — on any failure (including a crash) the complete previous
version is restored, and your settings files inside the folder are carried across updates.

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
installer that needs administrator rights falls back to **its own installer window** with a normal
UAC prompt (the row shows "Waiting for installer…" and updates itself when it finishes). Running
git-updater as administrator instead makes those installs fully silent.

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
  github.js        release fetch + download + digest/checksums-file verify (sha256/sha512)
  install.js       transactional portable dir-swap, .7z via 7z-wasm, silent installer
  runner.js        orchestration + progress events; state keyed per (repo + type)
  state.js         atomic state + cross-process update lock  (%APPDATA%\git-updater)
  detect.js        installed versions/flavor (uninstall registry), running-app check (async)
  catalog.js       known-apps catalog for "Scan this PC"
  log.js           file log -> %APPDATA%\git-updater\logs (Settings -> Open log)
bin/watch.js       headless CLI over the same engine
ui/scan.html       the Scan this PC window
```

**OpenQuake** (also Electron/Node) loads `src/*` directly in its main process and renders an
"Application Updates" panel — same engine, no separate runtime, no server, no sidecar.
