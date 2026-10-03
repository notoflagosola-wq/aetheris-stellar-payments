import { Keypair, scValToNative, StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { openChannelArgsToScVal } from "./channel";

describe("openChannelArgsToScVal", () => {
  it("encodes the contract struct with symbol keys and explicit Soroban types", () => {
    const voucherKey = new Uint8Array(32).fill(7);
    const payer = Keypair.random().publicKey();
    const payee = Keypair.random().publicKey();
    const token = StrKey.encodeContract(new Uint8Array(32).fill(3));
    const args = openChannelArgsToScVal({
      id: 15n,
      payer,
      payee,
      token,
      voucher_key: voucherKey,
      deposit: 100_000n,
      expires_at: 1_800_000_000n,
    });

    expect(scValToNative(args)).toEqual({
      id: 15n,
      payer,
      payee,
      token,
      voucher_key: voucherKey,
      deposit: 100_000n,
      expires_at: 1_800_000_000n,
    });
  });
});
