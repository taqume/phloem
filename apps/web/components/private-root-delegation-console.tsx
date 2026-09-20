"use client";

import { useState } from "react";

import { PHLOEM_NETWORK } from "../lib/network";
import type {
  PreparedPrivateRootDelegation,
  PrivateRootDelegationConfirmation,
} from "../lib/private-root-delegation-types";
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

function usdcFromAtomic(value: string): string {
  return `${BigInt(value) / 10_000_000n}.${(BigInt(value) % 10_000_000n).toString().padStart(7, "0")}`;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function PrivateRootDelegationConsole() {
  const [state, setState] = useState<State>("idle");
  const [address, setAddress] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [prepared, setPrepared] = useState<PreparedPrivateRootDelegation | null>(null);
  const [confirmation, setConfirmation] = useState<PrivateRootDelegationConfirmation | null>(null);
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
    if (!address || !/^[0-9a-f]{64}$/u.test(sessionId)) {
      setError("Enter the 32-byte lowercase PRIVATE session id.");
      return;
    }
    setState("preparing");
    setError(null);
    try {
      const response = await fetch("/api/ops/private-root-delegation/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ company: address, sessionId }),
      });
      const payload = await response.json() as PreparedPrivateRootDelegation & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Preparation returned HTTP ${response.status}.`);
      setPrepared(payload);
      setState("ready");
    } catch (reason) {
      setState("error");
      setError(reason instanceof Error ? reason.message : "PRIVATE root delegation preparation failed.");
    }
  }

  async function signAndSubmit() {
    if (!address || !prepared) return;
    setState("signing");
    setError(null);
    let failureStage = "Client transaction audit";
    let submissionAttempted = false;
    try {
      const [{ StellarWalletsKit }, StellarSdk] = await Promise.all([
        import("@creit.tech/stellar-wallets-kit"),
        import("@stellar/stellar-sdk"),
      ]);
      const unsigned = StellarSdk.TransactionBuilder.fromXDR(prepared.transactionXdr, PHLOEM_NETWORK.networkPassphrase);
      if (!(unsigned instanceof StellarSdk.Transaction)
        || unsigned.source !== address
        || unsigned.operations.length !== 1
        || BigInt(unsigned.fee) > BigInt(prepared.resource.approvedFeeCeilingStroops)
        || Buffer.from(unsigned.hash()).toString("hex") !== prepared.transactionHash) {
        throw new Error("Prepared delegation failed its source, hash, operation-count, or fee audit.");
      }
      const operation = unsigned.operations[0];
      if (!operation
        || operation.type !== "invokeHostFunction"
        || operation.func.type !== "hostFunctionTypeInvokeContract"
        || StellarSdk.Address.fromScAddress(operation.func.invokeContract.contractAddress).toString()
          !== PHLOEM_NETWORK.treasuryControllerId
        || operation.func.invokeContract.functionName.toString() !== "delegate_private_root"
        || (operation.auth ?? []).length !== 1) {
        throw new Error("Prepared transaction is not the canonical PRIVATE root delegation.");
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
        throw new Error("Signed root delegation differs from the audited preflight.");
      }

      const server = new StellarSdk.rpc.Server(PHLOEM_NETWORK.rpcUrl);
      failureStage = "RPC submission";
      submissionAttempted = true;
      const submitted = await server.sendTransaction(signed);
      if (submitted.status === "ERROR") throw new Error("Testnet rejected PRIVATE root delegation.");
      if (submitted.status === "TRY_AGAIN_LATER") throw new Error("Testnet is busy; prepare the delegation again.");
      failureStage = "Testnet confirmation";
      const final = await server.pollTransaction(submitted.hash, { attempts: 60 });
      if (final.status !== StellarSdk.rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`PRIVATE root delegation ended with ${final.status}.`);
      }

      failureStage = "Encrypted state reconciliation";
      const response = await fetch("/api/ops/private-root-delegation/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          transactionHash: submitted.hash,
          operationId: prepared.operationId,
          sessionId: prepared.sessionId,
        }),
      });
      const confirmed = await response.json() as PrivateRootDelegationConfirmation & { error?: string };
      if (!response.ok) throw new Error(confirmed.error ?? `Confirmation returned HTTP ${response.status}.`);
      setConfirmation(confirmed);
      setState("complete");
    } catch (reason) {
      let cleanupFailure: string | undefined;
      if (!submissionAttempted) {
        try {
          const response = await fetch("/api/ops/private-root-delegation/abort", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ operationId: prepared.operationId, sessionId: prepared.sessionId }),
          });
          if (!response.ok) throw new Error(`abort returned HTTP ${response.status}`);
          setPrepared(null);
        } catch (cleanupReason) {
          cleanupFailure = cleanupReason instanceof Error ? cleanupReason.message : "unknown abort failure";
        }
      }
      setState("error");
      const message = walletStageError(failureStage, reason, "PRIVATE root delegation failed.");
      setError(cleanupFailure ? `${message} Prepared state cleanup also failed: ${cleanupFailure}.` : message);
    }
  }

  return (
    <div className="deploy-console">
      <section className="deploy-overview" aria-labelledby="root-delegation-title">
        <div>
          <p className="eyebrow">Company root → bounded Supervisor</p>
          <h1 id="root-delegation-title">Delegate PRIVATE authority</h1>
          <p>Consume the company-owned hidden root note and create one session-bound Supervisor note without moving USDC.</p>
        </div>
        <dl>
          <div><dt>Controller</dt><dd>{short(PHLOEM_NETWORK.treasuryControllerId)}</dd></div>
          <div><dt>Child</dt><dd>Supervisor AgentAccount</dd></div>
          <div><dt>Category mask</dt><dd>4 · Research</dd></div>
          <div><dt>Asset movement</dt><dd className="ready-text">None</dd></div>
        </dl>
      </section>

      <section className="panel deploy-panel" aria-labelledby="root-delegation-action-title">
        <div className="panel-heading">
          <div><p className="eyebrow">Freighter boundary</p><h2 id="root-delegation-action-title">Review one company-authorized delegation</h2></div>
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
            <strong>Supervisor PRIVATE authority is confirmed.</strong>
            <span>Note {short(confirmation.childNoteId)} · ledger {confirmation.ledger}</span>
            <code>{confirmation.transactionHash}</code>
          </div>
        ) : prepared ? (
          <div className="deploy-action">
            <div className="address-block"><span>Supervisor AgentAccount · Testnet</span><strong>{short(prepared.supervisor)}</strong></div>
            <div className="transaction-review" aria-label="Prepared PRIVATE root delegation review">
              <p>One `delegate_private_root` call. It delegates {usdcFromAtomic(prepared.delegatedAmountAtomic)} USDC of hidden budget authority; no token transfer or allowance occurs.</p>
              <dl>
                <div><dt>Function</dt><dd>{prepared.safety.functionName}</dd></div>
                <div><dt>Maximum fee</dt><dd>{stroopsToXlm(prepared.resource.maximumFeeStroops)} XLM</dd></div>
                <div><dt>Category mask</dt><dd>{prepared.policy.categoryMask}</dd></div>
                <div><dt>Actions mask</dt><dd>{prepared.policy.allowedActionsMask}</dd></div>
                <div><dt>Delegation depth</dt><dd>{prepared.policy.remainingDelegationDepth}</dd></div>
                <div><dt>Asset movement</dt><dd className="ready-text">None</dd></div>
              </dl>
              <code>{prepared.transactionHash}</code>
              <button className="primary-button" disabled={state === "signing"} onClick={signAndSubmit} type="button">
                {state === "signing" ? "Waiting for Freighter…" : "Sign and delegate to Supervisor"}
              </button>
            </div>
          </div>
        ) : (
          <div className="deploy-action">
            <label className="field-label" htmlFor="root-delegation-session-id">PRIVATE session id</label>
            <input
              id="root-delegation-session-id"
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value.trim())}
              placeholder="64 lowercase hex characters"
            />
            <div className="address-block"><span>Connected company · Testnet</span><strong>{short(address)}</strong></div>
            <button className="primary-button" disabled={state === "preparing"} onClick={prepare} type="button">
              {state === "preparing" ? "Generating proof and simulating…" : "Prepare root delegation"}
            </button>
          </div>
        )}

        {error ? <p className="inline-error" role="alert">{error}</p> : null}
        <p className="helper-text">This call changes bounded authority state only. It cannot transfer USDC, create an allowance, or alter the immutable session policy.</p>
      </section>
    </div>
  );
}
