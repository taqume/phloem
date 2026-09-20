"use client";

import { useEffect, useState } from "react";

import type {
  AccountReadiness,
  AnchorQuote,
  AnchorTransaction,
  AnchorWithdrawal,
  DegradedProviderOfframpReceipt,
  ProviderOfframpCapability,
} from "../lib/anchor-types";
import { PHLOEM_NETWORK } from "../lib/network";
import { requestWalletConnection, walletErrorMessage } from "../lib/wallet-connection";

type Busy = "auth" | "connect" | "degraded" | "payment" | "quote" | "status" | "withdrawal" | null;

interface ProviderExitEvidence {
  amount: string;
  amountAtomic: string;
  providerAccount: string;
  transactionHash: string;
}

interface PaymentPreview {
  amount: string;
  assetCode: string;
  assetIssuer: string;
  destination: string;
  feeStroops: string;
  memo: { type: string; value: string | null };
  networkPassphrase: string;
  source: string;
  transactionHash: string;
  transactionXdr: string;
}

async function responseJson<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request returned HTTP ${response.status}.`);
  return payload;
}

function short(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function ProviderOfframpConsole() {
  const [account, setAccount] = useState<AccountReadiness | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [capability, setCapability] = useState<ProviderOfframpCapability | null>(null);
  const [consent, setConsent] = useState(false);
  const [degraded, setDegraded] = useState<DegradedProviderOfframpReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exit, setExit] = useState<ProviderExitEvidence | null>(null);
  const [payment, setPayment] = useState<PaymentPreview | null>(null);
  const [quote, setQuote] = useState<AnchorQuote | null>(null);
  const [submittedHash, setSubmittedHash] = useState<string | null>(null);
  const [transaction, setTransaction] = useState<AnchorTransaction | null>(null);
  const [withdrawal, setWithdrawal] = useState<AnchorWithdrawal | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.allSettled([
      fetch("/api/anchor/offramp/evidence", { cache: "no-store" })
        .then((response) => responseJson<{ providerExit: ProviderExitEvidence }>(response)),
      fetch("/api/anchor/offramp/capability", { cache: "no-store" })
        .then((response) => responseJson<{ capability: ProviderOfframpCapability }>(response)),
    ]).then(([evidenceResult, capabilityResult]) => {
      if (!active) return;
      if (evidenceResult.status === "fulfilled") setExit(evidenceResult.value.providerExit);
      else setError(evidenceResult.reason instanceof Error ? evidenceResult.reason.message : "Provider exit evidence is unavailable.");
      if (capabilityResult.status === "fulfilled") setCapability(capabilityResult.value.capability);
    });
    return () => { active = false; };
  }, []);

  async function connect() {
    setBusy("connect");
    setError(null);
    try {
      const [{ StellarWalletsKit, Networks }, { FREIGHTER_ID, FreighterModule }] = await Promise.all([
        import("@creit.tech/stellar-wallets-kit"),
        import("@creit.tech/stellar-wallets-kit/modules/freighter"),
      ]);
      StellarWalletsKit.init({ modules: [new FreighterModule()], network: Networks.TESTNET, selectedWalletId: FREIGHTER_ID });
      const wallet = await requestWalletConnection({
        fetchAddress: () => StellarWalletsKit.fetchAddress(),
        getNetwork: () => StellarWalletsKit.getNetwork(),
      });
      if (wallet.network.networkPassphrase !== PHLOEM_NETWORK.networkPassphrase) {
        throw new Error("Freighter must be switched to Stellar Testnet.");
      }
      if (!exit || wallet.address !== exit.providerAccount) {
        throw new Error(`Freighter must select the controlled provider account ${exit?.providerAccount ?? "shown above"}.`);
      }
      const readiness = await responseJson<AccountReadiness>(await fetch(
        `/api/stellar/account?address=${encodeURIComponent(wallet.address)}`,
        { cache: "no-store" },
      ));
      if (!readiness.exists || !readiness.usdcTrustline || Number(readiness.xlmBalance ?? "0") <= 0) {
        throw new Error("Provider account needs Testnet XLM and the exact Circle USDC trustline.");
      }
      setAccount(readiness);
    } catch (reason) {
      setAccount(null);
      setError(walletErrorMessage(reason, "Freighter connection failed."));
    } finally {
      setBusy(null);
    }
  }

  async function authenticate() {
    if (!account) return;
    setBusy("auth");
    setError(null);
    try {
      const challenge = await responseJson<{ transaction: string }>(await fetch(
        `/api/anchor/challenge?account=${encodeURIComponent(account.address)}`,
        { cache: "no-store" },
      ));
      const { StellarWalletsKit } = await import("@creit.tech/stellar-wallets-kit");
      const signed = await StellarWalletsKit.signTransaction(challenge.transaction, {
        address: account.address,
        networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
      });
      await responseJson(await fetch("/api/anchor/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: account.address, transaction: signed.signedTxXdr }),
      }));
      setAuthenticated(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Provider SEP-10 authentication failed.");
    } finally {
      setBusy(null);
    }
  }

  async function requestQuote() {
    if (!account || !exit) return;
    setBusy("quote");
    setError(null);
    try {
      const payload = await responseJson<{ quote: AnchorQuote }>(await fetch("/api/anchor/offramp/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: account.address, amount: exit.amount }),
      }));
      setQuote(payload.quote);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "USDC to TRY quote failed.");
    } finally {
      setBusy(null);
    }
  }

  async function createWithdrawal() {
    if (!account || !quote) return;
    setBusy("withdrawal");
    setError(null);
    try {
      const payload = await responseJson<{ withdrawal: AnchorWithdrawal }>(await fetch("/api/anchor/offramp/withdrawal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: account.address, amount: quote.sell_amount, quoteId: quote.id }),
      }));
      setWithdrawal(payload.withdrawal);
      await refreshStatus(payload.withdrawal.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "SEP-6 withdrawal creation failed.");
    } finally {
      setBusy(null);
    }
  }

  async function refreshStatus(id = withdrawal?.id): Promise<AnchorTransaction | null> {
    if (!id) return null;
    setBusy((current) => current ?? "status");
    try {
      const payload = await responseJson<{ transaction: AnchorTransaction }>(await fetch(
        `/api/anchor/status?id=${encodeURIComponent(id)}`,
        { cache: "no-store" },
      ));
      setTransaction(payload.transaction);
      return payload.transaction;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Withdrawal status check failed.");
      return null;
    } finally {
      setBusy((current) => current === "status" ? null : current);
    }
  }

  async function preparePayment() {
    if (!account || !quote || !withdrawal) return;
    setBusy("payment");
    setError(null);
    try {
      const payload = await responseJson<{ payment: PaymentPreview }>(await fetch("/api/anchor/offramp/payment/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: account.address, quoteId: quote.id, transactionId: withdrawal.id }),
      }));
      setPayment(payload.payment);
      setConsent(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Withdrawal payment preparation failed.");
    } finally {
      setBusy(null);
    }
  }

  async function signAndSubmitPayment() {
    if (!account || !quote || !withdrawal || !payment || !consent) return;
    setBusy("payment");
    setError(null);
    try {
      const [{ StellarWalletsKit }, StellarSdk] = await Promise.all([
        import("@creit.tech/stellar-wallets-kit"),
        import("@stellar/stellar-sdk"),
      ]);
      const unsigned = StellarSdk.TransactionBuilder.fromXDR(payment.transactionXdr, PHLOEM_NETWORK.networkPassphrase);
      const operation = unsigned.operations[0];
      if (!(unsigned instanceof StellarSdk.Transaction)
        || unsigned.source !== account.address
        || unsigned.operations.length !== 1
        || BigInt(unsigned.fee) !== BigInt(payment.feeStroops)
        || !operation
        || operation.type !== "payment"
        || operation.destination !== payment.destination
        || operation.amount !== payment.amount
        || operation.asset.code !== PHLOEM_NETWORK.assetCode
        || operation.asset.issuer !== PHLOEM_NETWORK.assetIssuer) {
        throw new Error("Prepared payment failed its client-side source, asset, amount, destination, or fee audit.");
      }
      const signedResult = await StellarWalletsKit.signTransaction(payment.transactionXdr, {
        address: account.address,
        networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
      });
      const signed = StellarSdk.TransactionBuilder.fromXDR(signedResult.signedTxXdr, PHLOEM_NETWORK.networkPassphrase);
      if (!(signed instanceof StellarSdk.Transaction)
        || signed.source !== account.address
        || signed.signatures.length !== 1
        || !equalBytes(signed.hash(), unsigned.hash())) {
        throw new Error("Freighter returned a different or incomplete withdrawal payment.");
      }
      const submitted = await responseJson<{ submitted: { transactionHash: string } }>(await fetch(
        "/api/anchor/offramp/payment/submit",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            account: account.address,
            quoteId: quote.id,
            signedTransactionXdr: signedResult.signedTxXdr,
            transactionId: withdrawal.id,
          }),
        },
      ));
      setSubmittedHash(submitted.submitted.transactionHash);
      setConsent(false);
      let latest: AnchorTransaction | null = null;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        latest = await refreshStatus(withdrawal.id);
        if (!latest || ["completed", "error", "expired", "refunded"].includes(latest.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
      if (latest?.status !== "completed") {
        setError("The USDC payment is real and confirmed, but the official Anchor has not completed the TRY rail. Keep polling or record degraded fiat-only evidence.");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Provider withdrawal payment failed.");
    } finally {
      setBusy(null);
    }
  }

  async function recordDegraded() {
    if (!exit) return;
    setBusy("degraded");
    setError(null);
    try {
      const payload = await responseJson<{ receipt: DegradedProviderOfframpReceipt }>(await fetch(
        "/api/anchor/offramp/degraded",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            account: exit.providerAccount,
            amountAtomic: exit.amountAtomic,
            sppExitTransactionHash: exit.transactionHash,
            ...(withdrawal ? { transactionId: withdrawal.id } : {}),
          }),
        },
      ));
      setDegraded(payload.receipt);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Degraded fiat-rail evidence failed.");
    } finally {
      setBusy(null);
    }
  }

  const completed = transaction?.status === "completed";
  const anchorUnavailable = exit !== null && capability === null;

  return (
    <div className="deploy-console">
      <section className="deploy-overview" aria-labelledby="provider-offramp-title">
        <div>
          <p className="eyebrow">Provider-controlled exit · real-first</p>
          <h1 id="provider-offramp-title">USDC → Anchor → TRY</h1>
          <p>The controlled provider exits its real SPP payment to public Testnet USDC, then uses the Anchor’s advertised SEP-38 and SEP-6 path. Only the external fiat result may degrade.</p>
        </div>
        <dl>
          <div><dt>Provider</dt><dd>{exit ? short(exit.providerAccount) : "loading"}</dd></div>
          <div><dt>Real SPP exit</dt><dd>{exit?.amount ?? "—"} USDC</dd></div>
          <div><dt>Official rail</dt><dd>{capability ? "advertised" : "unavailable"}</dd></div>
          <div><dt>Fallback scope</dt><dd>TRY boundary only</dd></div>
        </dl>
      </section>

      <section className="panel deploy-panel" aria-labelledby="provider-offramp-action-title">
        <div className="panel-heading">
          <div><p className="eyebrow">Five independently checked stages</p><h2 id="provider-offramp-action-title">Complete the provider off-ramp</h2></div>
          <span className={`status-chip ${completed ? "is-ready" : degraded ? "is-degraded" : "is-pending"}`}>
            <span aria-hidden="true" className="status-dot" />
            {completed ? "Anchor complete" : degraded ? "Degraded fiat rail" : "Pending"}
          </span>
        </div>

        <div className="funding-flow offramp-flow">
          <section className="flow-step">
            <span className="step-index">01</span><h3>Provider wallet</h3>
            <p>Select the exact account that received the real public SPP exit.</p>
            <button className="secondary-button" disabled={!exit || busy !== null || Boolean(account)} onClick={() => void connect()} type="button">
              {busy === "connect" ? "Connecting…" : account ? "Provider connected" : "Connect provider Freighter"}
            </button>
          </section>
          <section className="flow-step">
            <span className="step-index">02</span><h3>Anchor auth</h3>
            <p>Signs only the validated SEP-10 challenge; this step cannot move assets.</p>
            <button className="secondary-button" disabled={!account || busy !== null || authenticated || !capability} onClick={() => void authenticate()} type="button">
              {busy === "auth" ? "Awaiting Freighter…" : authenticated ? "Authenticated" : "Sign SEP-10 challenge"}
            </button>
          </section>
          <section className="flow-step">
            <span className="step-index">03</span><h3>Firm quote</h3>
            <p>Locks the provider’s exact {exit?.amount ?? "—"} USDC into a TRY/bank_account quote.</p>
            <button className="secondary-button" disabled={!authenticated || busy !== null || Boolean(quote)} onClick={() => void requestQuote()} type="button">
              {busy === "quote" ? "Quoting…" : quote ? `${quote.buy_amount} TRY quoted` : "Get SEP-38 quote"}
            </button>
          </section>
          <section className="flow-step">
            <span className="step-index">04</span><h3>Withdrawal</h3>
            <p>Creates only the advertised SEP-6 withdrawal-exchange request.</p>
            <button className="secondary-button" disabled={!quote || busy !== null || Boolean(withdrawal)} onClick={() => void createWithdrawal()} type="button">
              {busy === "withdrawal" ? "Creating…" : withdrawal ? "Request created" : "Create withdrawal"}
            </button>
          </section>
          <section className="flow-step">
            <span className="step-index">05</span><h3>USDC payment</h3>
            <p>Builds one exact provider → Anchor payment from current SEP state.</p>
            <button className="secondary-button" disabled={!withdrawal || busy !== null || Boolean(payment)} onClick={() => void preparePayment()} type="button">
              {busy === "payment" ? "Preparing…" : payment ? "Payment inspected" : "Inspect payment"}
            </button>
          </section>
        </div>

        {payment && !submittedHash ? (
          <div className="transaction-review">
            <p><strong>Asset-moving boundary.</strong> Freighter will send exactly {payment.amount} USDC from the provider to {short(payment.destination)} with the Anchor memo.</p>
            <dl>
              <div><dt>Source</dt><dd>{short(payment.source)}</dd></div>
              <div><dt>Destination</dt><dd>{short(payment.destination)}</dd></div>
              <div><dt>Amount</dt><dd>{payment.amount} USDC</dd></div>
              <div><dt>Memo</dt><dd>{payment.memo.type}:{payment.memo.value ?? "none"}</dd></div>
              <div><dt>Fee</dt><dd>{payment.feeStroops} stroops</dd></div>
            </dl>
            <label className="settlement-consent">
              <input checked={consent} disabled={busy !== null} onChange={(event) => setConsent(event.target.checked)} type="checkbox" />
              <span>I reviewed and authorize this exact Testnet USDC payment. No other operation is permitted.</span>
            </label>
            <button className="primary-button" disabled={!consent || busy !== null} onClick={() => void signAndSubmitPayment()} type="button">
              {busy === "payment" ? "Awaiting Freighter…" : "Sign and submit provider payment"}
            </button>
          </div>
        ) : null}

        {submittedHash ? <div className="deploy-complete"><strong>Real provider USDC payment submitted.</strong><code>{submittedHash}</code><span>Official Anchor status: {transaction?.status ?? "pending"}</span></div> : null}

        {anchorUnavailable || (submittedHash && !completed) ? (
          <div className="degraded-rail-callout">
            <div><p className="eyebrow">External rail exception</p><h3>Isolate the fallback to local fiat</h3><p>This never fabricates a SEP status, moves Stellar assets, or mutates Phloem. It preserves the real SPP exit evidence and labels only the TRY result as simulated.</p></div>
            <button className="secondary-button" disabled={!account || busy !== null || Boolean(degraded)} onClick={() => void recordDegraded()} type="button">
              {busy === "degraded" ? "Recording…" : degraded ? "Evidence recorded" : "Record fiat-only fallback"}
            </button>
          </div>
        ) : null}

        {degraded ? <div className="degraded-rail-evidence" role="status"><strong>DEGRADED DEMO — not Anchor-attested</strong><p>Real provider settlement remains linked below. This receipt creates no Stellar transaction and makes no protocol state change.</p><dl><div><dt>SPP exit</dt><dd>{degraded.providerSettlement.sppExitTransactionHash}</dd></div><div><dt>Anchor status</dt><dd>{degraded.anchorObservation.status ?? "unreachable"}</dd></div><div><dt>Receipt</dt><dd>{degraded.receiptId}</dd></div><div><dt>Digest</dt><dd>{degraded.evidenceDigest}</dd></div></dl></div> : null}

        {withdrawal ? <div className="button-row"><button className="text-button" disabled={busy !== null} onClick={() => void refreshStatus()} type="button">Refresh official status</button></div> : null}
        {exit ? <p className="transaction-proof"><span>Confirmed provider SPP exit</span><strong>{exit.transactionHash}</strong></p> : null}
        {error ? <p className="inline-error" role="alert">{error}</p> : null}
        <p className="helper-text" aria-live="polite">The Anchor token remains in an encrypted HttpOnly session. Provider keys never enter the server or repository.</p>
      </section>
    </div>
  );
}
