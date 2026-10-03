import { nativeToScVal } from "@stellar/stellar-sdk";

export interface OpenChannelArgs {
  id: bigint;
  payer: string;
  payee: string;
  token: string;
  voucher_key: Uint8Array;
  deposit: bigint;
  expires_at: bigint;
}

export function openChannelArgsToScVal(args: OpenChannelArgs) {
  return nativeToScVal(args, {
    type: {
      id: ["symbol", "u64"],
      payer: ["symbol", "address"],
      payee: ["symbol", "address"],
      token: ["symbol", "address"],
      voucher_key: ["symbol", "bytes"],
      deposit: ["symbol", "i128"],
      expires_at: ["symbol", "u64"],
    },
  });
}
