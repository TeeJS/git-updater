# git-updater

**Keep your apps up to date straight from their GitHub releases. Windows, macOS and Linux.**

A ton of great software ships on GitHub — and nothing keeps it updated. git-updater is a
self-hosted **Ninite replacement**: you pick the apps, it checks their latest releases and
updates them, portable apps and installed programs alike. No accounts, no background
services, no store — just your list and GitHub.

## Get it

Grab the build for your machine from **[Releases](https://github.com/TeeJS/git-updater/releases)**.

| | Download | Run it |
|---|---|---|
| **Windows** | `git-updater-<v>-<arch>.zip` (x64, arm64) | unzip anywhere, run `git-updater.exe` |
| **macOS** | `git-updater-<v>-mac-arm64.dmg` (Apple Silicon) | open it, drag to Applications |
| **Linux** | `git-updater-<v>-linux-<arch>.AppImage` (x64, arm64) | `chmod +x`, then run it |

No setup, no admin rights, no background service, and closing the window exits everything.
Windows builds are Authenticode-signed (Thomas Schmitz, via Azure Trusted Signing); macOS
builds are Developer ID signed and notarized.

**On macOS, only notarized apps will run** — see [below](#on-macos).

## What it does

- **Tracks any app that ships GitHub releases.** Paste a releases URL (or `owner/repo`),
  say whether you want it *portable* or *installed*, done. It figures out the right download
  for your machine by itself — platform, architecture, archive vs installer, even matching
  the format an app is already installed in (MSI vs EXE on Windows, deb vs rpm on Linux) so
  you never end up with duplicates.
- **Shows what you actually have.** *Current* comes from the system itself — the uninstall
  registry on Windows, the app bundle's own version on macOS, dpkg/rpm/flatpak/snap on
  Linux, or the portable folder — not from what some tool remembers doing. Next to it: the
  latest available version and a live status.
- **Updates on your terms.** Per-app Check/Update buttons, or *Check all* / *Update all*
  batches with live progress (Downloading 42% → Verifying → Installing). Each row has an
  overflow menu: Edit, Force reinstall, Close app & update, View release, Open folder,
  Stop tracking.
- **Scan this PC.** Finds programs you already have that git-updater recognizes — a curated
  catalog of 120+ GitHub-released apps (browsers, media, dev tools, AI tools, runtimes),
  filtered to the ones that exist on your platform — and adds the ones you pick. Or browse
  the whole catalog and cherry-pick.
- **Safe by default.** Every download is checksum-verified. Portable updates are
  transactional — a failed or interrupted update restores the previous version completely,
  and your settings inside the app folder survive. Installers that need admin rights fall
  back to their own window with a normal UAC prompt.
- **Quiet by design.** Nothing runs at startup, nothing phones home, no background service.
  Open it, update, close it — on macOS too, where it deliberately does not linger in the
  dock. It even tells you when git-updater itself has a new release.

## On macOS

**Only notarized apps will run.** git-updater will install any app you point it at, but
on Apple Silicon macOS refuses to LAUNCH anything that is not notarized — including an app
signed with a valid Developer ID that was simply never notarized, which it treats exactly
as it treats an unsigned one. git-updater cannot change that, and does not try to.

**Downloads keep their quarantine flag.** macOS attaches it, Apple's own copy tool carries
it across unchanged, and git-updater does not strip it. One consequence worth knowing: an
app you had previously approved by hand is replaced whole by an update, and the new copy
arrives carrying the download's own quarantine — so your earlier approval does not carry
over with it.

**An update that would damage an app is rolled back.** A macOS application is sealed, and
a single stray file inside it stops macOS accepting it. If an update leaves a bundle whose
signature no longer verifies, git-updater puts the previous version back rather than
leaving you with the damaged one.

**git-updater updates itself in place on Windows and Linux**, where the new version is
installed in its own folder and the launcher switches to it on next start. On macOS it
tells you a new version exists and sends you to the release page instead: an app bundle is
the unit macOS launches, so there is nowhere to put a launcher that is not itself inside
the thing being replaced.

## Quick start

1. Open Settings (top right) and pick your **portable apps folder** (`C:\PortableApps`,
   `~/Applications`, `~/Apps` — wherever you like).
2. **Add app** → paste a GitHub releases URL → choose Portable or Installer.
3. **Check all**, then **Update all**. That's it.

Prefer beta builds for a specific app? Tick *include beta (pre-release) versions* when
adding it.

## On the open-quake panel

git-updater is also available as a **drop-in app for [open-quake](https://github.com/TeeJS/open-quake)**
(Settings → Drop-In Apps → Browse). It shares the same app list and state with the desktop
version — add apps here, update them from the panel, or vice versa.

## For developers

```bash
npm install && npm start   # run from source
npm test                   # engine tests
npm run dist               # build the portable zips (signed when the machine has the signing setup)
```

`npm run dist:mac` and `npm run dist:linux` build the other two (each must run on that OS).

There's also a headless CLI (`node bin/watch.js check|update`) for scripting. Config lives in
git-updater's own folder — `%APPDATA%\git-updater\` on Windows, `~/Library/Application
Support/git-updater/` on macOS, `~/.config/git-updater/` on Linux. Per-app overrides (asset
patterns, custom install dirs, installer switches), architecture notes, and design details
are in **[docs/INTERNALS.md](docs/INTERNALS.md)**.
