# git-updater — build & release runbook

How a release is cut. Three platforms are built on three hosts (Windows, macOS, Linux)
and their artifacts land on one **draft** GitHub release, which is published once all three
are attached. Internals of the code being shipped: [INTERNALS.md](INTERNALS.md).

Every platform's build config already lives in [`package.json`](../package.json) under
`build`. Nothing here changes that config — this is the operational side: which host,
which credentials, which commands.

## Release model at a glance

| Platform | Host required | Signing | Command | Artifacts (`<v>` = version) |
|---|---|---|---|---|
| Windows | Windows | Authenticode (Azure Trusted Signing) | `npm run dist:win` | `git-updater-<v>-x64.zip`, `git-updater-<v>-arm64.zip` |
| macOS | **a Mac** (arm64) | Developer ID + notarized + stapled | `npm run dist:mac` | `git-updater-<v>-mac-arm64.dmg`, `git-updater-<v>-mac-arm64.zip`, `git-updater-<v>-mac-arm64.zip.blockmap`, `latest-mac.yml` |
| Linux | Linux or WSL2 | none | `npm run dist:linux` | `git-updater-<v>-linux-x64.tar.gz`, `-arm64.tar.gz`, `git-updater-<v>-linux-x86_64.AppImage`, `-arm64.AppImage` |

macOS **cannot** be signed or notarized off a Mac (`codesign`, `xcrun notarytool`,
`stapler` are macOS-only), and Linux's AppImage packaging won't cross-build reliably from
Windows — so each platform is built on its own host. The eventual one-command path is CI
(a `windows-latest` + `macos-latest` + `ubuntu-latest` matrix); until that exists, follow
the steps below.

Each build's signing hook **degrades gracefully**: with no credentials it produces an
*unsigned* artifact rather than failing — except macOS, where the guard (below) fails the
build on purpose, because an unnotarized mac app will not launch at all.

---

## 0. Bump the version (once, on any host)

Both files carry the version and must match:

```bash
node -e "for(const f of['package.json','package-lock.json']){const j=require('fs').readFileSync(f,'utf8'),o=JSON.parse(j);o.version='X.Y.Z';if(o.packages&&o.packages[''])o.packages[''].version='X.Y.Z';require('fs').writeFileSync(f,JSON.stringify(o,null,2)+'\n');}"
git commit -am "Bump version to X.Y.Z"
git push origin main
```

The draft release targets `main`, so `main` must be pushed **before** the release is
created.

---

## 1. Windows build

**Prerequisites** (see the header of [`sign.js`](../sign.js) for the full list): a current
`Connect-AzAccount` session for an account with the cert-profile-signer role,
`.signing/dlib-x64/Azure.CodeSigning.Dlib.dll`, `.signing/metadata.json`, SignTool (Windows
SDK), the .NET 8 runtime, and per-user PowerShell 7 at `%LOCALAPPDATA%\pwsh7`.

```bash
npm ci
npm run dist:win
```

**Verify the signature** before uploading (PowerShell):

```powershell
Get-AuthenticodeSignature .\dist\win-unpacked\git-updater.exe | Format-List Status, SignerCertificate
```

`Status : Valid` with `CN=Thomas Schmitz` means it signed. Without an Azure session the
build still succeeds but the exe is **unsigned** — corporate EDR/SmartScreen may quarantine
it, so do not ship an unsigned Windows build.

---

## 2. macOS build (on a Mac)

**Prerequisites:**

- Xcode command-line tools (`xcode-select --install`).
- A **Developer ID Application** certificate in the login keychain. electron-builder
  auto-detects it; [`notarize-dmg.js`](../build/notarize-dmg.js) reads it via
  `security find-identity`.
- **Notarization credentials** — set exactly one of these groups in the environment
  (mirrored by the build guard, [`verify-mac-build.js`](../build/verify-mac-build.js)):
  - `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`  *(App Store Connect API key — preferred for CI)*
  - `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`
  - `APPLE_KEYCHAIN_PROFILE` *(a `notarytool store-credentials` profile; optional `APPLE_KEYCHAIN`)*

```bash
npm ci
npm run dist:mac
```

What happens: electron-builder signs and notarizes the `.app`; then
`afterAllArtifactBuild` runs `verify-mac-build.js`, which **signs, notarizes and staples the
`.dmg` itself** (the disk image needs its own signature *and* its own ticket — see the long
note at the top of `notarize-dmg.js` for why) and then **fails the build** unless the app
truly passes `codesign --test-requirement="=notarized"`. So a green `dist:mac` is proof of a
notarized build; there is no silent unsigned fallback here.

**Verify** (belt-and-braces; the guard already did this):

```bash
codesign --test-requirement="=notarized" --verify --strict "dist/mac-arm64/git-updater.app"
spctl -a -t open --context context:primary-signature "dist/git-updater-X.Y.Z-mac-arm64.dmg"
```

---

## 3. Linux build (on Linux or WSL2)

No signing, no secrets.

```bash
npm ci
npm run dist:linux
```

Produces the tarballs and AppImages for x64 and arm64. The **tar.gz is the recommended
download**; the AppImage needs `libfuse2`, which recent Ubuntu releases no longer install by
default (noted in the README).

