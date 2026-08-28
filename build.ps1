# Build a single portable git-updater.exe (Node SEA). Run on a machine with Node >= 22.
# Output: dist/git-updater.exe  — needs no Node/Python on the target PC.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

New-Item -ItemType Directory -Force -Path "$root/dist" | Out-Null

# 1. Bundle server.js + src/* + bin/watch.js + adm-zip into one CJS file.
#    node:sea stays external (built-in). __dirname shim keeps dev fs fallback happy.
Write-Host "Bundling with esbuild..."
& node ./node_modules/esbuild/bin/esbuild server.js `
  --bundle --platform=node --format=cjs --target=node22 `
  --external:node:sea --outfile=dist/bundle.js
if ($LASTEXITCODE -ne 0) { throw "esbuild failed" }

# 2. Generate the SEA blob (embeds bundle.js + ui/index.html asset).
Write-Host "Generating SEA blob..."
& node --experimental-sea-config sea-config.json
if ($LASTEXITCODE -ne 0) { throw "sea-config failed" }

# 3. Copy the node runtime and inject the blob into it.
Copy-Item (Get-Command node).Source "dist/git-updater.exe" -Force
Write-Host "Ensuring postject (build-time only)..."
& npm install --no-save --silent postject | Out-Null
Write-Host "Injecting blob..."
& npx --yes postject "dist/git-updater.exe" NODE_SEA_BLOB "dist/sea-prep.blob" `
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
if ($LASTEXITCODE -ne 0) { throw "postject failed" }

Write-Host "Done -> dist/git-updater.exe"
Write-Host "Note: for portable installs into protected dirs (e.g. Program Files), right-click the exe -> Run as administrator. Installers prompt their own UAC."
