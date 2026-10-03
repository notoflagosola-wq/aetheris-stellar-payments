# Aetheris voucher format

The Aetheris channel scheme uses a fixed-width Ed25519 message so the Soroban
contract, API verifier, and browser client can independently construct identical
bytes. All integers are unsigned big-endian encodings except `amount`, whose
positive values use the same 16-byte representation as a signed Soroban `i128`.

| Field | Encoding | Length |
| --- | --- | ---: |
| Domain | UTF-8 `AETHERIS-X402-V1` followed by NUL | 17 bytes |
| Stellar network ID | SHA-256 of the network passphrase | 32 bytes |
| Contract ID | ASCII Stellar contract StrKey (for example `C...`) | 56 bytes |
| Channel ID | `u64` big-endian | 8 bytes |
| Cumulative amount | positive `i128` big-endian | 16 bytes |
| Voucher nonce | `u64` big-endian | 8 bytes |
| Valid-until timestamp | Unix seconds as `u64` big-endian | 8 bytes |

The concatenated message is signed with the 32-byte channel delegate key. The
signature is exactly 64 bytes and is sent as lowercase hexadecimal in the
`PAYMENT-SIGNATURE` JSON payload. Amounts use the token's smallest unit.

The channel contract binds the delegate public key to the payer's
`open_channel` authorization. A valid signature is not sufficient on its own:
the server also reads the channel from Soroban RPC, checks its payee, token,
deposit and expiry, and advances a durable nonce/amount cursor before granting
the resource. The contract independently checks the signature, nonce, expiry,
and deposit before transferring a claim.

The request signature is deliberately domain-separated by network, contract,
channel, and field widths to make cross-network and cross-contract replays
invalid. Clients must never sign an amount greater than the authorized deposit.