Note: the **x64 AppImage is named `…-linux-x86_64.AppImage`**, not `-x64`, because
electron-builder forces AppImage's own arch label regardless of the `artifactName` template.
The tarballs and the arm64 AppImage follow the `x64` / `arm64` naming as expected.

---

## 4. The draft release

Created once, from any host, after `main` is pushed:

```bash
gh release create vX.Y.Z --draft --target main --title "vX.Y.Z" --notes "…release notes…"
```

A **draft does not create the git tag** in the repo — the `vX.Y.Z` tag is cut only when the
release is published (step 6), at the `--target` commit.

## 5. Each host uploads its artifacts

`gh` resolves the draft by its intended tag name even before the tag exists:

```bash
# Windows host
gh release upload vX.Y.Z dist/git-updater-X.Y.Z-x64.zip dist/git-updater-X.Y.Z-arm64.zip

# macOS host — latest-mac.yml + the .zip.blockmap feed the Squirrel.Mac self-updater
# (electron-updater reads latest-mac.yml off the release); upload them alongside the dmg/zip.
gh release upload vX.Y.Z dist/git-updater-X.Y.Z-mac-arm64.dmg dist/git-updater-X.Y.Z-mac-arm64.zip dist/git-updater-X.Y.Z-mac-arm64.zip.blockmap dist/latest-mac.yml

# Linux host
gh release upload vX.Y.Z dist/git-updater-X.Y.Z-linux-*.tar.gz dist/git-updater-X.Y.Z-linux-*.AppImage
```

Confirm everything is attached and fully uploaded:

```bash
gh release view vX.Y.Z --json isDraft,assets --jq '{isDraft, assets:[.assets[]|{name,size,state}]}'
```

Every asset's `state` should read `uploaded`.

## 6. Publish

Once all three platforms' assets are present and verified:

```bash
gh release edit vX.Y.Z --draft=false --latest
```

This creates the `vX.Y.Z` tag at the target commit and makes the release public.

---

## Beta releases (the self-update beta channel)

git-updater can update **itself** to prereleases, so you can exercise the whole
self-update path — download, verify, swap, relaunch — without cutting a stable release each
time. This is how the 0.2.4 self-update fixes were verified on the locked-down work PC.

**How the channel works**

- A Settings toggle, **"Update git-updater to beta (pre-release) versions"**
  (`config.selfUpdatePrerelease`, off by default), controls it. It is **separate** from the
  per-app "include beta versions" checkbox (that one is per tracked app).
- **Off (default):** self-update uses GitHub's `/releases/latest`, which excludes
  prereleases — stable users never see betas.
- **On:** self-update considers the newest release **including prereleases**
  (`getLatestRelease({prerelease})` on Windows/Linux; `autoUpdater.allowPrerelease` on
  macOS). SemVer ordering means `X.Y.Z-beta.1 < X.Y.Z-beta.2 < X.Y.Z`, and all are newer
  than the previous stable — so a beta self-updates forward to the next beta and, eventually,
  to the stable release.

**Cutting a beta**

Same build steps as a stable release, with three differences: the version carries a
`-beta.N` suffix, the release is published **`--prerelease` (never `--latest`)**, and it can
be a **single platform** when you only need to test one (e.g. Windows-only).

```bash
# version -> X.Y.Z-beta.N in package.json + package-lock.json (same one-liner as step 0)
# build the platform(s) you need (dist:win / dist:mac / dist:linux), then:
gh release create vX.Y.Z-beta.N --prerelease --target <branch-or-main> \
  --title "vX.Y.Z-beta.N" --notes "…" dist/<assets…>
```

A beta may be built from a **branch** rather than `main` when it should differ from `main`
on purpose — e.g. beta.1 built with a fix but *without* a later change, so that change
becomes the visible payload when self-updating beta.1 → beta.2. Target that branch with
`--target`; publishing a prerelease creates its tag immediately (unlike a draft).

**Testing the loop (mind the chicken-and-egg)**

A broken or older installed build cannot self-update *into* the fix — the fixed code has to
be running first. So:

1. **Manually drop in** the first beta that contains the new self-update code (unzip over the
   install folder; settings live elsewhere and are safe).
2. Turn the beta toggle **on** in Settings.
3. Publish the **next** beta. On the installed one: **Check all → Update** → it downloads,
   relaunches into the new beta. Give successive betas a visible change (a version bump is
   enough; a UI change is clearer) to confirm the update actually landed.

Betas are prereleases, so they never become "Latest" — leave them in place after a stable
release ships, or delete them later; they don't affect stable users either way.

---

## Quick reference: what each host needs

| | Windows | macOS | Linux |
|---|---|---|---|
| **Host** | Windows | Apple Silicon Mac | Linux / WSL2 |
| **Signing tool** | Azure Trusted Signing (`sign.js`) | Developer ID + notarytool | — |
| **Secrets** | `Connect-AzAccount` session | Developer ID cert + one Apple credential set | — |
| **Fails without secrets?** | No — ships unsigned (don't) | **Yes** — guard blocks it | N/A |
| **Verify with** | `Get-AuthenticodeSignature` | `codesign --test-requirement="=notarized"` + `spctl` | — |
