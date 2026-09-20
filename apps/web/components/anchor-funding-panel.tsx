"use client";

import { useEffect, useState } from "react";

import type { AnchorDeposit, AnchorQuote, AnchorTransaction, DegradedRailReceipt } from "../lib/anchor-types";
import { normalizeTryAmount } from "../lib/anchor-types";
import { PHLOEM_NETWORK } from "../lib/network";
import type { WalletConnection } from "./wallet-panel";

interface AnchorFundingPanelProps {
  onSettlementCompleted: () => void;
  wallet: WalletConnection | null;
}

type BusyAction = "auth" | "degraded" | "deposit" | "quote" | "simulate" | "status" | null;
type ContinuityState = "live" | "stalled" | "degraded";

async function responseJson<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request returned HTTP ${response.status}.`);
  return payload;
}

function walletIsReady(wallet: WalletConnection | null): boolean {
  return Boolean(
    wallet?.readiness.exists &&
    wallet.readiness.usdcTrustline &&
    Number(wallet.readiness.xlmBalance ?? "0") > 0,
  );
}

export function AnchorFundingPanel({ onSettlementCompleted, wallet }: AnchorFundingPanelProps) {
  const [amount, setAmount] = useState("150.00");
  const [authenticated, setAuthenticated] = useState(false);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [deposit, setDeposit] = useState<AnchorDeposit | null>(null);
  const [degradedReceipt, setDegradedReceipt] = useState<DegradedRailReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kycStatus, setKycStatus] = useState<string | null>(null);
  const [quote, setQuote] = useState<AnchorQuote | null>(null);
  const [settlementAuthorized, setSettlementAuthorized] = useState(false);
  const [transaction, setTransaction] = useState<AnchorTransaction | null>(null);
  const [continuity, setContinuity] = useState<ContinuityState>("live");

  useEffect(() => {
    setAuthenticated(false);
    setDeposit(null);
    setDegradedReceipt(null);
    setError(null);
    setKycStatus(null);
    setQuote(null);
    setSettlementAuthorized(false);
    setTransaction(null);
    setContinuity("live");
  }, [wallet?.address]);

  async function authenticate() {
    if (!wallet) return;
    setBusy("auth");
    setError(null);
    try {
      const challengeResponse = await fetch(`/api/anchor/challenge?account=${encodeURIComponent(wallet.address)}`, {
        cache: "no-store",
      });
      const challenge = await responseJson<{ network_passphrase: string; transaction: string }>(challengeResponse);
      const { StellarWalletsKit } = await import("@creit.tech/stellar-wallets-kit");
      const { signedTxXdr } = await StellarWalletsKit.signTransaction(challenge.transaction, {
        address: wallet.address,
        networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
      });
      const sessionResponse = await fetch("/api/anchor/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: wallet.address, transaction: signedTxXdr }),
      });
      const session = await responseJson<{ authenticated: boolean; kycStatus: string }>(sessionResponse);
      setAuthenticated(session.authenticated);
      setKycStatus(session.kycStatus);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "SEP-10 authentication failed.");
    } finally {
      setBusy(null);
    }
  }

  async function requestQuote() {
    if (!wallet) return;
    setBusy("quote");
    setError(null);
    setDeposit(null);
    setDegradedReceipt(null);
    setTransaction(null);
    setContinuity("live");
    try {
      const normalized = normalizeTryAmount(amount);
      const response = await fetch("/api/anchor/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: wallet.address, amount: normalized }),
      });
      const payload = await responseJson<{ quote: AnchorQuote }>(response);
      setAmount(normalized);
      setQuote(payload.quote);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "SEP-38 quote failed.");
    } finally {
      setBusy(null);
    }
  }

  async function createDeposit() {
    if (!wallet || !quote) return;
    setBusy("deposit");
    setError(null);
    try {
      const response = await fetch("/api/anchor/deposit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: wallet.address, amount: quote.sell_amount, quoteId: quote.id }),
      });
      const payload = await responseJson<{ deposit: AnchorDeposit }>(response);
      setDeposit(payload.deposit);
      setDegradedReceipt(null);
      setSettlementAuthorized(false);
      setContinuity("live");
      await refreshStatus(payload.deposit.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "SEP-6 deposit creation failed.");
    } finally {
      setBusy(null);
    }
  }

  async function refreshStatus(id = deposit?.id): Promise<AnchorTransaction | null> {
    if (!id) return null;
    setBusy((current) => current ?? "status");
    setError(null);
    try {
      const response = await fetch(`/api/anchor/status?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const payload = await responseJson<{ transaction: AnchorTransaction }>(response);
      setTransaction(payload.transaction);
      if (payload.transaction.status === "completed") {
        setContinuity("live");
        setDegradedReceipt(null);
        onSettlementCompleted();
      }
      return payload.transaction;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Anchor status check failed.");
      return null;
    } finally {
      setBusy((current) => current === "status" ? null : current);
    }
  }

  async function simulateTransfer() {
    if (!deposit || !quote || !settlementAuthorized) return;
    setBusy("simulate");
    setError(null);
    try {
      const response = await fetch("/api/anchor/simulate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: quote.sell_amount, id: deposit.id }),
      });
      await responseJson<{ accepted: true }>(response);
      setSettlementAuthorized(false);
      let latest: AnchorTransaction | null = null;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        latest = await refreshStatus(deposit.id);
        if (!latest || latest.status === "completed" || latest.status === "error") break;
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
      if (!latest || latest.status !== "completed") {
        setContinuity("stalled");
        setError(latest
          ? "The official Anchor accepted the sandbox request but did not reach completed status. You may keep retrying the official status or record an explicitly degraded fiat-rail fallback."
          : "The official Anchor accepted the sandbox request but its status endpoint could not be read. You may retry the official status or record an explicitly degraded fiat-rail fallback.");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sandbox transfer simulation failed.");
    } finally {
      setBusy(null);
    }
  }

  async function recordDegradedFallback() {
    if (!wallet || !deposit) return;
    setBusy("degraded");
    setError(null);
    try {
      const response = await fetch("/api/anchor/degraded", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: wallet.address, id: deposit.id }),
      });
      const payload = await responseJson<{ receipt: DegradedRailReceipt }>(response);
      setDegradedReceipt(payload.receipt);
      setContinuity("degraded");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Degraded rail evidence could not be recorded.");
    } finally {
      setBusy(null);
    }
  }

  const ready = walletIsReady(wallet);
  const complete = transaction?.status === "completed";
  const statusLabel = complete
    ? "USDC received"
    : continuity === "degraded"
      ? "Degraded demo"
      : continuity === "stalled"
        ? "Anchor stalled"
        : authenticated
          ? "Anchor authenticated"
          : "Signature pending";

  return (
    <section className="panel anchor-panel" aria-labelledby="anchor-funding-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Real local-payment ingress</p>
          <h2 id="anchor-funding-title">TRY → Anchor → Stellar USDC</h2>
        </div>
        <span className={`status-chip ${complete ? "is-ready" : continuity === "live" ? "is-pending" : "is-degraded"}`}>
          <span aria-hidden="true" className="status-dot" />
          {statusLabel}
        </span>
      </div>

      <p className="panel-copy">
        The bank leg is the official sandbox. SEP discovery, authentication, quote, deposit status and resulting USDC movement use the real Testnet path.
      </p>

      <div className="funding-flow">
        <section className="flow-step" aria-labelledby="anchor-step-auth">
          <span className="step-index">01</span>
          <h3 id="anchor-step-auth">Authenticate</h3>
          <p>Signs a validated sequence-0 SEP-10 challenge. It cannot move funds.</p>
          <button className="primary-button" disabled={!ready || authenticated || busy !== null} onClick={() => void authenticate()} type="button">
            {busy === "auth" ? "Awaiting Freighter…" : authenticated ? "Authenticated" : "Sign SEP-10 challenge"}
          </button>
          {kycStatus ? <small>KYC status: {kycStatus}</small> : null}
        </section>

        <section className="flow-step" aria-labelledby="anchor-step-quote">
          <span className="step-index">02</span>
          <h3 id="anchor-step-quote">Lock quote</h3>
          <label className="form-field">
            <span>Amount to send</span>
            <span className="amount-input"><input disabled={!authenticated || busy !== null} inputMode="decimal" onChange={(event) => {
              setAmount(event.target.value);
              setQuote(null);
              setDeposit(null);
              setDegradedReceipt(null);
              setTransaction(null);
              setContinuity("live");
            }} value={amount} /><b>TRY</b></span>
          </label>
          <button className="secondary-button" disabled={!authenticated || busy !== null} onClick={() => void requestQuote()} type="button">
            {busy === "quote" ? "Requesting…" : "Get firm SEP-38 quote"}
          </button>
          {quote ? <div className="quote-result"><strong>{quote.buy_amount} USDC</strong><small>Expires {new Date(quote.expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></div> : null}
        </section>

        <section className="flow-step" aria-labelledby="anchor-step-deposit">
          <span className="step-index">03</span>
          <h3 id="anchor-step-deposit">Create deposit</h3>
          <p>Uses the locked quote and current SEP-6 deposit-exchange capability.</p>
          <button className="secondary-button" disabled={!quote || busy !== null || Boolean(deposit)} onClick={() => void createDeposit()} type="button">
            {busy === "deposit" ? "Creating…" : deposit ? "Instructions created" : "Create bank instructions"}
          </button>
        </section>
      </div>

      {deposit && quote ? (
        <div className="deposit-details">
          <div className="deposit-heading">
            <div><p className="eyebrow">Sandbox bank instructions</p><h3>Use the exact reference</h3></div>
            <span className="transaction-status">{transaction?.status ?? "pending"}</span>
          </div>
          <dl className="instruction-grid">
            {Object.entries(deposit.instructions ?? {}).map(([key, instruction]) => (
              <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd>{instruction.value}</dd></div>
            ))}
          </dl>
          {!complete ? (
            <label className="settlement-consent">
              <input
                checked={settlementAuthorized}
                disabled={busy !== null}
                onChange={(event) => setSettlementAuthorized(event.target.checked)}
                type="checkbox"
              />
              <span>
                I authorize the official Mock Anchor to process {quote.sell_amount} TRY in the sandbox and send real Testnet USDC to {wallet?.address.slice(0, 7)}…{wallet?.address.slice(-7)}.
              </span>
            </label>
          ) : null}
          <div className="button-row">
            <button className="primary-button" disabled={busy !== null || complete || !settlementAuthorized} onClick={() => void simulateTransfer()} type="button">
              {busy === "simulate" ? "Anchor processing…" : complete ? "Transfer completed" : "Confirm sandbox settlement"}
            </button>
            <button className="text-button" disabled={busy !== null} onClick={() => void refreshStatus()} type="button">Refresh status</button>
            {deposit.more_info_url ? <a className="text-button" href={deposit.more_info_url} rel="noreferrer" target="_blank">Anchor details ↗</a> : null}
          </div>
          {continuity === "stalled" && !degradedReceipt ? (
            <div className="degraded-rail-callout">
              <div>
                <p className="eyebrow">External rail unavailable</p>
                <h3>Continue without claiming Anchor success</h3>
                <p>
                  This records the official transaction as stalled and isolates the demo fallback to the fiat boundary. It does not create USDC, mutate protocol state, or mark the Anchor transaction completed.
                </p>
              </div>
              <button className="secondary-button" disabled={busy !== null} onClick={() => void recordDegradedFallback()} type="button">
                {busy === "degraded" ? "Recording evidence…" : "Use degraded fiat-rail demo"}
              </button>
            </div>
          ) : null}
          {degradedReceipt ? (
            <div className="degraded-rail-evidence" role="status">
              <strong>DEGRADED DEMO — not Anchor-attested</strong>
              <p>
                Only the local-fiat leg is simulated. No Stellar asset movement or Phloem state mutation was produced by this fallback; continue only with independently funded Testnet USDC.
              </p>
              <dl>
                <div><dt>Official status</dt><dd>{degradedReceipt.anchorObservation.status ?? "unreachable"}</dd></div>
                <div><dt>Receipt</dt><dd>{degradedReceipt.receiptId}</dd></div>
                <div><dt>Evidence digest</dt><dd>{degradedReceipt.evidenceDigest}</dd></div>
              </dl>
            </div>
          ) : null}
          {transaction?.pending_reason ? <p className="helper-text">Pending: {transaction.pending_reason}</p> : null}
          {transaction?.stellar_transaction_id ? <p className="transaction-proof"><span>Testnet transaction</span><strong>{transaction.stellar_transaction_id}</strong></p> : null}
        </div>
      ) : null}

      {!wallet ? <p className="inline-notice">Connect Freighter to unlock the Anchor flow.</p> : !ready ? <p className="inline-notice">A funded Testnet account and the exact Circle USDC trustline are required.</p> : null}
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      <p className="helper-text" aria-live="polite">No Anchor token is exposed to browser JavaScript. It is held in a short-lived encrypted HttpOnly session.</p>
    </section>
  );
}
