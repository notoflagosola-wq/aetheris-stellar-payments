import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { voucherMessage } from "./voucher";

describe("voucherMessage", () => {
  it("uses the domain, network hash, contract, and fixed-width big-endian fields", async () => {
    const passphrase = "Test SDF Network ; September 2015";
    const contractId = `C${"A".repeat(55)}`;
    const message = await voucherMessage({
      networkPassphrase: passphrase,
      contractId,
      channelId: 1n,
      amount: 256n,
      nonce: 2n,
      validUntil: 1_700_000_000n,
    });

    const expected = Buffer.concat([
      Buffer.from("AETHERIS-X402-V1\0", "utf8"),
      createHash("sha256").update(passphrase, "utf8").digest(),
      Buffer.from(contractId, "ascii"),
      Buffer.from("0000000000000001", "hex"),
      Buffer.from("00000000000000000000000000000100", "hex"),
      Buffer.from("0000000000000002", "hex"),
      Buffer.from("000000006553f100", "hex"),
    ]);
    expect(Buffer.from(message)).toEqual(expected);
    expect(message).toHaveLength(145);
  });
});
