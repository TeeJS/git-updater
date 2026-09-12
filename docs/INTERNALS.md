# git-updater — internals & advanced configuration

The details that used to crowd the README. User-facing overview: [../README.md](../README.md).

## Config shape (`config.json`)

Lives in git-updater's own config folder (`src/paths.js`):

| | config + state + logs | downloads + staging |
|---|---|---|
| Windows | `%APPDATA%\git-updater\` | `%LOCALAPPDATA%\git-updater\` |
| macOS | `~/Library/Application Support/git-updater/` | same |
| Linux | `$XDG_CONFIG_HOME` or `~/.config/git-updater/` | `$XDG_DATA_HOME` or `~/.local/share/git-updater/` |

Override the config file with `GITUPDATER_CONFIG`, or either directory outright with
`GITUPDATER_CONFIG_DIR` / `GITUPDATER_DATA_DIR`.

Each app is just a repo plus **portable or installer** — git-updater picks the right file for
the running platform automatically:

| | portable | installer |
|---|---|---|
| Windows | `.zip` / `.7z` / a portable `.exe` | `.exe` / `.msi` |
| macOS | `.dmg` / `.zip` (a `.app` bundle) | `.pkg` |
| Linux | `.AppImage` / `.tar.gz` / `.tar.xz` / `.zip` | `.deb` / `.rpm` |

```jsonc
{
  "portableRoot": "C:/PortableApps",     // portable apps install to <portableRoot>/<repo>
  "repos": [
    { "owner": "ShareX", "repo": "ShareX", "type": "portable" },
    { "owner": "TeeJS", "repo": "tts-stt-windows", "type": "installer" }
  ]
}
```

The chosen file matches the machine's architecture (x64 / arm64 / x86; on macOS a `universal`
build is the fallback when there is no native one) and, for installers, the **flavor of the
existing install** — an MSI-installed app gets the `.msi`, a deb-installed app the `.deb`, never
a side-by-side duplicate. Installer technology (NSIS / Inno / MSI / pkg / deb / rpm) is
**detected from the downloaded file's bytes**; an unidentifiable installer is never guessed at —
its own installer window is opened instead, with the platform's normal authorization prompt.

The per-platform tables — extension sets, reject regexes, architecture tokens and scoring
bonuses — are all in `src/platform/assets.js`, which is pure data so `core.js` keeps its
"no IO" guarantee.

Optional per-app overrides (rarely needed):
- `"asset": "*-win-x64.zip"` (glob or `/regex/`) pins a specific file instead of auto-pick.
- Portable: `"install": { "dir": "D:/Custom" }` to override the folder.
- Installer: `"install": { "kind": "inno", "args": ["/VERYSILENT"] }` — required when detection
  can't identify an unusual installer (`kind` is `msi` | `nsis` | `inno` | `pkg` | `deb` | `rpm`).
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

**Unix permissions are part of correctness, not a detail.** A build extracted without its
executable bit does not fail during the update — it reports success and then refuses to launch.
So `.tar.gz` / `.tar.xz` / `.tar.bz2` go through `src/tar.js` (a small reader that keeps mode
bits and symlinks) rather than 7-Zip, which drops them; zip entries get their recorded mode
re-applied after extraction, because adm-zip does not; and a bare `.AppImage` is chmod'd 755 on
the way in. On macOS, `.dmg` and `.zip` are handed to Apple's own `hdiutil` and `ditto`, since a
`.app` bundle's symlinks, modes and code signature do not survive a generic unzipper.

## Elevation & EDR posture

git-updater uses **no shell and no self-elevation** — no PowerShell, no `sh`, no generated
scripts (all EDR triggers). Every subprocess it does start is a signed first-party system tool
invoked with an argv array: `reg` / `tasklist` / `taskkill` / `msiexec` on Windows,
`system_profiler` / `defaults` / `ditto` / `hdiutil` / `installer` on macOS, `dpkg-query` /
`rpm` / `flatpak` / `snap` / `ps` on Linux. Process termination off Windows is a plain POSIX
signal, so it is not even a subprocess.

Portable installs under a user-writable `portableRoot` need no admin and just work. A package
that needs root — an elevated Windows installer, a macOS `.pkg`, a Linux `.deb`/`.rpm` — falls
back to **its own installer window** with the platform's normal authorization prompt (the row
shows "Waiting for installer…" and updates itself when it finishes). Running git-updater
elevated instead makes those installs fully silent.

Downloads are staged in git-updater's own data dir, never executed from the system temp dir.
No localhost server; the UI talks to the engine over Electron IPC only.

## macOS specifics

Everything here was MEASURED on macOS 26.6.2, Apple Silicon, against real vendor disk
images and a real Developer ID. Where something is reasoning rather than measurement it
says so. That distinction is not pedantry: several confident claims in this file's own
history turned out to be wrong, and the wrong ones survived because nobody could tell them
apart from the checked ones.

### Gatekeeper has two outcomes, not a spectrum

| bundle | result |
|---|---|
| notarized, Developer ID | accepted |
| Developer ID, **not** notarized | rejected |
| ad-hoc signed | rejected |
| notarized, one file added | rejected — "a sealed resource is missing or invalid" |

There is no unsigned executable on Apple Silicon; the floor is ad-hoc, which is refused.
So a Developer ID signature without a notarization ticket is worth exactly as much as no
signature at all, which is why the build refuses to produce one (see below).

Note what this does NOT restrict: git-updater installs an unsigned or ad-hoc app perfectly
well, and the differential guard below deliberately lets both through, because it refuses
only an app that verified BEFORE and does not after. Whether macOS will then launch what
was installed is macOS's decision, not this program's.

### Extraction

`.dmg` and `.zip` go to `hdiutil` and `ditto` rather than the engine's own extractor. An
application bundle carries symlinks, mode bits and a signature, and a generic unzipper
destroys all three. Measured on the real Claude.app: 14 symlinks through
`Electron Framework.framework` survive, the Mach-O comes out 755, and `stapler validate`
still passes on the extracted copy — so extraction does not cost notarization.

`ditto` copies `com.apple.quarantine` **verbatim**, identity and all: the same UUID
appears on the image and on the extracted app. Not stripping quarantine is therefore the
default rather than a policy this code implements.

Four real vendor images all had the same root layout — one `.app`, the `/Applications`
drag symlink, and dotfiles. A disk image whose payload is a `.pkg` is refused with advice
to switch the entry to Installer, because copying it would leave a package sitting in the
portable folder doing nothing while the row reported success.

### Two guards that exist because the failures are silent

**The flattener stops at a bundle.** `stripDirs` strips version-named wrapper folders by
descending into any lone directory. A `.app` is a directory, so `stage/Foo.app` became
`stage/Foo.app/Contents` and what got installed was a Contents folder with no bundle
around it. See `BUNDLE_DIR` in `src/install.js`.

**Carry-over never writes inside a bundle.** Preserving user files across an update is
right for a portable Windows app, where settings sit beside the executable. On macOS the
app folder *is* the bundle, and one foreign file breaks its seal. Confirmed end to end
with a three-way control: same app, same image, same code path, the only variable being
whether a file existed inside the old bundle.

On top of that, `installPortable` verifies **differentially** — codesign the extracted
payload, swap with the old version parked rather than deleted, codesign the result, and
treat only a valid-then-invalid transition as damage, restoring the previous version. It
is not an absolute check on purpose: plenty of projects ship an unsigned or ad-hoc `.app`,
and refusing those would quietly drop support for software a user can install by hand.
`--verify --strict`, not `--deep`: measured on an 854 MB, 3422-file bundle, plain verify
is ~155ms and already catches an injected file, `--strict` ~356ms, `--deep` ~686ms for no
extra catch, and `--deep` is deprecated by Apple.

### "Close the app and Retry" is a Windows mechanism

`install.js` detects a running app by the directory rename failing with `EBUSY`/`EPERM`.
A POSIX rename of a running application's directory **succeeds**.

What was measured, on a real signed Electron app: it survived the swap for at least 30
seconds across four processes, including having its old directory deleted underneath it,
with no crash and no crash report. A fresh read at the live path returns the new version
while the process keeps executing code loaded before the swap.

What was NOT measured: the mechanism. An attempt to show the old inodes still mapped
returned nothing usable, which is a limitation of the tool on macOS rather than evidence
of absence. And no failure has been provoked from the mismatch.

So the honest statement is that it did not crash and the bad case could not be forced —
**not** that it is safe. Old code, new files, one path.

So on macOS and Linux the only protection is the running-app check in `src/runner.js`,
which runs twice — before the download and again immediately before the swap, because a
download is ample time for the user to launch the app.

### Self-update is check-only

Windows and Linux are safe because of **indirection**: the running process reads from
`app-x.y.z`, an update writes a new sibling directory, and the launcher repoints. Nothing
replaces what is being read from.

A `.app` bundle is the unit macOS launches, so there is nowhere to put a launcher that is
not itself inside the thing being replaced. `canApply()` is false there and the banner
links to the release page.

Note what this reason is *not*. An earlier version of this project claimed an in-place
macOS self-update would break the signature continuity Gatekeeper re-checks. Measured, and
false: a swapped-in bundle verifies as valid, the running process survives, and a relaunch
picks up the new version. The conclusion held, the stated reason did not — and the wrong
reason pointed at a solvable-looking problem instead of an architectural one.

### The build refuses to ship an unnotarized app

`mac.notarize: true` is a request. With no credentials electron-builder logs a skip and
**exits 0**, producing a correctly signed, hardened, entitled app that Gatekeeper refuses.
`build/verify-mac-build.js` checks the artifact with
`codesign --test-requirement==notarized` — the only check that asks the right question,
since `codesign -v` passes on a signed-but-unnotarized app — and fails the build.

Set `GITUPDATER_ALLOW_UNNOTARIZED=1` for a local build you are not shipping. A partial
credential set is reported by name rather than ignored, because that is what a
misconfigured CI looks like and it reads as configured.

Targets are **arm64 only**. Intel is out of scope. The asset picker still prefers a
native-arch build and falls back to universal, and penalises an x64-only upstream release
only lightly, because Rosetta runs it.

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

`npm run dist` (or `dist:win`) produces the portable zips and Authenticode-signs
`git-updater.exe` via the `sign.js` hook (Azure Trusted Signing: SignTool + Trusted Signing
dlib, silent auth from the local `Connect-AzAccount` session). Machines without the `.signing/`
setup build unsigned with a warning.

`npm run dist:mac` produces `.dmg` and `.zip` for x64 and arm64, Developer ID signed with the
hardened runtime and `build/entitlements.mac.plist`, then notarized via notarytool.

Notarization only runs when one of three credential sets is in the environment: `APPLE_API_KEY`
+ `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` (recommended), `APPLE_ID` +
`APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or `APPLE_KEYCHAIN` + `APPLE_KEYCHAIN_PROFILE`.
With none of them the step is skipped with a warning and the build still "succeeds".

