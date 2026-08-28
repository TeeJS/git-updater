# git-updater

On-demand Windows updater for a hand-picked list of apps distributed via **GitHub releases** —
**portable** apps get their files swapped in place, **installed** apps get a silent install. A
self-hosted **Ninite replacement**: you own the list, it pulls straight from GitHub.

- **Config mode** — a local web UI to add/manage which repos to track and where portable apps live.
- **Update mode** — poll each tracked repo; if the latest release is newer than last seen, download
  the right asset and apply it. Portable = zip extract + in-place swap (with `.bak` rollback);
  installer = silent install.
- Ships as a single **portable `git-updater.exe`** — the target PC needs **no Node, no Python, and
  nothing installed**.

> Not related to `itzg/github-release-watcher` (a Java release *viewer*). This project supersedes the
> local `github-release-watcher` engine it grew out of and reuses its IO-free `src/core.js`.

## Run (development)

```bash
npm install
npm start          # starts the local UI and opens your browser
```

Config is written to `./config.json` (override with `GITUPDATER_CONFIG`). Port defaults to 8756
(`GITUPDATER_PORT`).

## Build the portable exe

```bash
npm run build      # -> dist/git-updater.exe  (needs Node >= 22 to build; target needs nothing)
```

## CLI (optional / power users)

The same entry point exposes the original headless commands, with per-repo Windows self-elevation:

```bash
node server.js check                     # what's new, no download
node server.js update                    # check + download + apply
node server.js update --dry-run          # print the plan, run nothing
node server.js update --only owner/repo
node server.js list-assets owner/repo    # discover an asset pattern
```

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

Optional overrides (rarely needed):
- `"asset": "*-win-x64.zip"` (glob or `/regex/`) pins a specific file instead of auto-pick.
- Portable: `"install": { "dir": "D:/Custom" }` to override the folder.
- Installer: `"install": { "kind": "inno", "args": ["/VERYSILENT"] }` if the guessed silent-install
  switch is wrong for that installer (`kind` is `msi` | `nsis` | `inno`).

## Elevation

Portable installs under a user-writable `portableRoot` (e.g. `C:/PortableApps`) need no admin.
Installers trigger their own UAC prompt when they run. To swap a portable app into a protected
directory (e.g. `Program Files`) from the exe, right-click → **Run as administrator**; the CLI
(`node server.js update`) instead self-elevates one repo at a time.

## Auth (optional)

All tracked repos are public, so no token is needed. Set `GITHUB_TOKEN` only to lift the
~60-request/hour unauthenticated GitHub rate limit.

## Later: open-quake

`src/core.js` is IO-free and reusable verbatim; the web UI is served the same way open-quake serves
its panels, so this drops in as an open-quake tile/service without a rewrite.
