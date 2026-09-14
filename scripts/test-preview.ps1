param([string]$PgBin = $env:ABDO_PG_BIN)
$ErrorActionPreference = 'Stop'
$previewRoot = Split-Path -Parent $PSScriptRoot
if (-not $PgBin) {
  $pgCommand = Get-Command pg_ctl.exe -ErrorAction SilentlyContinue
  if ($pgCommand) { $PgBin = Split-Path -Parent $pgCommand.Source }
}
if (-not $PgBin) { throw 'Set ABDO_PG_BIN or pass -PgBin to an installed PostgreSQL bin directory. Live Preview tests are required.' }
foreach ($name in @('initdb.exe','pg_ctl.exe','psql.exe','pg_isready.exe')) {
  if (-not (Test-Path -LiteralPath (Join-Path $PgBin $name))) { throw "Missing PostgreSQL prerequisite: $name" }
}
foreach ($name in @('bun','git','openssl')) { if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "Missing prerequisite: $name" } }
$nativeBin = Join-Path $previewRoot 'packages/desktop/src-tauri/payload/bin'
foreach ($name in @('abdo-kernel.exe','abdo-tool-worker.exe')) {
  if (-not (Test-Path -LiteralPath (Join-Path $nativeBin $name))) { throw 'Build the desktop payload before Preview qualification.' }
}
$previousPg = $env:ABDO_PG_BIN
$previousNative = $env:ABDO_TEST_NATIVE_BINARY_DIR
Push-Location $previewRoot
try {
  $env:ABDO_PG_BIN = $PgBin
  $env:ABDO_TEST_NATIVE_BINARY_DIR = $nativeBin
  & bun test packages/engine/test packages/providers/test packages/transport-contracts/test packages/browser/test
  if ($LASTEXITCODE -ne 0) { throw 'Preview engine qualification failed.' }
  & cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml --quiet -- --include-ignored
  if ($LASTEXITCODE -ne 0) { throw 'Preview native qualification failed.' }
} finally {
  $env:ABDO_PG_BIN = $previousPg
  $env:ABDO_TEST_NATIVE_BINARY_DIR = $previousNative
  Pop-Location
}
