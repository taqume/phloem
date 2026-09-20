"use client";

import { useState } from "react";

import { PHLOEM_NETWORK } from "../lib/network";
import type {
  PreparedPrivateSessionCreation,
  PrivateSessionConfirmation,
} from "../lib/private-session-types";
import { requestWalletConnection, walletErrorMessage, walletStageError } from "../lib/wallet-connection";

type State = "idle" | "connecting" | "preparing" | "ready" | "signing" | "complete" | "error";

function short(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function stroopsToXlm(stroops: string): string {
  const value = BigInt(stroops);
  const whole = value / 10_000_000n;
  const fractional = (value % 10_000_000n).toString().padStart(7, "0").replace(/0+$/u, "");
  return fractional ? `${whole}.${fractional}` : whole.toString();
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function PrivateSessionConsole() {
  const [state, setState] = useState<State>("idle");
  const [address, setAddress] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedPrivateSessionCreation | null>(null);
  const [confirmation, setConfirmation] = useState<PrivateSessionConfirmation | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function connectFreighter() {
    setState("connecting");
    setError(null);
    try {
      const [{ StellarWalletsKit, Networks }, { FREIGHTER_ID, FreighterModule }] = await Promise.all([
        import("@creit.tech/stellar-wallets-kit"),
        import("@creit.tech/stellar-wallets-kit/modules/freighter"),
      ]);
      StellarWalletsKit.init({
        modules: [new FreighterModule()],
        network: Networks.TESTNET,
        selectedWalletId: FREIGHTER_ID,
      });
      const connection = await requestWalletConnection({
        fetchAddress: () => StellarWalletsKit.fetchAddress(),
        getNetwork: () => StellarWalletsKit.getNetwork(),
      });
      if (connection.network.networkPassphrase !== PHLOEM_NETWORK.networkPassphrase) {
        throw new Error("Freighter must be switched to Stellar Testnet.");
      }
      if (connection.address !== PHLOEM_NETWORK.companyFundingPublicKey) {
        throw new Error(`Freighter must use the controlled company wallet ${short(PHLOEM_NETWORK.companyFundingPublicKey)}.`);
      }
      setAddress(connection.address);
      setState("idle");
    } catch (reason) {
      setState("error");
      setError(walletErrorMessage(reason, "Freighter connection failed."));
    }
  }

  async function prepare() {
    if (!address) return;
    setState("preparing");
    setError(null);
    try {
      const response = await fetch("/api/ops/private-session/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ company: address }),
      });
      const payload = await response.json() as PreparedPrivateSessionCreation & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Preparation returned HTTP ${response.status}.`);
      setPrepared(payload);
      setState("ready");
    } catch (reason) {
      setState("error");
      setError(reason instanceof Error ? reason.message : "PRIVATE session preparation failed.");
    }
  }

  async function signAndSubmit() {
    if (!address || !prepared) return;
    setState("signing");
    setError(null);
    let failureStage = "Client transaction audit";
    try {
      const [{ StellarWalletsKit }, StellarSdk] = await Promise.all([
        import("@creit.tech/stellar-wallets-kit"),
        import("@stellar/stellar-sdk"),
      ]);
      const unsigned = StellarSdk.TransactionBuilder.fromXDR(prepared.transactionXdr, PHLOEM_NETWORK.networkPassphrase);
      if (!(unsigned instanceof StellarSdk.Transaction)
        || unsigned.source !== address
        || unsigned.operations.length !== 1
        || BigInt(unsigned.fee) > BigInt(prepared.resource.approvedFeeCeilingStroops)) {
        throw new Error("Prepared transaction failed its source, operation-count, or fee audit.");
      }
      const operation = unsigned.operations[0];
      if (!operation
        || operation.type !== "invokeHostFunction"
        || operation.func.type !== "hostFunctionTypeInvokeContract"
        || StellarSdk.Address.fromScAddress(operation.func.invokeContract.contractAddress).toString()
          !== PHLOEM_NETWORK.treasuryControllerId
        || operation.func.invokeContract.functionName.toString() !== "create_session"
        || (operation.auth ?? []).length !== 1) {
        throw new Error("Prepared transaction is not the canonical create_session call.");
      }

      failureStage = "Freighter signing";
      const { signedTxXdr, signerAddress } = await StellarWalletsKit.signTransaction(prepared.transactionXdr, {
        address,
        networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
      });
      if (signerAddress && signerAddress !== address) throw new Error("Freighter signed with a different account.");
      const signed = StellarSdk.TransactionBuilder.fromXDR(signedTxXdr, PHLOEM_NETWORK.networkPassphrase);
      if (!(signed instanceof StellarSdk.Transaction)
        || signed.source !== address
        || signed.signatures.length !== 1
        || !equalBytes(signed.hash(), unsigned.hash())) {
        throw new Error("Signed transaction does not contain the expected company envelope signature.");
      }

      const server = new StellarSdk.rpc.Server(PHLOEM_NETWORK.rpcUrl);
      failureStage = "RPC submission";
      const submitted = await server.sendTransaction(signed);
      if (submitted.status === "ERROR") throw new Error("Testnet rejected create_session.");
      if (submitted.status === "TRY_AGAIN_LATER") throw new Error("Testnet is busy; prepare create_session again.");
      failureStage = "Testnet confirmation";
      const final = await server.pollTransaction(submitted.hash, { attempts: 30 });
      if (final.status !== StellarSdk.rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`create_session ended with ${final.status}.`);
      }

      failureStage = "Canonical state verification";
      const response = await fetch("/api/ops/private-session/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          transactionHash: submitted.hash,
          sessionId: prepared.sessionId,
          policyHash: prepared.policyHash,
          approvedProviderRoot: prepared.approvedProviderRoot,
          sessionExpiry: prepared.sessionExpiry,
        }),
      });
      const confirmed = await response.json() as PrivateSessionConfirmation & { error?: string };
      if (!response.ok) throw new Error(confirmed.error ?? `Confirmation returned HTTP ${response.status}.`);
      setConfirmation(confirmed);
      setState("complete");
    } catch (reason) {
      setState("error");
      setError(walletStageError(failureStage, reason, "PRIVATE session submission failed."));
    }
  }

  return (
    <div className="deploy-console">
      <section className="deploy-overview" aria-labelledby="private-session-title">
        <div>
          <p className="eyebrow">Company authorization · no asset movement</p>
          <h1 id="private-session-title">Create the PRIVATE session</h1>
          <p>Commit the controlled provider root and immutable bounded policy before preparing the separate USDC activation.</p>
        </div>
        <dl>
          <div><dt>Controller</dt><dd>{short(PHLOEM_NETWORK.treasuryControllerId)}</dd></div>
          <div><dt>Company</dt><dd>{short(PHLOEM_NETWORK.companyFundingPublicKey)}</dd></div>
          <div><dt>Settlement</dt><dd>PRIVATE</dd></div>
          <div><dt>Asset movement</dt><dd className="ready-text">None</dd></div>
        </dl>
      </section>

      <section className="panel deploy-panel" aria-labelledby="private-session-action-title">
        <div className="panel-heading">
          <div><p className="eyebrow">Freighter boundary</p><h2 id="private-session-action-title">Inspect one company-authorized call</h2></div>
          <span className={`status-chip ${state === "complete" ? "is-ready" : "is-pending"}`}><span aria-hidden="true" className="status-dot" />{state === "complete" ? "confirmed" : "pending"}</span>
        </div>

        {!address ? (
          <div className="deploy-action">
            <p>Connect the controlled Testnet company wallet. Connecting does not request a signature.</p>
            <button className="primary-button" disabled={state === "connecting"} onClick={connectFreighter} type="button">
              {state === "connecting" ? "Connecting…" : "Connect Freighter"}
            </button>
          </div>
        ) : confirmation ? (
          <div className="deploy-complete" role="status">
            <strong>PRIVATE session created in DRAFT.</strong>
            <span>Session {short(confirmation.sessionId)} · ledger {confirmation.ledger}</span>
            <code>{confirmation.transactionHash}</code>
          </div>
        ) : prepared ? (
          <div className="deploy-action">
            <div className="address-block"><span>CompanyFundingAccount · Testnet</span><strong>{short(address)}</strong></div>
            <div className="transaction-review" aria-label="Prepared PRIVATE session review">
              <p>One `create_session` call; source-account authorization only. USDC allowance, transfer and SPP deposit are absent.</p>
              <dl>
                <div><dt>Function</dt><dd>{prepared.safety.functionName}</dd></div>
                <div><dt>Operations</dt><dd>{prepared.safety.operationCount}</dd></div>
                <div><dt>Maximum fee</dt><dd>{stroopsToXlm(prepared.resource.maximumFeeStroops)} XLM</dd></div>
                <div><dt>Session expiry</dt><dd>ledger {prepared.sessionExpiry}</dd></div>
                <div><dt>Provider</dt><dd>{short(prepared.provider.identity)}</dd></div>
                <div><dt>Asset movement</dt><dd className="ready-text">None</dd></div>
              </dl>
              <code>{prepared.policyHash}</code>
              <button className="primary-button" disabled={state === "signing"} onClick={signAndSubmit} type="button">
                {state === "signing" ? "Waiting for Freighter…" : "Sign and create PRIVATE session"}
              </button>
            </div>
          </div>
        ) : (
          <div className="deploy-action">
            <div className="address-block"><span>Connected company · Testnet</span><strong>{short(address)}</strong></div>
            <button className="primary-button" disabled={state === "preparing"} onClick={prepare} type="button">
              {state === "preparing" ? "Simulating on Testnet…" : "Prepare and inspect session"}
            </button>
          </div>
        )}

        {error ? <p className="inline-error" role="alert">{error}</p> : null}
        <p className="helper-text">PRIVATE activation and its USDC movement are intentionally excluded from this transaction and will require a separate review.</p>
      </section>
    </div>
  );
}
