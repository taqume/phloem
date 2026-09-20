"use client";

import { useState } from "react";

import { PHLOEM_NETWORK } from "../lib/network";
import type {
  PreparedPrivateActivation,
  PrivateActivationConfirmation,
} from "../lib/private-activation-types";
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

export function PrivateActivationConsole() {
  const [state, setState] = useState<State>("idle");
  const [address, setAddress] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [prepared, setPrepared] = useState<PreparedPrivateActivation | null>(null);
  const [confirmation, setConfirmation] = useState<PrivateActivationConfirmation | null>(null);
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
      const response = await fetch("/api/ops/private-activation/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ company: address, sessionId }),
      });
      const payload = await response.json() as PreparedPrivateActivation & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Preparation returned HTTP ${response.status}.`);
      setPrepared(payload);
      setState("ready");
    } catch (reason) {
      setState("error");
      setError(reason instanceof Error ? reason.message : "PRIVATE activation preparation failed.");
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
        throw new Error("Prepared activation failed its source, hash, operation-count, or fee audit.");
      }
      const operation = unsigned.operations[0];
      if (!operation
        || operation.type !== "invokeHostFunction"
        || operation.func.type !== "hostFunctionTypeInvokeContract"
        || StellarSdk.Address.fromScAddress(operation.func.invokeContract.contractAddress).toString()
          !== PHLOEM_NETWORK.treasuryControllerId
        || operation.func.invokeContract.functionName.toString() !== "activate_private_session"
        || (operation.auth ?? []).length !== 1) {
        throw new Error("Prepared transaction is not the canonical PRIVATE activation call.");
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
        throw new Error("Signed activation differs from the audited preflight.");
      }

      const server = new StellarSdk.rpc.Server(PHLOEM_NETWORK.rpcUrl);
      failureStage = "RPC submission";
      submissionAttempted = true;
      const submitted = await server.sendTransaction(signed);
      if (submitted.status === "ERROR") throw new Error("Testnet rejected PRIVATE activation.");
      if (submitted.status === "TRY_AGAIN_LATER") throw new Error("Testnet is busy; prepare the activation again.");
      failureStage = "Testnet confirmation";
      const final = await server.pollTransaction(submitted.hash, { attempts: 60 });
      if (final.status !== StellarSdk.rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`PRIVATE activation ended with ${final.status}.`);
      }

      failureStage = "Encrypted state reconciliation";
      const response = await fetch("/api/ops/private-activation/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          transactionHash: submitted.hash,
          operationId: prepared.operationId,
          sessionId: prepared.sessionId,
        }),
      });
      const confirmed = await response.json() as PrivateActivationConfirmation & { error?: string };
      if (!response.ok) throw new Error(confirmed.error ?? `Confirmation returned HTTP ${response.status}.`);
      setConfirmation(confirmed);
      setState("complete");
    } catch (reason) {
      let cleanupFailure: string | undefined;
      if (!submissionAttempted) {
        try {
          const response = await fetch("/api/ops/private-activation/abort", {
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
      const message = walletStageError(failureStage, reason, "PRIVATE activation failed.");
      setError(cleanupFailure ? `${message} Prepared state cleanup also failed: ${cleanupFailure}.` : message);
    }
  }

  return (
    <div className="deploy-console">
      <section className="deploy-overview" aria-labelledby="private-activation-title">
        <div>
          <p className="eyebrow">Company authorization · real USDC movement</p>
          <h1 id="private-activation-title">Activate PRIVATE authority</h1>
          <p>Atomically deposit company USDC into the pinned SPP pool, create the hidden root budget and initialize the private audit accumulator.</p>
        </div>
        <dl>
          <div><dt>Controller</dt><dd>{short(PHLOEM_NETWORK.treasuryControllerId)}</dd></div>
          <div><dt>SPP pool</dt><dd>{short(PHLOEM_NETWORK.sppPoolId)}</dd></div>
          <div><dt>Asset</dt><dd>Circle Testnet USDC</dd></div>
          <div><dt>Asset movement</dt><dd>1.0000000 USDC</dd></div>
        </dl>
      </section>

      <section className="panel deploy-panel" aria-labelledby="private-activation-action-title">
        <div className="panel-heading">
          <div><p className="eyebrow">Freighter boundary</p><h2 id="private-activation-action-title">Review the atomic funding call</h2></div>
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
            <strong>PRIVATE session is ACTIVE and SPP-backed.</strong>
            <span>Root note {short(confirmation.rootNoteId)} · SPP leaf {confirmation.fundingLeafIndex}</span>
            <code>{confirmation.transactionHash}</code>
          </div>
        ) : prepared ? (
          <div className="deploy-action">
            <div className="address-block"><span>CompanyFundingAccount · Testnet</span><strong>{short(address)}</strong></div>
            <div className="transaction-review" aria-label="Prepared PRIVATE activation review">
              <p>One `activate_private_session` call. It moves exactly {prepared.fundingAmountDisplay} USDC into the pinned SPP pool and creates no allowance.</p>
              <dl>
                <div><dt>Function</dt><dd>{prepared.safety.functionName}</dd></div>
                <div><dt>Operations</dt><dd>{prepared.safety.operationCount}</dd></div>
                <div><dt>Maximum fee</dt><dd>{stroopsToXlm(prepared.resource.maximumFeeStroops)} XLM</dd></div>
                <div><dt>USDC movement</dt><dd>{prepared.fundingAmountDisplay} USDC</dd></div>
                <div><dt>Issuer</dt><dd>{short(prepared.assetIssuer)}</dd></div>
                <div><dt>SPP pool</dt><dd>{short(prepared.safety.sppPool)}</dd></div>
              </dl>
              <code>{prepared.transactionHash}</code>
              <button className="primary-button" disabled={state === "signing"} onClick={signAndSubmit} type="button">
                {state === "signing" ? "Waiting for Freighter…" : `Sign and deposit ${prepared.fundingAmountDisplay} USDC`}
              </button>
            </div>
          </div>
        ) : (
          <div className="deploy-action">
            <label className="field-label" htmlFor="activation-session-id">PRIVATE session id</label>
            <input
              id="activation-session-id"
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value.trim())}
              placeholder="64 lowercase hex characters"
            />
            <div className="address-block"><span>Connected company · Testnet</span><strong>{short(address)}</strong></div>
            <button className="primary-button" disabled={state === "preparing"} onClick={prepare} type="button">
              {state === "preparing" ? "Generating proofs and simulating…" : "Prepare 1 USDC activation"}
            </button>
          </div>
        )}

        {error ? <p className="inline-error" role="alert">{error}</p> : null}
        <p className="helper-text">Preparation is non-custodial and does not submit anything. Only the reviewed Freighter signature can move the displayed Testnet USDC.</p>
      </section>
    </div>
  );
}
