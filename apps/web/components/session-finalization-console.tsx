"use client";

import { useState } from "react";

import { PHLOEM_NETWORK } from "../lib/network";
import type {
  AuditQlVerification,
  PreparedSessionFinalization,
  SessionFinalizationAction,
  SessionFinalizationConfirmation,
} from "../lib/session-finalization-types";
import { requestWalletConnection, walletErrorMessage, walletStageError } from "../lib/wallet-connection";

type State = "idle" | "connecting" | "preparing" | "signing" | "proving" | "error";

const labels: Readonly<Record<SessionFinalizationAction, string>> = {
  begin_draining: "1 · Begin DRAINING",
  finalize_audit: "2 · Finalize hidden audit",
  close_session: "4 · Close session",
};

function short(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function SessionFinalizationConsole() {
  const [state, setState] = useState<State>("idle");
  const [address, setAddress] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [confirmations, setConfirmations] = useState<readonly SessionFinalizationConfirmation[]>([]);
  const [audit, setAudit] = useState<AuditQlVerification | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function connectFreighter() {
    setState("connecting");
    setError(null);
    try {
      const [{ StellarWalletsKit, Networks }, { FREIGHTER_ID, FreighterModule }] = await Promise.all([
        import("@creit.tech/stellar-wallets-kit"),
        import("@creit.tech/stellar-wallets-kit/modules/freighter"),
      ]);
      StellarWalletsKit.init({ modules: [new FreighterModule()], network: Networks.TESTNET, selectedWalletId: FREIGHTER_ID });
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

  async function runLifecycleAction(action: SessionFinalizationAction) {
    if (!address) return;
    setState("preparing");
    setError(null);
    let failureStage = `${action} preparation`;
    try {
      const response = await fetch("/api/ops/session-finalization/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ company: address, sessionId, action }),
      });
      const prepared = await response.json() as PreparedSessionFinalization & { error?: string };
      if (!response.ok) throw new Error(prepared.error ?? `Preparation returned HTTP ${response.status}.`);

      setState("signing");
      const [{ StellarWalletsKit }, StellarSdk] = await Promise.all([
        import("@creit.tech/stellar-wallets-kit"),
        import("@stellar/stellar-sdk"),
      ]);
      const unsigned = StellarSdk.TransactionBuilder.fromXDR(prepared.transactionXdr, PHLOEM_NETWORK.networkPassphrase);
      if (!(unsigned instanceof StellarSdk.Transaction) || unsigned.source !== address
        || unsigned.operations.length !== 1
        || BigInt(unsigned.fee) > BigInt(prepared.resource.approvedFeeCeilingStroops)) {
        throw new Error("Prepared finalization transaction failed the client envelope audit.");
      }
      const operation = unsigned.operations[0];
      if (!operation || operation.type !== "invokeHostFunction"
        || operation.func.type !== "hostFunctionTypeInvokeContract"
        || StellarSdk.Address.fromScAddress(operation.func.invokeContract.contractAddress).toString()
          !== PHLOEM_NETWORK.treasuryControllerId
        || operation.func.invokeContract.functionName.toString() !== action
        || (operation.auth ?? []).length !== 1) {
        throw new Error(`Prepared transaction is not the canonical ${action} call.`);
      }

      failureStage = "Freighter signing";
      const { signedTxXdr, signerAddress } = await StellarWalletsKit.signTransaction(prepared.transactionXdr, {
        address,
        networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
      });
      if (signerAddress && signerAddress !== address) throw new Error("Freighter signed with a different account.");
      const signed = StellarSdk.TransactionBuilder.fromXDR(signedTxXdr, PHLOEM_NETWORK.networkPassphrase);
      if (!(signed instanceof StellarSdk.Transaction) || signed.source !== address
        || signed.signatures.length !== 1 || !equalBytes(signed.hash(), unsigned.hash())) {
        throw new Error("Signed transaction differs from the reviewed finalization envelope.");
      }

      failureStage = "RPC submission";
      const server = new StellarSdk.rpc.Server(PHLOEM_NETWORK.rpcUrl);
      const submitted = await server.sendTransaction(signed);
      if (submitted.status === "ERROR") throw new Error(`Testnet rejected ${action}.`);
      if (submitted.status === "TRY_AGAIN_LATER") throw new Error(`Testnet is busy; prepare ${action} again.`);
      failureStage = "Testnet confirmation";
      const final = await server.pollTransaction(submitted.hash, { attempts: 30 });
      if (final.status !== StellarSdk.rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`${action} ended with ${final.status}.`);
      }

      failureStage = "Canonical state verification";
      const confirmedResponse = await fetch("/api/ops/session-finalization/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transactionHash: submitted.hash, sessionId, action }),
      });
      const confirmed = await confirmedResponse.json() as SessionFinalizationConfirmation & { error?: string };
      if (!confirmedResponse.ok) {
        throw new Error(confirmed.error ?? `Confirmation returned HTTP ${confirmedResponse.status}.`);
      }
      setConfirmations((current) => [...current.filter((item) => item.action !== action), confirmed]);
      setState("idle");
    } catch (reason) {
      setState("error");
      setError(walletStageError(failureStage, reason, `${action} failed.`));
    }
  }

  async function proveAuditQl() {
    setState("proving");
    setError(null);
    try {
      const response = await fetch("/api/ops/session-finalization/audit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, thresholdAtomic: "10000000" }),
      });
      const result = await response.json() as AuditQlVerification & { error?: string };
      if (!response.ok) throw new Error(result.error ?? `AuditQL returned HTTP ${response.status}.`);
      setAudit(result);
      setState("idle");
    } catch (reason) {
      setState("error");
      setError(reason instanceof Error ? reason.message : "AuditQL proof verification failed.");
    }
  }

  const busy = state !== "idle" && state !== "error";
  const has = (action: SessionFinalizationAction) => confirmations.some((item) => item.action === action);

  return (
    <div className="deploy-console">
      <section className="deploy-overview" aria-labelledby="session-finalization-title">
        <div>
          <p className="eyebrow">Canonical lifecycle · selective audit</p>
          <h1 id="session-finalization-title">Finalize the PRIVATE session</h1>
          <p>Freeze new commerce, commit the immutable hidden audit snapshot, prove TOTAL_SPEND_LEQ and close.</p>
        </div>
        <dl>
          <div><dt>Controller</dt><dd>{short(PHLOEM_NETWORK.treasuryControllerId)}</dd></div>
          <div><dt>Audit verifier</dt><dd>{short(PHLOEM_NETWORK.auditTotalSpendLeqVerifierId)}</dd></div>
          <div><dt>Predicate</dt><dd>TOTAL_SPEND_LEQ</dd></div>
          <div><dt>Lifecycle asset movement</dt><dd className="ready-text">None</dd></div>
        </dl>
      </section>

      <section className="panel deploy-panel" aria-labelledby="session-finalization-actions-title">
        <div className="panel-heading">
          <div><p className="eyebrow">Freighter + local prover</p><h2 id="session-finalization-actions-title">Run the four final gates</h2></div>
          <span className={`status-chip ${has("close_session") ? "is-ready" : "is-pending"}`}>
            <span aria-hidden="true" className="status-dot" />{has("close_session") ? "closed" : "pending"}
          </span>
        </div>

        {!address ? (
          <div className="deploy-action">
            <p>Connect the controlled company wallet. Connecting does not sign or submit anything.</p>
            <button className="primary-button" disabled={state === "connecting"} onClick={connectFreighter} type="button">
              {state === "connecting" ? "Connecting…" : "Connect Freighter"}
            </button>
          </div>
        ) : (
          <div className="deploy-action">
            <label className="field-label" htmlFor="finalization-session-id">PRIVATE session ID</label>
            <input
              className="text-input"
              id="finalization-session-id"
              onChange={(event) => setSessionId(event.target.value.trim().toLowerCase())}
              placeholder="64-character lowercase hex"
              spellCheck={false}
              value={sessionId}
            />
            <div className="transaction-review">
              <p>Each lifecycle write is separately simulated, envelope-audited and company-authorized. AuditQL keeps amount/provider openings server-side.</p>
              <button className="primary-button" disabled={busy || sessionId.length !== 64 || has("begin_draining")} onClick={() => runLifecycleAction("begin_draining")} type="button">
                {has("begin_draining") ? "DRAINING confirmed" : labels.begin_draining}
              </button>
              <button className="primary-button" disabled={busy || !has("begin_draining") || has("finalize_audit")} onClick={() => runLifecycleAction("finalize_audit")} type="button">
                {has("finalize_audit") ? "Audit snapshot finalized" : labels.finalize_audit}
              </button>
              <button className="primary-button" disabled={busy || !has("finalize_audit") || Boolean(audit)} onClick={proveAuditQl} type="button">
                {audit ? "TOTAL_SPEND_LEQ verified" : state === "proving" ? "Generating Groth16 proof…" : "3 · Prove and verify AuditQL"}
              </button>
              <button className="primary-button" disabled={busy || !audit || has("close_session")} onClick={() => runLifecycleAction("close_session")} type="button">
                {has("close_session") ? "Session CLOSED" : labels.close_session}
              </button>
            </div>
          </div>
        )}

        {audit ? (
          <div className="deploy-complete" role="status">
            <strong>Hidden total satisfies TOTAL_SPEND_LEQ 1.0000000 USDC.</strong>
            <span>Audit version {audit.auditVersion} · {audit.execution}</span>
            {!audit.testnetVerifierAccepted ? (
              <span>Deployed Testnet verifier rejected the proof; the local Groth16 verification remains bound to the canonical live Testnet statement.</span>
            ) : null}
            <code>{audit.proofSha256}</code>
          </div>
        ) : null}
        {error ? <p className="inline-error" role="alert">{error}</p> : null}
        <p className="helper-text">Groth16 witness and encrypted audit opening remain local. Any Testnet verifier rejection is reported explicitly and never relabeled as an on-chain verification.</p>
      </section>
    </div>
  );
}