### Two signing-config traps, both of which fail silently

Neither of these errors or warns. They produce a build that looks fine and is not.

- **`mac.notarize` reads backwards in the schema.** electron-builder 26's description says the
  boolean is "whether to disable" the notarize integration. It is not. Verified in the source of
  both 25.1.8 (`macPackager.js`) and 26.15.3 (`mac/MacTargetHelper.js`): only an explicit
  `=== false` skips notarization, and `true` behaves the same as omitting it. `notarize: true`
  is correct. Do not "fix" it to `false`.
- **`win.sign` moved in electron-builder 26.** The top-level key no longer exists in that
  schema; app-builder-lib reads `win.signtoolOptions.sign`. The old key is not an error and
  produces no warning — it is ignored, so the build would ship UNSIGNED. Already migrated, in
  the same commit that bumped the dependency. `sign.js` itself is unchanged: the hook is still
  `function | string | null` and still receives a configuration whose `path` is the file to
  sign. **If the pin ever moves back below 26, this has to move back with it.**

### Azure Trusted Signing is now native, and sign.js could retire

electron-builder 26 added `win.azureSignOptions` (required keys: `certificateProfileName`,
`codeSigningAccountName`, `endpoint`, `publisherName`), which is the service `sign.js` drives by
hand today. The schema says it and `signtoolOptions` **cannot both be set** — if both appear,
signing silently defaults to Azure Trusted Signing. So the project sets only `signtoolOptions`
and keeps the hook.

