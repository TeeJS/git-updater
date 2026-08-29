# git-updater

**Keep your Windows apps up to date straight from their GitHub releases.**

A ton of great software ships on GitHub — and nothing keeps it updated. git-updater is a
self-hosted **Ninite replacement**: you pick the apps, it checks their latest releases and
updates them, portable apps and installed programs alike. No accounts, no background
services, no store — just your list and GitHub.

## Get it

1. Download the zip for your machine from **[Releases](https://github.com/TeeJS/git-updater/releases)** (x64 or arm64).
2. Unzip anywhere and run **`git-updater.exe`**.

That's the whole install: it's fully portable — no setup, no admin rights, and closing the
window exits everything. Binaries are Authenticode-signed (Thomas Schmitz, via Azure
Trusted Signing).

## What it does

- **Tracks any app that ships GitHub releases.** Paste a releases URL (or `owner/repo`),
  say whether you want it *portable* or *installed*, done. It figures out the right Windows
  download by itself — architecture, zip vs installer, even matching an existing MSI vs EXE
  install so you never end up with duplicates.
- **Shows what you actually have.** *Current* comes from Windows itself (the uninstall
  registry, or the portable folder) — not from what some tool remembers doing. Next to it:
  the latest available version and a live status.
- **Updates on your terms.** Per-app Check/Update buttons, or *Check all* / *Update all*
  batches with live progress (Downloading 42% → Verifying → Installing). Each row has an
  overflow menu: Edit, Force reinstall, Close app & update, View release, Open folder,
  Stop tracking.
- **Scan this PC.** Finds programs you already have that git-updater recognizes — a curated
  catalog of 120+ GitHub-released apps (browsers, media, dev tools, AI tools, runtimes) —
  and adds the ones you pick. Or browse the whole catalog and cherry-pick.
- **Safe by default.** Every download is checksum-verified. Portable updates are
  transactional — a failed or interrupted update restores the previous version completely,
  and your settings inside the app folder survive. Installers that need admin rights fall
  back to their own window with a normal UAC prompt.
- **Quiet by design.** Nothing runs at startup, nothing phones home, no background service.
  Open it, update, close it. It even tells you when git-updater itself has a new release.

## Quick start

1. Open Settings (top right) and pick your **portable apps folder** (e.g. `C:\PortableApps`).
2. **Add app** → paste a GitHub releases URL → choose Portable or Installer.
3. **Check all**, then **Update all**. That's it.

Prefer beta builds for a specific app? Tick *include beta (pre-release) versions* when
adding it.

## For developers

```bash
npm install && npm start   # run from source
npm test                   # engine tests
npm run dist               # build the portable zips (signed when the machine has the signing setup)
```

There's also a headless CLI (`node bin/watch.js check|update`) for scripting. Config lives at
`%APPDATA%\git-updater\config.json` — per-app overrides (asset patterns, custom install dirs,
installer switches), architecture notes, and design details are in
**[docs/INTERNALS.md](docs/INTERNALS.md)**.
