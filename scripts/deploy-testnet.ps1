param(
  [Parameter(Mandatory = $true)]
  [string]$Identity,
  [string]$Network = "testnet",
  [string]$AdminAddress
)

$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
Push-Location $workspace

function Invoke-StellarCli {
  param([string[]]$Arguments)

  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = & stellar @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousPreference
  }

  if ($exitCode -ne 0) {
    throw "Stellar CLI command failed (exit $exitCode):`n$($output | Out-String)"
  }
  return $output
}

try {
  Invoke-StellarCli -Arguments @("contract", "build", "--package", "aetheris-channel") | Out-Null

  $wasm = Join-Path $workspace "target\wasm32v1-none\release\aetheris_channel.wasm"
  if (-not (Test-Path $wasm)) { throw "Compiled WASM was not found at $wasm." }

  if (-not $AdminAddress) {
    $AdminAddress = (Invoke-StellarCli -Arguments @("keys", "public-key", $Identity) | Out-String).Trim()
    if (-not $AdminAddress) { throw "Could not resolve the admin address for identity '$Identity'." }
  }

  $deployOutput = Invoke-StellarCli -Arguments @(
    "contract", "deploy",
    "--wasm", $wasm,
    "--source-account", $Identity,
    "--network", $Network
  )
  $contractMatches = [regex]::Matches(($deployOutput | Out-String), "C[A-Z2-7]{55}")
  if ($contractMatches.Count -eq 0) {
    throw "Deployment succeeded but no contract ID was found in the CLI output."
  }
  $contractId = $contractMatches[$contractMatches.Count - 1].Value

  Invoke-StellarCli -Arguments @(
    "contract", "invoke",
    "--id", $contractId,
    "--source-account", $Identity,
    "--network", $Network,
    "--", "initialize", "--admin", $AdminAddress
  ) | Out-Null

  Write-Output "Aetheris contract deployed and initialized."
  Write-Output "Contract ID: $contractId"
  Write-Output "Admin:       $AdminAddress"
  Write-Output "Set SOROBAN_CONTRACT_ID=$contractId in server/.env"
  Write-Output "Set NEXT_PUBLIC_SOROBAN_CONTRACT_ID=$contractId in frontend/.env.local"
}
finally {
  Pop-Location
}
