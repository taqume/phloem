"use client";

import { useState } from "react";

import type { PrivateAgentRole } from "@phloem/privacy-runtime/agent-identities";

import { PHLOEM_NETWORK } from "../lib/network";
import type {
  PreparedPrivateAgentDeployment,
  PrivateAgentDeploymentConfirmation,
} from "../lib/private-agent-types";
import { requestWalletConnection, walletErrorMessage, walletStageError } from "../lib/wallet-connection";

const ROLES = ["SUPERVISOR", "RESEARCH", "BUILDER"] as const;
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

export function PrivateAgentConsole() {
  const [state, setState] = useState<State>("idle");
  const [address, setAddress] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [roleIndex, setRoleIndex] = useState(0);
  const [prepared, setPrepared] = useState<PreparedPrivateAgentDeployment | null>(null);
  const [confirmations, setConfirmations] = useState<PrivateAgentDeploymentConfirmation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const currentRole: PrivateAgentRole | undefined = ROLES[roleIndex];

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
        throw new Error(`Freighter must use ${short(PHLOEM_NETWORK.companyFundingPublicKey)}.`);
      }
      setAddress(connection.address);
      setState("idle");
    } catch (reason) {
      setState("error");
      setError(walletErrorMessage(reason, "Freighter connection failed."));
    }
  }

  async function prepare() {
    if (!address || !currentRole || !/^[0-9a-f]{64}$/u.test(sessionId)) {
      setError("Enter the 32-byte lowercase PRIVATE session id.");
      return;
    }
    setState("preparing");
    setError(null);
    try {
      const response = await fetch("/api/ops/private-agents/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ company: address, sessionId, role: currentRole }),
      });
      const payload = await response.json() as PreparedPrivateAgentDeployment & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Preparation returned HTTP ${response.status}.`);
      setPrepared(payload);
      setState("ready");
    } catch (reason) {
      setState("error");
      setError(reason instanceof Error ? reason.message : "AgentAccount preparation failed.");
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
        || operation.func.type !== "hostFunctionTypeCreateContractV2"
        || (operation.auth ?? []).length !== 1) {
        throw new Error("Prepared transaction is not one source-authorized createContractV2 operation.");
      }
      const auth = StellarSdk.inspectAuthEntry(operation.auth![0]!);
      if (auth.credentialType !== "sourceAccount" || auth.invocation.subInvocations.length !== 0) {
        throw new Error("Prepared AgentAccount deployment contains unexpected authorization.");
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
        throw new Error("Signed AgentAccount transaction differs from the audited preflight.");
      }

      const server = new StellarSdk.rpc.Server(PHLOEM_NETWORK.rpcUrl);
      failureStage = "RPC submission";
      const submitted = await server.sendTransaction(signed);
      if (submitted.status === "ERROR") throw new Error("Testnet rejected AgentAccount creation.");
      if (submitted.status === "TRY_AGAIN_LATER") throw new Error("Testnet is busy; prepare this AgentAccount again.");
      failureStage = "Testnet confirmation";
      const final = await server.pollTransaction(submitted.hash, { attempts: 30 });
      if (final.status !== StellarSdk.rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`AgentAccount creation ended with ${final.status}.`);
      }

      failureStage = "Canonical AgentAccount verification";
      const response = await fetch("/api/ops/private-agents/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          transactionHash: submitted.hash,
          sessionId: prepared.sessionId,
          role: prepared.role,
          contractId: prepared.contractId,
        }),
      });
      const confirmed = await response.json() as PrivateAgentDeploymentConfirmation & { error?: string };
      if (!response.ok) throw new Error(confirmed.error ?? `Confirmation returned HTTP ${response.status}.`);
      const next = roleIndex + 1;
      setConfirmations((current) => [...current, confirmed]);
      setPrepared(null);
      setRoleIndex(next);
      setState(next === ROLES.length ? "complete" : "idle");
    } catch (reason) {
      setState("error");
      setError(walletStageError(failureStage, reason, "AgentAccount submission failed."));
    }
  }

  return (
    <div className="deploy-console">
      <section className="deploy-overview" aria-labelledby="private-agent-title">
        <div>
          <p className="eyebrow">Session-bound identities · no asset movement</p>
          <h1 id="private-agent-title">Deploy three scoped AgentAccounts</h1>
          <p>Each account can authorize only the canonical TreasuryController and expires with the PRIVATE session.</p>
        </div>
        <dl>
          <div><dt>WASM</dt><dd>{short(PHLOEM_NETWORK.agentAccountWasmHash)}</dd></div>
          <div><dt>Controller</dt><dd>{short(PHLOEM_NETWORK.treasuryControllerId)}</dd></div>
          <div><dt>Progress</dt><dd>{confirmations.length} / {ROLES.length}</dd></div>
          <div><dt>Asset movement</dt><dd className="ready-text">None</dd></div>
        </dl>
      </section>

      <section className="panel deploy-panel" aria-labelledby="private-agent-action-title">
        <div className="panel-heading">
          <div><p className="eyebrow">Freighter boundary</p><h2 id="private-agent-action-title">{currentRole ?? "Agent identities confirmed"}</h2></div>
          <span className={`status-chip ${state === "complete" ? "is-ready" : "is-pending"}`}><span aria-hidden="true" className="status-dot" />{state === "complete" ? "confirmed" : "pending"}</span>
        </div>

        {!address ? (
          <div className="deploy-action">
            <p>Connect the controlled Testnet company wallet. This step does not request a signature.</p>
            <button className="primary-button" disabled={state === "connecting"} onClick={connectFreighter} type="button">
              {state === "connecting" ? "Connecting…" : "Connect Freighter"}
            </button>
          </div>
        ) : state === "complete" ? (
          <div className="deploy-complete" role="status">
            <strong>All session-bound AgentAccounts are confirmed.</strong>
            {confirmations.map((item) => <code key={item.role}>{item.role}: {item.contractId}</code>)}
          </div>
        ) : prepared ? (
          <div className="deploy-action">
            <div className="address-block"><span>{prepared.role} · Testnet</span><strong>{short(prepared.contractId)}</strong></div>
            <div className="transaction-review" aria-label="Prepared AgentAccount review">
              <p>One `createContractV2` host function. No contract invocation, allowance, XLM transfer, or USDC movement.</p>
              <dl>
                <div><dt>Role</dt><dd>{prepared.role}</dd></div>
                <div><dt>Maximum fee</dt><dd>{stroopsToXlm(prepared.resource.maximumFeeStroops)} XLM</dd></div>
                <div><dt>Valid until</dt><dd>ledger {prepared.validUntilLedger}</dd></div>
                <div><dt>Asset movement</dt><dd className="ready-text">None</dd></div>
              </dl>
              <code>{prepared.publicKeyHex}</code>
              <button className="primary-button" disabled={state === "signing"} onClick={signAndSubmit} type="button">
                {state === "signing" ? "Waiting for Freighter…" : `Sign and deploy ${prepared.role}`}
              </button>
            </div>
          </div>
        ) : (
          <div className="deploy-action">
            <label className="field-label" htmlFor="private-session-id">PRIVATE session id</label>
            <input
              id="private-session-id"
              value={sessionId}
              disabled={confirmations.length > 0}
              onChange={(event) => setSessionId(event.target.value.trim())}
              placeholder="64 lowercase hex characters"
            />
            <div className="address-block"><span>Connected company · Testnet</span><strong>{short(address)}</strong></div>
            <button className="primary-button" disabled={state === "preparing"} onClick={prepare} type="button">
              {state === "preparing" ? "Simulating on Testnet…" : `Prepare ${currentRole}`}
            </button>
          </div>
        )}

        {error ? <p className="inline-error" role="alert">{error}</p> : null}
        <p className="helper-text">Agent seeds remain only in the encrypted local PrivacyStateStore and are never sent to Freighter or the browser.</p>
      </section>
    </div>
  );
}
