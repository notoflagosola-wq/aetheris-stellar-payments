import { getPublicKeyAsync, signAsync, utils } from "@noble/ed25519";

const DOMAIN = new TextEncoder().encode("AETHERIS-X402-V1\0");

export interface VoucherSigner {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export async function createVoucherSigner(): Promise<VoucherSigner> {
  const secretKey = utils.randomPrivateKey();
  const publicKey = await getPublicKeyAsync(secretKey);
  return { secretKey, publicKey };
}

export async function signVoucher(
  signer: VoucherSigner,
  options: {
    networkPassphrase: string;
    contractId: string;
    channelId: bigint;
    amount: bigint;
    nonce: bigint;
    validUntil: bigint;
  },
): Promise<string> {
  const message = await voucherMessage(options);
  const signature = await signAsync(message, signer.secretKey);
  return toHex(signature);
}

export async function voucherMessage(options: {
  networkPassphrase: string;
  contractId: string;
  channelId: bigint;
  amount: bigint;
  nonce: bigint;
  validUntil: bigint;
}): Promise<Uint8Array> {
  const networkId = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(options.networkPassphrase),
    ),
  );
  return concat(
    DOMAIN,
    networkId,
    new TextEncoder().encode(options.contractId),
    integerBytes(options.channelId, 8),
    integerBytes(options.amount, 16),
    integerBytes(options.nonce, 8),
    integerBytes(options.validUntil, 8),
  );
}

function integerBytes(value: bigint, length: number): Uint8Array {
  if (value < 0n || value >= 1n << BigInt(length * 8)) {
    throw new RangeError("Voucher integer is out of range");
  }
  const result = new Uint8Array(length);
  for (let index = length - 1; index >= 0; index -= 1) {
    result[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return result;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
