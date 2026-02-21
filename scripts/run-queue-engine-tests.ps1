$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$jiti = Join-Path $repoRoot "node_modules\.bin\jiti"
$useGlobalJiti = $false

if (-not (Test-Path $jiti)) {
  if (Get-Command jiti -ErrorAction SilentlyContinue) {
    $useGlobalJiti = $true
  } else {
    throw "Missing test runtime. Install backend dependencies (local jiti) or install global jiti."
  }
}

if ($useGlobalJiti) {
  jiti "src/queue-engine/__tests__/selector.test.ts"
} else {
  & $jiti "src/queue-engine/__tests__/selector.test.ts"
}

if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

if ($useGlobalJiti) {
  jiti "src/queue-engine/__tests__/state-machine.test.ts"
} else {
  & $jiti "src/queue-engine/__tests__/state-machine.test.ts"
}

if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Write-Host "Queue engine focused tests passed."
