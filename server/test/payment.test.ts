import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { getPublicKeyAsync, signAsync } from "@noble/ed25519";
import {
  createPaymentMiddleware,
  SqliteReplayStore,
  voucherMessage,
} from "../src/payment.js";

const secretKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const publicKey = await getPublicKeyAsync(secretKey);
let replayStore: SqliteReplayStore;
const networkPassphrase = "Test SDF Network ; September 2015";
const contractId = `C${"A".repeat(55)}`;
const payTo = `G${"B".repeat(55)}`;
const tokenAddress = `C${"D".repeat(55)}`;
const channelId = "7";
const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 120);

beforeEach(() => {
  replayStore = new SqliteReplayStore(":memory:");
});

afterEach(() => {
  replayStore.close();
});

function app() {
  const server = express();
  server.get(
    "/paid",
    createPaymentMiddleware({
      network: "stellar:testnet",
      networkPassphrase,
      contractId,
      tokenAddress,
      payTo,
      amount: 5n,
      description: "test resource",
      mimeType: "application/json",
      loadChannel: async () => ({
        payer: payTo,
        payee: payTo,
        token: tokenAddress,
        voucherKey: publicKey,
        deposited: 100n,
        settled: 0n,
        lastNonce: 0n,
        expiresAt,
      }),
      replayStore,
    }),
    (_req, res) => res.json({ ok: true }),
  );
  return server;
}

async function signedHeader(nonce: string, amount: string) {
  const validUntil = expiresAt - 1n;
  const message = voucherMessage(
    networkPassphrase,
    contractId,
    BigInt(channelId),
    BigInt(amount),
    BigInt(nonce),
    validUntil,
  );
  const signature = await signAsync(message, secretKey);
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: {
        scheme: "stellar-channel",
        network: "stellar:testnet",
        asset: tokenAddress,
        amount: "5",
        payTo,
      },
      payload: {
        channelId,
        cumulativeAmount: amount,
        nonce,
        validUntil: validUntil.toString(),
        signature: Buffer.from(signature).toString("hex"),
      },
    }),
  ).toString("base64");
}

describe("x402 payment middleware", () => {
  it("returns a version 2 payment requirement for unpaid requests", async () => {
    const response = await request(app()).get("/paid").expect(402);
    const paymentRequired = response.headers["payment-required"];
    if (!paymentRequired) throw new Error("Missing PAYMENT-REQUIRED header");
    const required = JSON.parse(
      Buffer.from(paymentRequired, "base64").toString(),
    );
    expect(required.x402Version).toBe(2);
    expect(required.accepts[0].scheme).toBe("stellar-channel");
  });

  it("verifies a voucher and rejects replay of its nonce", async () => {
    const signature = await signedHeader("1", "5");
    const server = app();
    await request(server)
      .get("/paid")
      .set("PAYMENT-SIGNATURE", signature)
      .expect(200);
    await request(server)
      .get("/paid")
      .set("PAYMENT-SIGNATURE", signature)
      .expect(402);
  });

  it("rejects invalid signatures without advancing the voucher cursor", async () => {
    const valid = await signedHeader("1", "5");
    const decoded = JSON.parse(Buffer.from(valid, "base64").toString());
    decoded.payload.signature = "00".repeat(64);
    const invalid = Buffer.from(JSON.stringify(decoded)).toString("base64");
    await request(app())
      .get("/paid")
      .set("PAYMENT-SIGNATURE", invalid)
      .expect(402);
    await request(app())
      .get("/paid")
      .set("PAYMENT-SIGNATURE", valid)
      .expect(200);
  });
});
