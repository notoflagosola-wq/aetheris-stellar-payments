# Soroban channel contract API

The contract is `AetherisChannel` in `contracts/channel`. Soroban-generated
clients expose these public functions:

| Function | Purpose | Authorization |
| --- | --- | --- |
| `initialize(admin)` | Set the one-time circuit-breaker admin | `admin` |
| `set_paused(admin, paused)` | Pause or resume channel opens and settlements | Current admin |
| `open_channel(args)` | Deposit a token and bind the voucher delegate | `args.payer` |
| `settle(id, amount, nonce, valid_until, signature)` | Redeem a signed cumulative voucher | Channel payee |
| `refund(id)` | Return the unsettled deposit after expiry | Channel payer |
| `get_channel(id)` | Read channel state | Public |
| `voucher_message(id, amount, nonce, valid_until)` | Return canonical bytes for signing | Public |

`OpenChannelArgs` contains `id: u64`, `payer: Address`, `payee: Address`,
`token: Address`, `voucher_key: BytesN<32>`, `deposit: i128`, and
`expires_at: u64`. The payer's Soroban authorization covers the complete
structure, so the delegate key, token, receiver, amount, channel id, and expiry
cannot be substituted independently of the deposit transaction.

`settle` requires a strictly increasing nonce and cumulative amount, a valid
Ed25519 signature from the stored delegate key, a deadline later than the
current ledger timestamp but no later than the channel expiry, and an amount
not greater than the original deposit. It transfers only the difference from
the previous settled amount. This makes a newer voucher replaceable by a
higher cumulative voucher without requiring a transfer for every request.

Channels have a maximum 30-day lifetime. A payer can recover the remainder only
after the expiry timestamp; refunds remain available while the circuit breaker
is paused. The admin can pause new channels and settlements but cannot move
escrow. Persistent channel state and contract instance storage request TTL
extensions; on-chain rent is charged when the state-changing transaction is
submitted.

Errors are explicit contract errors: `AlreadyInitialized`, `NotInitialized`,
`Unauthorized`, `Paused`, `ChannelExists`, `ChannelNotFound`, `InvalidAmount`,
`InvalidExpiry`, `ChannelStillActive`, `InvalidVoucher`, `VoucherExpired`, and
`NothingToRefund`.