Replacing 76 lines of SignTool and dlib plumbing with four config keys is attractive, but it
changes how release binaries get signed, and the failure mode is a build that looks successful
and is not trusted. It is deliberately NOT bundled with the dependency bump. Do it on its own,
and verify with `signtool verify /pa /v` on a real artifact before publishing.

`mac.hardenedRuntime`, `entitlements`, `entitlementsInherit` and `notarize` are all still
top-level properties of `mac` in 26, so no equivalent migration is needed there. `mac.sign`
exists in 26 but is a `function | string | null` custom-signing hook — the analogue of the old
`win.sign`, not a container for these settings. (The v27 docs do describe nesting them under
`mac.sign`; that is a later change.) `hardenedRuntime` already defaults to true, so setting it
explicitly is documentation rather than behavior.

`npm run dist:linux` produces `.AppImage` and `.tar.gz` for x64 and arm64. No signing.

Each target must be built on its own OS — a signed, notarized macOS app cannot be
cross-built from Windows. Publish with `gh release create vX.Y.Z dist/*`.

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
- **macOS is the exception.** An `.app` is a directory carrying a code signature that
  Gatekeeper re-checks on launch, and a bundle swapped in by another process loses the
  signature continuity it expects — so `selfupdate.canApply()` is false there. The banner
  still reports new versions on every platform; on macOS its button opens the release page
  instead of applying. The URL is built in the main process from the engine's own constants,
  so the renderer never passes a URL across the IPC bridge.
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

