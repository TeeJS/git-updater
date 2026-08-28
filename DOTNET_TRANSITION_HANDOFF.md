# Git Updater: .NET Transition and OpenQuake Integration Handoff

Status: implementation handoff  
Target platform: Windows 10/11  
Primary runtime: .NET 10 LTS  
Standalone UI: WPF  
OpenQuake host: Electron 42 / Node 24  

This document supersedes all previous architecture and migration handoffs for `git-updater`.

## 1. Product objective

Rebuild `git-updater` as an on-demand Windows application that updates a user-configured set of portable and installed applications from GitHub releases.

The product must support:

- Portable applications distributed as ZIP or 7z archives.
- Installed applications distributed as MSI or explicitly supported EXE installers.
- A configurable portable-apps root folder.
- Adding and editing monitored GitHub repositories.
- Checking one app, selected apps, or all apps.
- Updating one app, selected apps, or all available updates.
- Per-app progress, failures, retries, cancellation, and force reinstall.
- A genuine native Windows application lifecycle.
- First-class integration into OpenQuake's Electron configuration UI.
- Reuse by future hosts without coupling the engine to WPF or Electron.
- Compatibility with corporate EDR, SmartScreen, App Control, proxies, TLS inspection, and application allowlisting.

## 2. Non-negotiable standalone behavior

The standalone lifecycle is:

1. The user double-clicks `GitUpdater.App.exe`.
2. One native application window opens.
3. The user checks or updates applications.
4. The user closes the window.
5. Every updater-owned process exits.

The standalone application must not require or create:

- An external browser window or tab.
- A localhost HTTP server.
- A tray process.
- A scheduled task.
- Background polling.
- A Windows service.
- Automatic startup.
- A permanently elevated process.

The application is explicitly on-demand.

## 3. Technology decision

Use:

- .NET 10 LTS.
- WPF with native XAML for the standalone interface.
- MVVM for presentation separation.
- `HttpClient` for GitHub and package downloads.
- Windows-native APIs for UAC, registry access, signatures, and process execution.
- A separate signed elevation helper.
- A signed CLI sidecar as the cross-runtime integration contract.
- Self-contained `win-x64` and `win-arm64` publishing.

Do not use WebView2, Electron, Tauri, ASP.NET, or a localhost API for the standalone UI.

References:

