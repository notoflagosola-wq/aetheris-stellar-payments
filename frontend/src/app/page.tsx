"use client";

import { useState } from "react";
import {
  Contract,
  Networks,
  rpc,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { contract } from "@stellar/stellar-sdk";
import { requestAccess, signAuthEntry, signTransaction } from "@stellar/freighter-api";
import { openChannelArgsToScVal } from "@/lib/channel";
import { createVoucherSigner, signVoucher, type VoucherSigner } from "@/lib/voucher";

const RPC_URL = "https://soroban-testnet.stellar.org";
const PRICE = BigInt(process.env.NEXT_PUBLIC_REQUEST_PRICE ?? "100");
const DEPOSIT = 100_000n;

type Status = "idle" | "working" | "success" | "error";

interface SignedVoucher {
  amount: bigint;
  nonce: bigint;
  validUntil: bigint;
  signature: string;
}

interface SettlementMethods {
  settle: (args: {
    id: bigint;
    amount: bigint;
    nonce: bigint;
    valid_until: bigint;
    signature: Uint8Array;
  }) => Promise<contract.AssembledTransaction<bigint>>;
}

export default function Home() {
  const [wallet, setWallet] = useState("");
  const [channelId, setChannelId] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [calls, setCalls] = useState(0);
  const [voucherSigner, setVoucherSigner] = useState<VoucherSigner | null>(null);
  const [latestVoucher, setLatestVoucher] = useState<SignedVoucher | null>(null);
  const [settledAmount, setSettledAmount] = useState(0n);

  const contractId = process.env.NEXT_PUBLIC_SOROBAN_CONTRACT_ID ?? "";
  const tokenId = process.env.NEXT_PUBLIC_SOROBAN_TOKEN_ID ?? "";
  const payTo = process.env.NEXT_PUBLIC_PAY_TO ?? "";
  const apiUrl =
    process.env.NEXT_PUBLIC_PAID_API_URL ?? "http://localhost:4020/paid/data";

  async function connectWallet() {
    setStatus("working");
    setMessage("");
    try {
      const response = await requestAccess();
      if (response.error) throw new Error(response.error.message);
      if (!response.address) throw new Error("Freighter did not return an account");
      setWallet(response.address);
      setStatus("success");
      setMessage("Freighter connected on Stellar Testnet.");
    } catch (error) {
      setStatus("error");
      setMessage(errorMessage(error));
    }
  }

  async function openChannel() {
    setStatus("working");
    setMessage("Preparing the Testnet escrow transaction...");
    try {
      if (!wallet) throw new Error("Connect Freighter before opening a channel");
      if (!contractId || !tokenId || !payTo) {
        throw new Error("Set the contract, token, and payee in frontend/.env.local");
      }
      const signer = await createVoucherSigner();
      const id = randomChannelId();
      const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 86_400);
      const server = new rpc.Server(RPC_URL);
      const account = await server.getAccount(wallet);
      const contract = new Contract(contractId);
      const args = openChannelArgsToScVal({
        id,
        payer: wallet,
        payee: payTo,
        token: tokenId,
        voucher_key: signer.publicKey,
        deposit: DEPOSIT,
        expires_at: expiresAt,
      });
      const operation = contract.call("open_channel", args);
      const transaction = new TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(operation)
        .setTimeout(60)
        .build();
      const simulation = await server.simulateTransaction(transaction);
      if (rpc.Api.isSimulationError(simulation)) {
        throw new Error(`Transaction simulation failed: ${simulation.error}`);
      }
      if (simulation.result === undefined) {
        throw new Error("Transaction simulation returned no result");
      }
      const prepared = rpc.assembleTransaction(transaction, simulation).build();
      const signed = await signTransaction(prepared.toXDR(), {
        networkPassphrase: Networks.TESTNET,
      });
      if (signed.error) throw new Error(signed.error.message);
      if (!signed.signedTxXdr) throw new Error("Freighter returned no signed transaction");
      const signedTransaction = TransactionBuilder.fromXDR(
        signed.signedTxXdr,
        Networks.TESTNET,
      );
      const submitted = await server.sendTransaction(signedTransaction);
      if (submitted.status === "ERROR") {
        throw new Error(`Testnet rejected the transaction: ${submitted.errorResult}`);
      }
      await waitForTransaction(server, submitted.hash);
      setChannelId(id.toString());
      setVoucherSigner(signer);
      setLatestVoucher(null);
      setSettledAmount(0n);
      setCalls(0);
      setStatus("success");
      setMessage(`Channel ${id.toString()} opened. Voucher key stays in this tab's memory.`);
    } catch (error) {
      setStatus("error");
      setMessage(errorMessage(error));
    }
  }

  async function callPaidApi() {
    setStatus("working");
    try {
      if (!channelId || !voucherSigner) {
        throw new Error("Open a channel in this tab before calling the API");
      }
      const challenge = await fetch(apiUrl);
      if (challenge.status !== 402) {
        throw new Error(`Expected HTTP 402 from the API, received ${challenge.status}`);
      }
      const encodedRequirements = challenge.headers.get("PAYMENT-REQUIRED");
      if (!encodedRequirements) {
        throw new Error("The API omitted the PAYMENT-REQUIRED header");
      }
      const requirements = JSON.parse(atob(encodedRequirements)) as {
        accepts: Array<{
          scheme: string;
          network: string;
          asset: string;
          amount: string;
          payTo: string;
        }>;
      };
      const accepted = requirements.accepts[0];
      if (!accepted || accepted.scheme !== "stellar-channel") {
        throw new Error("The API did not offer the Stellar channel scheme");
      }
      const nonce = BigInt(calls + 1);
      const cumulativeAmount = BigInt(accepted.amount) * nonce;
      const validUntil = BigInt(Math.floor(Date.now() / 1000) + 300);
      const signature = await signVoucher(voucherSigner, {
        networkPassphrase: Networks.TESTNET,
        contractId,
        channelId: BigInt(channelId),
        amount: cumulativeAmount,
        nonce,
        validUntil,
      });
      const payment = {
        x402Version: 2,
        accepted,
        payload: {
          channelId,
          cumulativeAmount: cumulativeAmount.toString(),
          nonce: nonce.toString(),
          validUntil: validUntil.toString(),
          signature,
        },
      };
      const response = await fetch(apiUrl, {
        headers: {
          "PAYMENT-SIGNATURE": btoa(JSON.stringify(payment)),
        },
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error ?? `API returned ${response.status}`);
      }
      setLatestVoucher({
        amount: cumulativeAmount,
        nonce,
        validUntil,
        signature,
      });
      setCalls(Number(nonce));
      setStatus("success");
      setMessage(JSON.stringify(body));
    } catch (error) {
      setStatus("error");
      setMessage(errorMessage(error));
    }
  }

  async function settleLatestVoucher() {
    setStatus("working");
    try {
      if (!wallet) throw new Error("Connect the payee's Freighter account to settle");
      if (wallet !== payTo) {
        throw new Error("Switch Freighter to the configured payee account before settling");
      }
      if (!channelId || !latestVoucher) {
        throw new Error("There is no outstanding signed voucher to settle");
      }
      const client = await contract.Client.from<SettlementMethods>({
        contractId,
        networkPassphrase: Networks.TESTNET,
        rpcUrl: RPC_URL,
        publicKey: wallet,
        signTransaction: async (transactionXdr, options) => {
          const result = await signTransaction(transactionXdr, {
            networkPassphrase: options?.networkPassphrase ?? Networks.TESTNET,
            address: wallet,
          });
          if (result.error) throw new Error(result.error.message);
          if (!result.signedTxXdr) {
            throw new Error("Freighter returned no signed settlement transaction");
          }
          return {
            signedTxXdr: result.signedTxXdr,
            signerAddress: result.signerAddress,
          };
        },
        signAuthEntry: async (entryXdr, options) => {
          const result = await signAuthEntry(entryXdr, {
            networkPassphrase: options?.networkPassphrase ?? Networks.TESTNET,
            address: wallet,
          });
          if (result.error) throw new Error(result.error.message);
          if (!result.signedAuthEntry) {
            throw new Error("Freighter returned no signed Soroban authorization");
          }
          return {
            signedAuthEntry: result.signedAuthEntry,
            signerAddress: result.signerAddress,
          };
        },
      });
      const transaction = await client.settle({
        id: BigInt(channelId),
        amount: latestVoucher.amount,
        nonce: latestVoucher.nonce,
        valid_until: latestVoucher.validUntil,
        signature: fromHex(latestVoucher.signature),
      });
      await transaction.signAuthEntries({ address: wallet });
      const submitted = await transaction.signAndSend();
      setSettledAmount(latestVoucher.amount);
      setLatestVoucher(null);
      setStatus("success");
      setMessage(
        `Settled ${latestVoucher.amount.toString()} token units on Stellar Testnet. Transaction: ${submitted.sendTransactionResponse?.hash ?? "confirmed"}`,
      );
    } catch (error) {
      setStatus("error");
      setMessage(errorMessage(error));
    }
  }

  return (
    <main className="shell">
      <nav className="topbar">
        <a className="brand" href="#">
          <span className="brand-mark">A</span>
          <span>AETHERIS</span>
        </a>
        <div className="network-pill"><span className="online-dot" /> STELLAR TESTNET</div>
        <button className="wallet-button" onClick={connectWallet}>
          {wallet ? `${wallet.slice(0, 5)}...${wallet.slice(-5)}` : "Connect Freighter"}
        </button>
      </nav>

      <section className="hero">
        <div className="eyebrow"><span /> PAY-PER-REQUEST, WITHOUT PER-REQUEST SETTLEMENT</div>
        <h1>Micropayments<br /><em>at machine speed.</em></h1>
        <p className="intro">
          Open one Soroban escrow channel. Sign tiny off-chain vouchers for each API call.
          Redeem them on-chain when it makes sense.
        </p>
        <div className="hero-meta">
          <span><b>01</b> Deposit once</span>
          <span><b>02</b> Sign off-chain</span>
          <span><b>03</b> Settle later</span>
        </div>
      </section>

      <section className="workspace">
        <div className="section-heading">
          <div><span className="section-index">01 / CHANNEL</span><h2>Your payment rail</h2></div>
          <span className="asset-tag">SOROBAN · TESTNET TOKEN</span>
        </div>

        <div className="card-grid">
          <article className="panel channel-panel">
            <div className="panel-label">ESCROW CHANNEL <span className="status-dot" /></div>
            <div className="metric">{channelId ? "ACTIVE" : "NOT OPEN"}</div>
            <p className="muted">
              {channelId ? `Channel ${channelId}` : "Your deposit stays in contract escrow."}
            </p>
            <div className="divider" />
            <div className="detail-row"><span>Wallet</span><span>{wallet ? `${wallet.slice(0, 8)}...${wallet.slice(-5)}` : "Not connected"}</span></div>
            <div className="detail-row"><span>Payee</span><span>{payTo ? `${payTo.slice(0, 8)}...${payTo.slice(-5)}` : "Not configured"}</span></div>
            <div className="detail-row"><span>Deposit</span><span>{DEPOSIT.toString()} token units</span></div>
            <div className="detail-row"><span>Request price</span><span>{PRICE.toString()} token units</span></div>
            <button className="primary-button" disabled={status === "working" || Boolean(channelId)} onClick={openChannel}>
              {channelId ? "Channel opened" : status === "working" ? "Waiting for wallet..." : "Open channel"}
              <span>↗</span>
            </button>
            <p className="hint">Freighter confirms the Testnet transaction. A temporary delegate key signs usage vouchers.</p>
          </article>

          <article className="panel request-panel">
            <div className="panel-label">HTTP 402 FLOW <span className="route-tag">GET /paid/data</span></div>
            <div className="request-line"><span className="method">GET</span><code>{apiUrl}</code></div>
            <div className="flow-box">
              <div className="flow-step"><span className="flow-number">1</span><div><b>Discover</b><small>API returns 402 + payment requirements</small></div><span className="flow-result">402</span></div>
              <div className="flow-connector" />
              <div className="flow-step"><span className="flow-number">2</span><div><b>Authorize</b><small>Delegate signs cumulative voucher</small></div><span className="flow-result">✳</span></div>
              <div className="flow-connector" />
              <div className="flow-step"><span className="flow-number">3</span><div><b>Access</b><small>Server checks channel and replay cursor</small></div><span className="flow-result">200</span></div>
            </div>
            <div className="request-footer">
              <div><span className="section-index">VOUCHERS SIGNED</span><strong>{String(calls).padStart(2, "0")}</strong></div>
              <div><span className="section-index">TOTAL AUTHORIZED</span><strong>{(BigInt(calls) * PRICE).toString()} <small>units</small></strong></div>
            </div>
            <button className="secondary-button" disabled={status === "working" || !channelId} onClick={callPaidApi}>
              {status === "working" ? "Signing & requesting..." : "Call the paid API"} <span>→</span>
            </button>
            <div className="settlement-box">
              <div>
                <span className="section-index">ON-CHAIN SETTLEMENT</span>
                <strong>{settledAmount.toString()} <small>units settled</small></strong>
              </div>
              <button
                className="settle-button"
                disabled={
                  status === "working" ||
                  !latestVoucher ||
                  wallet !== payTo
                }
                onClick={settleLatestVoucher}
              >
                {latestVoucher
                  ? wallet === payTo
                    ? `Settle ${latestVoucher.amount.toString()} units`
                    : "Connect payee wallet"
                  : "No outstanding voucher"}
                <span>↗</span>
              </button>
            </div>
            <p className="hint">
              Vouchers are off-chain until the configured payee submits the latest claim in Freighter.
              {wallet !== payTo ? " Switch Freighter to the payee account, then reconnect to settle." : ""}
            </p>
          </article>
        </div>

        <div className={`notice ${status}`}>
          <span className="notice-mark">{status === "error" ? "!" : status === "success" ? "✓" : "i"}</span>
          <div><b>{status === "error" ? "Action needs attention" : status === "success" ? "Aetheris update" : "Ready for Testnet"}</b><p>{message || "Connect Freighter, open a channel, then exercise the x402-style paid endpoint."}</p></div>
        </div>
      </section>

      <footer><span>BUILT ON STELLAR · POWERED BY SOROBAN</span><span>VOUCHER CHANNEL DEMO <b>v0.1</b></span></footer>
    </main>
  );
}

function randomChannelId(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let result = 0n;
  for (const byte of bytes) result = (result << 8n) | BigInt(byte);
  return result === 0n ? 1n : result;
}

function fromHex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2}){64}$/.test(value)) {
    throw new Error("The saved voucher signature is malformed");
  }
  return Uint8Array.from(
    value.match(/.{2}/g) ?? [],
    (byte) => Number.parseInt(byte, 16),
  );
}

async function waitForTransaction(server: rpc.Server, hash: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await server.getTransaction(hash);
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) return;
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error("Channel transaction failed during Testnet execution");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Timed out waiting for Stellar Testnet confirmation");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected wallet or network error";
}