## Checking a change actually works

The cross-platform port closed fourteen defects. Twelve would have shipped something that
reported success and then did not work — an installed folder with no application inside
it, an inventory that marked apps current from build leftovers, an update that silently
invalidated every signed app it touched, a build that exited 0 producing an artifact macOS
refuses to run. **Not one was found by a failing test.**

More usefully: of the faults found in the CHECKS rather than the code, every single one was
a guard that could not fail.

- the notarization guard had four paths that returned silently, guarding nothing
- a "verified non-vacuous" claim rested on a matcher that passed with the fix reverted
- three tests inherited the platform from the host. Two failed loudly on the wrong OS,
  picking the host's architecture instead of the one under test. The third was worse: its
  rows were filtered out before the check was reached, so it asserted against an empty
  array — and an empty array with an empty expectation passes while testing nothing
- a revert script died on a syntax error and left the suite green, so the check that exists
  to stop an unverified claim was itself unverified

That is the same failure mode as the twelve, one level up, and much harder to see: a
passing test and an absent test look identical from outside. **On this branch the guards
failed about as often as the code, and more quietly.**

Three mechanisms caught them, every time. None is about being careful.

1. **Revert the fix and expect red.** Before claiming a test proves anything, break the
   thing it tests and confirm that exact test fails and others do not. If nothing goes
   red, the test is decoration.
2. **Quote the commit SHA you measured at, never the branch name.** A failed checkout or a
   stale worktree otherwise produces a confident, wrong report. That happened, and was
   caught only because an error scrolled past above a plausible result.
3. **Pin test inputs; never widen the expectation.** Every time an assertion was loosened
   for portability it lost the ability to fail. `test/hostindependence.test.js` enforces
   this mechanically for the platform argument, and has a test proving its own parser can
   fire — because a guard that never fires and one that cannot fire are indistinguishable.

What found the defects themselves: running the code on the real OS, executing control flow
with the subprocess layer stubbed (`test/macextract.test.js`), reading for faults in the
RELATIONSHIP between individually-correct pieces, and running a catalog against a real
machine's package list instead of trusting its patterns.

The suite grew from 70 tests to 196. The tests are the record of what was found, not the
instrument that found it.

## Architecture

```
electron/main.js     Electron main process — window + IPC + native folder dialog; calls the engine
electron/preload.js  narrow contextBridge: the renderer only sees window.api.*
ui/index.html        the renderer (no network; talks over IPC)
ui/scan.html         the Scan this PC window
src/                 the engine (no UI, no shell):
  core.js            IO-free: version compare, asset pick, installer switches, validation
  github.js          release fetch + download + digest/checksums-file verify (sha256/sha512)
  install.js         transactional portable dir-swap, archive extraction, silent installer
  tar.js             tar reader that preserves Unix modes and symlinks (7-Zip drops both)
  runner.js          orchestration + progress events; state keyed per (repo + type)
  selfupdate.js      git-updater updating itself: download/verify/extract, launcher hand-off
  state.js           atomic state + cross-process update lock
  paths.js           per-platform config/data directories
  detect.js          installed versions/flavor + running-app check (async) — matching only
  catalog.js         known-apps catalog for "Scan this PC", filtered per platform
  log.js             file log -> <config dir>/logs (Settings -> Open log)
  platform/          EVERYTHING OS-specific lives here, behind one interface:
    index.js         dispatch on process.platform; a no-op impl for anything unsupported
    assets.js        pure per-platform asset tables (required by core.js, so no IO allowed)
    win.js           uninstall registry (reg), tasklist, taskkill
    mac.js           system_profiler / Info.plist, ps, signals, ditto + hdiutil extraction
    linux.js         dpkg / rpm / flatpak / snap, ps, signals
    exec.js          shared async no-shell subprocess helper
bin/watch.js         headless CLI over the same engine
```

Adding a platform means adding one file under `src/platform/` and one table in `assets.js`.
Every parser in those modules is a pure string-in/records-out function, so the whole matrix is
unit-tested from any host — only the subprocess that produces the string needs the real OS.

The **open-quake drop-in app** vendors `src/*` into its own folder and drives it from the
panel — same engine, shared config/state, cross-process safe via the engine's state lock.
`detect.registryVersion` is kept as an alias of `detect.installedVersion` so the vendored copy
keeps working across the rename.

> Not related to `itzg/github-release-watcher` (a Java release *viewer*). This project supersedes
> the local `github-release-watcher` engine it grew out of.
