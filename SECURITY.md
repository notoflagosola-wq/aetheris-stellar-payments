# Security

## Scope

This repository is an experimental Testnet demonstration, not an audited
payment product. Use only valueless Testnet assets. Never use mainnet funds or
production credentials with the current dashboard/server.

The contract follows checks-effects-interactions for escrow transfers,
requires authorization for payer/payee/admin actions, validates cumulative
voucher amounts and monotonic nonces, binds signatures to network and contract,
expires channels and vouchers, supports an admin pause for new settlement/open
operations, and requests persistent channel TTL extensions on contract calls.
An extension is durable only when its call is included in a submitted
transaction; RPC simulations do not commit ledger changes.

The API verifies the live Soroban channel before accepting a voucher and uses a
transactional replay cursor. The local SQLite cursor is single-host; deploying
multiple API instances without shared transactional storage can accept a
replayed voucher. The dashboard's delegate signing key is temporary in-memory
demo state, as is the latest outstanding voucher; both are lost when the page
is reloaded or closed. Settle outstanding claims before closing the dashboard.

## Reporting

Please do not publish exploit details in a public issue. If this repository has
GitHub private vulnerability reporting enabled, use that channel; otherwise
contact the maintainers privately before disclosing details.

Security reports should include affected version/commit, impact, a minimal
reproduction, and any proposed mitigation. Do not include real secret keys,
seed phrases, or private customer data.