- [.NET support policy](https://dotnet.microsoft.com/en-us/platform/support/policy)
- [WPF overview](https://learn.microsoft.com/en-us/dotnet/desktop/wpf/overview/)
- [.NET single-file deployment](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview)

## 4. Target solution structure

```text
GitUpdater.sln

src/
  GitUpdater.Core/
    Abstractions/
    Models/
    Planning/
    Validation/
    Coordination/

  GitUpdater.GitHub/
    GitHubReleaseSource.cs
    GitHubAssetDownloader.cs
    GitHubRateLimitHandler.cs

  GitUpdater.Windows/
    Detection/
    Installation/
    Verification/
    Elevation/
    Registry/
    Filesystem/

  GitUpdater.Persistence/
    JsonConfigurationStore.cs
    JsonStateStore.cs
    LegacyConfigurationImporter.cs
    AtomicFileWriter.cs

  GitUpdater.App/
    App.xaml
    Views/
    ViewModels/
    Commands/
    Resources/

  GitUpdater.Cli/
    Program.cs
    Protocol/

  GitUpdater.Elevated/
    Program.cs
    Operations/
    Ipc/

tests/
  GitUpdater.Core.Tests/
  GitUpdater.GitHub.Tests/
  GitUpdater.Persistence.Tests/
  GitUpdater.Windows.Tests/
  GitUpdater.IntegrationTests/
  GitUpdater.App.Tests/
```

`GitUpdater.Core` must not reference WPF, Electron, registry APIs, concrete filesystem implementations, GitHub implementations, UAC, process launching, or JSON storage.

Both WPF and OpenQuake must consume the same core coordinator.

## 5. Core contracts

Define stable interfaces before building either UI:

```csharp
public interface IReleaseSource
{
    Task<ReleaseInfo> GetLatestAsync(
        RepositoryId repository,
        ReleaseChannel channel,
        CancellationToken cancellationToken);
}

public interface IInstalledVersionDetector
{
    Task<InstalledApplication?> DetectAsync(
        AppDefinition app,
        CancellationToken cancellationToken);
}

public interface IPackageSelector
{
    PackageAsset Select(
        AppDefinition app,
        ReleaseInfo release,
        Architecture architecture);
}

public interface IPackageDownloader
{
    Task<DownloadedPackage> DownloadAsync(
        PackageAsset asset,
        IProgress<DownloadProgress> progress,
        CancellationToken cancellationToken);
}

public interface IPackageVerifier
{
    Task<VerificationResult> VerifyAsync(
        AppDefinition app,
        DownloadedPackage package,
        CancellationToken cancellationToken);
}

public interface IUpdateStrategy
{
    Task<UpdateResult> ApplyAsync(
        VerifiedUpdatePlan plan,
        IProgress<UpdateProgress> progress,
        CancellationToken cancellationToken);
}

public interface IUpdateCoordinator
{
    Task<UpdatePlan> PlanAsync(
        AppId appId,
        CancellationToken cancellationToken);

    Task<UpdateResult> ExecuteAsync(
        UpdatePlan plan,
        IProgress<UpdateProgress> progress,
        CancellationToken cancellationToken);
}
```

## 6. Domain model

Every configured app receives a stable generated ID. Never key state only by `owner/repo`.

```csharp
public sealed record AppDefinition
{
    public required Guid Id { get; init; }
    public required string DisplayName { get; init; }
    public required RepositoryId Repository { get; init; }
    public required PackageMode Mode { get; init; }

    public ReleaseChannel Channel { get; init; } = ReleaseChannel.Stable;
    public string? InstallDirectory { get; init; }
    public AssetSelector? AssetSelector { get; init; }
    public InstallerTechnology? InstallerTechnology { get; init; }
    public VersionDetection? VersionDetection { get; init; }

    public IReadOnlyList<string> PreservedPaths { get; init; } = [];
    public IReadOnlyList<TrustedPublisher> TrustedPublishers { get; init; } = [];
}
```

Required supporting models include:

- `AppId`
- `RepositoryId`
- `ReleaseInfo`
- `PackageAsset`
- `DownloadedPackage`
- `VerificationResult`
- `InstalledApplication`
- `UpdatePlan`
- `VerifiedUpdatePlan`
- `UpdateProgress`
- `UpdateResult`
- `RollbackResult`

`ReleaseInfo` retains the GitHub release ID, tag, release URL, publication timestamp, draft/prerelease state, and asset list.

Use GitHub's immutable release ID as the primary update identity. Treat the tag as version/display data rather than the sole source of truth.

## 7. Required update pipeline

```text
Detect actual installed state
           |
Fetch latest approved GitHub release
           |
Select asset for package mode and machine architecture
           |
Create and present an update plan
           |
Download to controlled staging
           |
Verify hash, file type, publisher, and policy
           |
Move into protected staging when elevation is required
           |
Reverify inside the elevated helper
           |
Apply update
           |
Validate installed result
           |
Commit state atomically
```

State must never advance until installation and validation succeed.

## 8. Standalone and OpenQuake UI contract

The primary app list is app-centric:

```text
[ ] ShareX       Portable   20.2.0 -> 21.0.0   [Update] [...]
[ ] Deskflow     Portable   1.25.0 -> 1.26.0   [Update] [...]

2 updates available       [Update selected] [Update all]
```

Every row provides:

- Check now.
- Update.
- Retry.
- View GitHub release.
- Preview the selected asset.
- Edit configuration.
- Change portable/installed type.
- Force reinstall.
- Stop tracking.

Force reinstall belongs in the row's overflow menu. It must not be a global checkbox beside Update All.

Per-app states include:

```text
Not checked
Checking
Up to date
Update available
Downloading 42%
Verifying SHA-256
Verifying publisher
Waiting for administrator approval
Installing
Validating
Updated
Failed - Retry
Rollback completed
```

Only the active row should show Working. Batch operations use a queue rather than launching overlapping update transactions.

## 9. Portable update transaction

Do not overlay extracted files as the primary transaction.

Required process:

1. Download the archive.
2. Verify the archive and source policy.
3. Extract into an isolated staging directory.
4. Reject absolute paths.
5. Reject drive-qualified paths.
6. Reject `..` traversal.
7. Reject links or reparse points that escape staging.
8. Reject empty packages.
9. Flatten one wrapper directory when appropriate.
10. Build a normalized relative-path manifest.
11. Validate every final path using `Path.GetFullPath()`.
12. Confirm each final path remains beneath the application root.
13. Preserve explicitly declared user-data paths.
14. Create final staging on the same volume as the destination.
15. Rename the current app directory to a versioned backup.
16. Rename staging into place.
17. Validate the executable and installed version.
18. Delete the backup only after validation.
19. Restore the complete previous directory if validation fails.

Never trust path entries loaded from state. Never recursively delete a calculated path until the resolved absolute path has passed containment validation.

## 10. Archive support

Expose archive extraction through:

```csharp
public interface IArchiveExtractor
{
    Task<ExtractionManifest> ExtractAsync(
        string archivePath,
        string stagingDirectory,
        CancellationToken cancellationToken);
}
```

Implement ZIP first. Add 7z only with real integration fixtures.

Tests must cover:

- Valid ZIP and 7z archives.
- Corrupt archives.
- Empty archives.
- Password-protected archives.
- Nested wrapper directories.
- Traversal entries.
- Absolute and drive-qualified entries.
- Duplicate normalized paths.
- Links and reparse points.
- Locked destinations.
- Insufficient disk space.
- Cancellation.

No extraction failure may be converted into success.

## 11. Installed-application strategy

Never assume every EXE is NSIS.

Installer resolution order:

1. Explicit app configuration.
2. MSI detection.
3. Reliable Inno Setup detection.
4. Reliable NSIS detection.
5. Otherwise fail safely.

Unknown EXEs must be blocked with a clear message requiring explicit installer technology and silent arguments. Never fall back to `/S`.

Installed-version detection must support:

- MSI product code and product version.
- 64-bit uninstall registry entries.
- 32-bit uninstall registry entries.
- Per-user uninstall registry entries.
- Executable file version.
- Configured registry values.
- Configured version commands.
- Configured version files.

Remembered updater state is never sufficient proof that an application remains installed.

## 12. Network behavior

Use a long-lived `HttpClient` from dependency injection.

Requirements:

- Respect Windows and system proxy configuration.
- Support proxy default credentials without collecting passwords.
- Use the Windows certificate trust store.
- Support corporate TLS inspection certificates installed in the trusted root store.
- Enable certificate revocation checking where practical.
- Never use `DangerousAcceptAnyServerCertificateValidator`.
- Never disable TLS validation.
- Permit HTTPS only.
- Do not follow redirects to unsupported schemes.
- Enforce a maximum redirect count.
- Enforce configured size limits.
- Stream downloads rather than buffering entire packages.
- Support cancellation and timeouts.
- Log destination hostname, status, and byte count without secrets.

Reference: [HttpClient default proxy behavior](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httpclient.defaultproxy?view=net-10.0)

If private-repository support is added later, store tokens in Windows Credential Manager or DPAPI-protected storage. Never store tokens in JSON, log them, pass them on command lines, or send them to the elevated helper.

## 13. EDR-friendly staging

Do not execute installers directly from `%TEMP%`.

Personal staging:

```text
%LOCALAPPDATA%\GitUpdater\Staging\<app-id>\<release-id>\
```

Enterprise protected staging:

```text
%PROGRAMDATA%\GitUpdater\Staging\<operation-id>\
```

Enterprise execution flow:

1. The main app downloads to user staging.
2. The main app verifies hash and publisher.
3. The signed elevation helper copies the package into protected staging.
4. The helper reopens the protected copy.
5. The helper repeats all verification.
6. The helper executes only the protected verified copy.
7. Audit logs retain URL, hash, signer, and result.
8. Protected staging is removed according to a documented retention policy.

Use deterministic package filenames. Do not rename executables randomly or immediately erase all execution evidence.

## 14. Signing and trust

Sign and timestamp:

- The WPF executable.
- The CLI sidecar.
- The elevation helper.
- Shipped DLLs.
- MSI/MSIX packages.
- Signed enterprise catalogs.
- Any shipped native archive components.

Use one stable publisher identity. Signing improves publisher reputation and enterprise allowlisting, but a new binary may still initially trigger SmartScreen reputation warnings.

References:

- [SmartScreen reputation for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
- [Code signing and App Control](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/deployment/use-code-signing-for-better-control-and-protection)

For each downloaded EXE or MSI:

1. Verify GitHub's SHA-256 when available.
2. Verify an enterprise-catalog SHA-256 when configured.
3. Verify file type from bytes rather than extension.
4. Verify Authenticode using `WinVerifyTrust`.
5. Validate the certificate chain and timestamp.
6. Compare publisher identity against app policy.
7. Reject unexpected signers.
8. Reverify after copying into protected staging.

Reference: [WinVerifyTrust](https://learn.microsoft.com/en-us/windows/win32/api/wintrust/nf-wintrust-winverifytrust)

Enterprise defaults:

- Unsigned EXE/MSI: reject.
- Invalid signature: reject.
- Unexpected publisher: reject.
- Missing required digest: reject.
- Unknown installer format: reject.
- Redirect outside approved policy: reject.
- Architecture mismatch: reject.

Personal mode may allow explicit per-app exceptions after a strong warning.

## 15. Enterprise catalog

Enterprise mode must default to a signed approved catalog rather than arbitrary GitHub repositories.

```json
{
  "schemaVersion": 1,
  "apps": [
    {
      "id": "sharex-portable",
      "displayName": "ShareX",
      "repository": "ShareX/ShareX",
      "mode": "portable",
      "architectures": ["x64"],
      "assetPattern": "*portable*x64.zip",
      "trustedPublishers": ["ShareX Team"],
      "allowUnsignedArchive": true
    }
  ]
}
```

The signed catalog controls repository, channel, package mode, asset selector, architectures, package format, expected publisher, certificate policy, permitted install roots, preserved data paths, installer technology, silent arguments, allowed network destinations, and whether users may edit each field.

## 16. Elevation helper

Do not elevate the WPF or Electron UI.

For the standalone enterprise installation, install the helper at a stable signed location such as:

```text
C:\Program Files\GitUpdater\GitUpdater.Elevated.exe
```

The helper must be signed, versioned, non-persistent, and narrowly scoped. Communicate over a named pipe restricted to the initiating user SID with a one-time nonce.

Permitted operations are strongly typed:

```text
CopyVerifiedPackageToProtectedStaging
InstallVerifiedMsi
RunVerifiedKnownInstaller
ReplacePortableDirectory
RestorePortableBackup
RemoveProtectedStaging
```

Never expose generic operations such as `RunCommand`, `Execute`, or `DeletePath`.

The helper independently revalidates app ID, operation ID, package hash, signature, publisher, installer type, source and destination containment, approved install root, arguments, and enterprise catalog signature.

Treat all user-writable configuration and state as untrusted after elevation.

## 17. Prohibited production behavior

The updater implementation must not:

- Launch PowerShell or `cmd.exe`.
- Generate scripts or encoded command lines.
- Use `shell: true`.
- Use process injection or reflective executable loading.
- Create scheduled tasks, services, or startup entries.
- Disable antivirus or add Defender exclusions.
- Remove Mark-of-the-Web to bypass policy.
- Disable TLS validation.
- Execute packages from `%TEMP%`.
- Execute unknown or unsigned installers in enterprise mode.
- Accept arbitrary elevated commands.
- Download or install without a visible user action.
- Continue running after its owning UI closes.

## 18. Persistence

Use stable paths:

```text
%LOCALAPPDATA%\GitUpdater\config.json
%LOCALAPPDATA%\GitUpdater\state.json
%LOCALAPPDATA%\GitUpdater\logs\
%LOCALAPPDATA%\GitUpdater\downloads\

%PROGRAMDATA%\GitUpdater\policy\
%PROGRAMDATA%\GitUpdater\staging\
%PROGRAMDATA%\GitUpdater\logs\
```

Requirements:

- Schema versioning.
- Atomic writes using temporary file, flush, and replace.
- Last-known-good backups.
- Visible recovery warnings for corrupt state.
- No silent reinstall-all response to corrupt state.
- Path validation after deserialization.
- A process-wide operation mutex.
- Per-app locks.
- No simultaneous transactions for the same app.

Both WPF and OpenQuake access configuration through the core/CLI API. They must not edit the JSON files independently.

## 19. CLI integration protocol

`GitUpdater.Cli.exe` is mandatory and is the stable cross-runtime API.

Example commands:

```text
GitUpdater.Cli.exe list --jsonl
GitUpdater.Cli.exe check --app <app-id> --jsonl
GitUpdater.Cli.exe check --all --jsonl
GitUpdater.Cli.exe update --app <app-id> --jsonl
GitUpdater.Cli.exe update --apps <id,id,...> --jsonl
GitUpdater.Cli.exe cancel --operation <operation-id> --jsonl
GitUpdater.Cli.exe add --definition <protected-input> --jsonl
GitUpdater.Cli.exe edit --app <app-id> --definition <protected-input> --jsonl
GitUpdater.Cli.exe remove --app <app-id> --jsonl
```

Do not pass tokens, proxy credentials, raw installer commands, or large JSON documents on the command line. Use stdin or a protected IPC/file channel for structured definitions.

JSON Lines events are versioned:

```json
{"schemaVersion":1,"operationId":"...","appId":"sharex-portable","event":"checking"}
{"schemaVersion":1,"operationId":"...","appId":"sharex-portable","event":"updateAvailable","from":"20.2.0","to":"21.0.0"}
{"schemaVersion":1,"operationId":"...","appId":"sharex-portable","event":"downloading","percent":42}
{"schemaVersion":1,"operationId":"...","appId":"sharex-portable","event":"verifying"}
{"schemaVersion":1,"operationId":"...","appId":"sharex-portable","event":"completed","version":"21.0.0"}
```

Define maximum line size, total output limits, valid event names, exit codes, cancellation semantics, and backward-compatible schema evolution.

## 20. OpenQuake architecture

OpenQuake is an Electron 42 application using CommonJS JavaScript, Node 24, plain HTML/CSS/renderer JavaScript, narrow preload IPC, and signed C# native helpers.

It already provides the correct sidecar pattern:

- Native helpers live under `app/native/`.
- Helpers are unpacked from ASAR.
- The Electron main process invokes them with `spawn()` or `execFile()`.
- `afterpack.js` signs bundled helpers.
- Renderer privileges are exposed through narrow preload APIs.

Therefore, integrate the .NET updater as a first-party OpenQuake feature rather than as a literal community drop-in ZIP.

Target structure:

```text
Standalone
  GitUpdater.App.exe
    -> GitUpdater.Core

OpenQuake
  open-quake.exe
    -> app/gitUpdater.js
    -> app/native/GitUpdater.Cli.exe
       -> GitUpdater.Core
       -> GitUpdater.Elevated.exe when required
```

## 21. OpenQuake implementation changes

### 21.1 Native sidecars

Bundle architecture-matched builds:

```text
app/native/GitUpdater.Cli.exe
app/native/GitUpdater.Elevated.exe
```

Update OpenQuake's helper build/copy process, `asarUnpack`, `afterpack.js`, signing verification, SBOM, and packaging tests.

For production builds, fail packaging if required updater helpers are missing or unsigned. During development, the updater feature may degrade gracefully when the helpers are absent.

### 21.2 Main-process wrapper

Add:

```text
app/gitUpdater.js
```

Responsibilities:

- Resolve the unpacked CLI path.
- Invoke it directly without a shell.
- Pass argument arrays rather than constructed command strings.
- Parse bounded, versioned JSON Lines.
- Validate every child event.
- Maintain one operation queue.
- Forward progress to the configuration window.
- Support safe cancellation.
- Terminate stuck children after bounded timeouts.
- Redact sensitive paths and values from user-facing errors.
- Stop child processes during OpenQuake shutdown.

Conceptual API:

```javascript
await updater.list();
await updater.check(appId);
await updater.checkAll();
await updater.update(appId);
await updater.updateSelected(appIds);
await updater.cancel(operationId);
```

### 21.3 Main/preload boundary

Add narrow methods to `app/config-preload.js`:

```javascript
listManagedApps()
checkManagedApp(id)
checkAllManagedApps()
updateManagedApp(id)
updateSelectedManagedApps(ids)
cancelManagedUpdate(operationId)
onManagedUpdateProgress(callback)
```

Do not expose raw `ipcRenderer` or raw executable invocation.

Every matching `ipcMain` handler must:

- Verify the sender is the configuration window.
- Validate app IDs.
- Bound array lengths.
- Reject unknown operations.
- Prevent overlapping transactions.
- Return only JSON-serializable sanitized results.

### 21.4 OpenQuake UI

Add a first-party `Application Updates` section to the desktop configuration editor. Do not begin as a touchscreen panel app.

The UI must support the same per-app operations as WPF, including individual Update and Retry actions. It should consume the CLI progress protocol and never perform privileged filesystem or process work in the renderer.

### 21.5 Existing drop-in updater

OpenQuake already has a GitHub-backed updater for OpenQuake drop-in apps. Keep that system separate during the first migration.

The two update domains are:

1. OpenQuake drop-ins, managed by OpenQuake's existing `index.json`/ZIP repository contract.
2. External Windows applications, managed by the new .NET engine.

Do not replace the existing drop-in updater initially. It owns OpenQuake-specific behavior such as manifests, server-module invalidation, OAuth integration, host-code warnings, and user drop-in storage.

The OpenQuake UI may eventually show both categories under one Updates page while retaining separate services underneath.

### 21.6 Why this is not a literal drop-in

Shipping the self-contained .NET engine inside a community drop-in ZIP would:

- Trigger OpenQuake's executable-content consent warning.
- Duplicate a large runtime in the user apps directory.
- Execute from a user-writable location.
- Be harder for EDR and App Control to allowlist.
- Complicate updates and signing.
- Permit incompatible engine copies.

A thin visual drop-in may consume the first-party API later, but privileged orchestration remains in the Electron main process and signed native helpers.

## 22. EDR implications for OpenQuake

The expected updater process tree is:

```text
open-quake.exe
  -> GitUpdater.Cli.exe
     -> GitUpdater.Elevated.exe (only when required)
        -> approved signed installer
```

OpenQuake already invokes several native helpers and has an established Artifact Signing path, which helps make this process tree explainable and allowlistable.

However, OpenQuake also currently contains PowerShell, `cmd.exe`, AutoHotkey, and some `shell: true` execution paths. An EDR-friendly updater integration does not automatically make the entire OpenQuake process tree low-risk. Corporate validation must test the complete packaged application.

Do not add broad antivirus exclusions. Prefer signed deployment, certificate-based allow policy, or deployment through an authorized managed installer.

Reference: [App Control managed installer](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/design/configure-authorized-apps-deployed-with-a-managed-installer)

## 23. Packaging modes

### Personal standalone

- Signed self-contained x64 and arm64 builds.
- Optional signed multi-file ZIP to reduce single-file self-extraction heuristics.
- Data under `%LOCALAPPDATA%` by default.
- Optional explicit portable-data mode.
- UAC only for protected operations.

### Enterprise standalone

- Signed MSI or MSIX.
- Installation under `Program Files`.
- Protected configuration and policy under `ProgramData`.
- Stable elevation-helper path.
- Signed approved catalog.
- Intune or Configuration Manager deployment.
- Arbitrary repositories disabled unless policy permits them.

### OpenQuake

- Bundle signed, architecture-matched CLI and elevation helpers.
- Keep them outside ASAR at deterministic paths.
- Include them in OpenQuake's signing and SBOM process.
- For an enterprise OpenQuake build, prefer installed packaging over a portable wrapper that extracts to temporary locations.

## 24. Logging and auditability

Produce structured events such as:

```text
ApplicationStarted
ConfigurationLoaded
InstalledVersionDetected
ReleaseDiscovered
AssetSelected
DownloadStarted
DownloadCompleted
HashVerified
AuthenticodeVerified
PublisherVerified
UpdatePlanApproved
ElevationRequested
ProtectedCopyVerified
InstallerStarted
InstallerExited
PortableSwapCommitted
RollbackStarted
RollbackCompleted
StateCommitted
UpdateFailed
ApplicationExited
```

Include operation ID, app ID, repository, release ID, asset name, SHA-256, signer, source hostname, destination category, installer exit code, elevation state, and outcome when relevant.

Never log tokens, proxy credentials, authorization headers, pipe nonces, user secrets, or full environment dumps.

Optionally emit important enterprise events to Windows Event Log.

## 25. Legacy migration

On first launch:

1. Search only documented legacy locations for the Node `config.json`.
2. Ask before importing.
3. Generate a stable GUID for each app.
4. Preserve repository, type, asset override, target directory, installer technology, and arguments.
5. Do not trust legacy state as proof of installation.
6. Reject unsafe legacy manifest paths.
7. Reconcile every imported app with actual installed state.
8. Preserve original files unchanged.
9. Produce a migration report.

If the same repository is configured as portable and installed, create separate app IDs and state records.

## 26. Test plan

### Core and persistence

- Semantic and non-semantic version tags.
- GitHub release-ID identity.
- Architecture selection.
- Asset ambiguity and overrides.
- Config validation.
- Path containment.
- Filename sanitization.
- Publisher policies.
- Atomic state writes.
- State corruption recovery.
- Legacy migration.
- Process and per-app locking.

### Archives and portable transactions

- Real ShareX ZIP fixture.
- Real Deskflow 7z fixture.
- Corrupt and empty archives.
- Traversal and absolute paths.
- Wrapper folders.
- Locked files.
- Insufficient disk space.
- Interrupted transaction recovery.
- Validation failure rollback.
- User-data preservation.

### Installed packages

- MSI.
- NSIS.
- Inno Setup.
- Unknown EXE.
- Unsigned EXE.
- Invalid signature.
- Unexpected publisher.
- Reboot-required exit.
- Timeout.
- UAC cancellation.
- Elevated-helper authentication failure.

### Network

- System proxy.
- Authenticated proxy.
- Corporate TLS inspection certificate.
- GitHub rate limiting.
- Redirect rejection.
- Interrupted and oversized downloads.
- Digest mismatch.
- Offline behavior.
- Cancellation.

### WPF UI

- Update one app.
- Update selected apps.
- Update all.
- Retry one failure.
- Edit app type.
- Stop-tracking confirmation.
- Per-row progress.
- UAC cancellation.
- Closing during download.
- Closing during non-cancellable installation.
- Single-instance behavior.

### OpenQuake integration

- Missing helper degradation in development.
- Signed helper presence in packaged artifacts.
- Main-process sender validation.
- Preload API shape.
- JSONL event validation and output limits.
- One-app update.
- Selected-app queue.
- Cancellation and shutdown cleanup.
- ASAR-unpacked path resolution.
- x64/arm64 helper selection.
- Packaging/signing verification.
- Persistence shared with the standalone WPF app.
- Existing drop-in updater remains functional.

### Enterprise and EDR

- Microsoft Defender and cloud protection enabled.
- SmartScreen enabled.
- Representative ASR rules in Audit mode.
- App Control in Audit mode.
- Controlled Folder Access enabled.
- Standard-user operation.
- Intune/Configuration Manager deployment.
- Signed versus unsigned behavior.
- Process-tree review.
- Network-destination review.
- False-positive submission workflow.

## 27. Migration phases

### Phase 1: Core and read-only checking

- Create the .NET solution.
- Define models and interfaces.
- Implement legacy config import.
- Implement GitHub release retrieval.
- Implement actual installed-state detection.
- Build the read-only CLI protocol.

Exit criterion: ShareX and Deskflow report installed and latest versions without modifying the machine.

### Phase 2: Secure portable ZIP updates

- Implement ZIP extraction and containment.
- Implement same-volume staging.
- Implement atomic directory replacement.
- Implement rollback, validation, and state commit.

Exit criterion: ShareX portable updates, and a forced validation failure restores the prior complete directory.

### Phase 3: Deskflow and 7z

- Add 7z extraction.
- Add corrupt, empty, and traversal tests.
- Validate real Deskflow asset selection.

Exit criterion: Deskflow portable updates from a real release fixture.

### Phase 4: Verification and enterprise policy

- Add SHA-256 and Authenticode verification.
- Add publisher policies.
- Add signed enterprise catalogs.
- Add strict enterprise mode.

Exit criterion: unsigned, unapproved, mismatched, and corrupt packages are blocked before elevation.

### Phase 5: Installed apps and elevation

- Implement installer and installed-version detection.
- Implement protected staging.
- Implement the signed elevation helper and named-pipe protocol.
- Handle UAC cancellation and reboot-required outcomes.

Exit criterion: known MSI, NSIS, and Inno packages install; unknown EXEs fail safely.

### Phase 6: Native WPF app

- Implement the app list and configuration.
- Add per-app Update and Retry.
- Add selection, batching, progress, and cancellation.
- Add native folder picker and single-instance lifecycle.

Exit criterion: the standalone experience has no browser or localhost server.

### Phase 7: OpenQuake integration

- Bundle the signed CLI and elevation helper.
- Add `app/gitUpdater.js`.
- Add guarded IPC and preload methods.
- Add the Application Updates editor section.
- Add per-app and selected-app operations.
- Extend packaging and signing tests.

Exit criterion: OpenQuake updates one external app through the shared .NET engine without launching WPF or starting a server.

### Phase 8: Packaging and corporate validation

- Produce signed x64 and arm64 artifacts.
- Produce MSI/MSIX enterprise packages.
- Run an Intune/Configuration Manager pilot.
- Review Defender, ASR, App Control, process tree, and network activity.
- Produce an SBOM and release hashes.

Exit criterion: the corporate pilot completes without unexplained alerts or broad security exclusions.

## 28. Definition of done

The rewrite is complete when:

- The standalone app is fully on-demand.
- Closing it terminates all updater processes.
- One app can be checked or updated independently.
- Selected apps can be queued.
- ShareX portable works.
- Deskflow portable works.
- Installed versions come from Windows or application evidence.
- Unknown installer formats are blocked.
- Packages are verified before execution.
- Enterprise mode requires approved repositories and publishers.
- No package executes from `%TEMP%`.
- The elevated helper is stable, signed, and narrowly scoped.
- Archive and state traversal cannot escape an approved root.
- Portable updates are transactional and recoverable.
- State writes are atomic.
- Concurrent operations are locked.
- Proxies and corporate TLS inspection work.
- The updater uses no PowerShell, shell execution, localhost server, scheduled task, or service.
- Signed personal and enterprise packages are produced.
- OpenQuake exposes individual and batch updates through its editor.
- OpenQuake invokes the signed CLI without a shell.
- WPF and OpenQuake share the same engine-owned configuration and state.
- The existing OpenQuake drop-in updater remains functional.
- Corporate security receives hashes, SBOM, certificates, process trees, network destinations, and deployment guidance.
- The Node `git-updater` implementation remains available until all acceptance tests pass, then is archived rather than silently overwritten.

## 29. First implementation sprint

Implement in this order:

1. Create the .NET 10 solution and projects.
2. Define immutable domain models.
3. Define core interfaces.
4. Add stable app IDs.
5. Use GitHub release IDs for update identity.
6. Define and version the CLI JSONL protocol.
7. Implement legacy configuration import.
8. Implement read-only GitHub checking.
9. Implement actual portable installed-state detection.
10. Create the first WPF app list with per-row Check buttons.
11. Add transactional ZIP updates.
12. Add verification and path-containment tests.
13. Add per-app Update after the transaction passes integration tests.
14. Build a minimal OpenQuake `app/gitUpdater.js` wrapper against the read-only CLI.

Do not begin by recreating the current styling. Establish the update transaction, trust policy, CLI contract, elevation boundary, and on-demand lifecycle before visual refinement.
