$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$sourceModel = "hf.co/empero-ai/Qwen3.8-9B-Distill-GGUF:Q4_K_M"
$ownedAlias = "empero-qwen3.8-9b-gpu:latest"
$modelFile = Join-Path $PSScriptRoot "..\packages\providers\models\Empero-Qwen3.8-9B-GPU.Modelfile"

if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  throw "Ollama is required before installing the Empero GPU profile."
}

$nvidia = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match "NVIDIA" } | Select-Object -First 1
if (-not $nvidia) {
  throw "GPU-only installation refused: no NVIDIA GPU was detected."
}

ollama pull $sourceModel
if ($LASTEXITCODE -ne 0) { throw "Failed to pull the pinned Empero Q4_K_M source model." }

ollama create $ownedAlias -f $modelFile
if ($LASTEXITCODE -ne 0) { throw "Failed to create the owned Empero GPU alias." }

$body = @{
  model = $ownedAlias
  prompt = "Reply with exactly GPU_OK"
  stream = $false
  think = $false
  keep_alive = "5m"
  options = @{ num_ctx = 65536; num_predict = 16 }
} | ConvertTo-Json -Depth 4

$reply = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/generate" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 300
if (-not $reply.done -or $reply.response.Trim() -ne "GPU_OK") {
  throw "Empero loaded but failed its bounded generation check."
}

$processLine = (ollama ps | Select-String -SimpleMatch $ownedAlias | Select-Object -First 1).Line
if (-not $processLine -or $processLine -notmatch "100% GPU") {
  throw "GPU-only qualification failed: Ollama did not report 100% GPU."
}

[pscustomobject]@{
  status = "EMPERO_GPU_READY"
  source = $sourceModel
  alias = $ownedAlias
  gpu = $nvidia.Name
  processor = "100% GPU"
  context = 65536
} | ConvertTo-Json
