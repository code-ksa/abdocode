$ErrorActionPreference = 'Stop'
$previewRoot = Split-Path -Parent $PSScriptRoot
Push-Location $previewRoot
try {
  & bun packages/desktop/scripts/prepare.ts
  if ($LASTEXITCODE -ne 0) { throw 'Preview payload build failed.' }
  Push-Location (Join-Path $previewRoot 'packages/desktop/src-tauri')
  try {
    & bunx '@tauri-apps/cli' build --config (Join-Path $previewRoot 'preview.config.json')
    if ($LASTEXITCODE -ne 0) { throw 'Preview installer build failed.' }
  } finally { Pop-Location }
} finally { Pop-Location }
