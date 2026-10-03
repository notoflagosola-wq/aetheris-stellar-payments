import {
  Account,
  Contract,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { ChannelReader, ChannelSnapshot } from "./payment.js";

export class SorobanChannelReader implements ChannelReader {
  private readonly server: rpc.Server;
  private readonly source: string;
  private readonly contractId: string;
  private readonly networkPassphrase: string;

  constructor(options: {
    rpcUrl: string;
    sourceAccount: string;
    contractId: string;
    networkPassphrase: string;
  }) {
    this.server = new rpc.Server(options.rpcUrl);
    this.source = options.sourceAccount;
    this.contractId = options.contractId;
    this.networkPassphrase = options.networkPassphrase;
  }

  async getChannel(channelId: string): Promise<ChannelSnapshot | null> {
    const operation = new Contract(this.contractId).call(
      "get_channel",
      nativeToScVal(BigInt(channelId), { type: "u64" }),
    );
    const transaction = new TransactionBuilder(new Account(this.source, "0"), {
      fee: "100",
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();
    const result = await this.server.simulateTransaction(transaction);
    if (rpc.Api.isSimulationError(result)) {
      throw new Error(`Soroban channel query failed: ${result.error}`);
    }
    if (result.result === undefined) {
      throw new Error("Soroban channel query returned no result");
    }
    const channel = scValToNative(result.result.retval);
    if (channel === null || channel === undefined) return null;
    if (typeof channel !== "object") {
      throw new Error("Soroban channel query returned an unexpected value");
    }
    const record = channel as Record<string, unknown>;
    return {
      payer: addressString(record.payer),
      payee: addressString(record.payee),
      token: addressString(record.token),
      voucherKey: bytes(record.voucher_key),
      deposited: integer(record.deposited),
      settled: integer(record.settled),
      lastNonce: integer(record.last_nonce),
      expiresAt: integer(record.expires_at),
    };
  }
}

function addressString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || !("toString" in value)) {
    throw new Error("Soroban returned a malformed channel address");
  }
  return String(value);
}

function bytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new Error("Soroban returned a malformed voucher key");
  }
  return Uint8Array.from(value);
}

function integer(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    return BigInt(value);
  }
  throw new Error("Soroban returned a malformed channel integer");
}
