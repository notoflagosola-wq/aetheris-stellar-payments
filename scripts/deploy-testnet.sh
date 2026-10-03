#!/usr/bin/env bash
set -euo pipefail

identity="${1:?Usage: scripts/deploy-testnet.sh <stellar-identity> [admin-address]}"
admin="${2:-}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

stellar contract build --package aetheris-channel
wasm="$root/target/wasm32v1-none/release/aetheris_channel.wasm"
if [[ ! -f "$wasm" ]]; then
  echo "Compiled WASM was not found at $wasm" >&2
  exit 1
fi

if [[ -z "$admin" ]]; then
  admin="$(stellar keys public-key "$identity")"
fi

deployment="$(stellar contract deploy \
  --wasm "$wasm" \
  --source-account "$identity" \
  --network testnet)"
contract_id="$(printf '%s\n' "$deployment" | grep -Eo 'C[A-Z2-7]{55}' | tail -n 1)"
if [[ -z "$contract_id" ]]; then
  echo "Deployment output did not contain a contract ID." >&2
  exit 1
fi

stellar contract invoke \
  --id "$contract_id" \
  --source-account "$identity" \
  --network testnet \
  -- initialize --admin "$admin"

printf 'Aetheris contract deployed and initialized.\nContract ID: %s\nAdmin:       %s\n' \
  "$contract_id" "$admin"
printf 'Set SOROBAN_CONTRACT_ID=%s in server/.env\n' "$contract_id"
printf 'Set NEXT_PUBLIC_SOROBAN_CONTRACT_ID=%s in frontend/.env.local\n' "$contract_id"
