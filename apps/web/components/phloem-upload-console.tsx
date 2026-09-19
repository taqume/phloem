"use client";

import { useMemo, useState } from "react";

import { PHLOEM_NETWORK } from "../lib/network";
import {
  PHLOEM_ARTIFACTS,
  PHLOEM_CONTRACT_SOURCE_REVISION,
  PHLOEM_DEPLOYER,
  PHLOEM_UPLOAD_FEE_LIMIT_STROOPS,
  PHLOEM_UPLOAD_STEPS,
  feeGuardrailStroops,
  type CompletedPhloemUpload,
  type PreparedPhloemUpload,
} from "../lib/phloem-deployment-types";
import { requestWalletConnection, walletErrorMessage, walletStageError } from "../lib/wallet-connection";

type ConsoleState = "idle" | "connecting" | "preparing" | "ready" | "signing" | "complete" | "error";
const STORAGE_KEY = `phloem:contract-wasm-uploads:v1:${PHLOEM_DEPLOYER}`;

function short(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function stroopsToXlm(stroops: string): string {
  const value = BigInt(stroops);
  const whole = value / 10_000_000n;
  const fractional = (value % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return fractional ? `${whole}.${fractional}` : whole.toString();
}

function loadProgress(): CompletedPhloemUpload[] {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) as CompletedPhloemUpload[] : [];
  } catch {
    return [];
  }
}

function saveProgress(results: CompletedPhloemUpload[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(results));
  } catch {
    // Repo-local evidence remains authoritative for this controlled deployment operation.
  }
}

function validProgress(results: CompletedPhloemUpload[]): boolean {
  if (results.length > PHLOEM_UPLOAD_STEPS.length) return false;
  return results.every((result, index) => {
    const step = PHLOEM_UPLOAD_STEPS[index];
    return step?.id === result.stepId
      && step.artifactId === result.artifactId
      && PHLOEM_ARTIFACTS[step.artifactId].sha256 === result.wasmHash;
  });
}

async function browserSha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error("Expected a 32-byte hexadecimal hash.");
  return Uint8Array.from(value.match(/.{2}/g)!, (byte) => Number.parseInt(byte, 16));
}

export function PhloemUploadConsole() {
  const [address, setAddress] = useState<string | null>(null);
  const [state, setState] = useState<ConsoleState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [recordWarning, setRecordWarning] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedPhloemUpload | null>(null);
  const [results, setResults] = useState<CompletedPhloemUpload[]>([]);
  const step = PHLOEM_UPLOAD_STEPS[results.length];
  const completed = results.length === PHLOEM_UPLOAD_STEPS.length;
  const confirmedFee = useMemo(
    () => results.reduce((sum, result) => sum + BigInt(result.resource.totalFeeStroops), 0n).toString(),
    [results],
  );

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
      if (connection.address !== PHLOEM_DEPLOYER) {
        throw new Error(`Freighter must use the approved deployer ${short(PHLOEM_DEPLOYER)}.`);
      }
      const restored = loadProgress();
      if (!validProgress(restored)) throw new Error("Saved upload progress is invalid; clear the versioned browser record.");
      setAddress(connection.address);
      setResults(restored);
      setPrepared(null);
      setState(restored.length === PHLOEM_UPLOAD_STEPS.length ? "complete" : "idle");
    } catch (reason) {
      setState("error");
      setError(walletErrorMessage(reason, "Freighter connection failed."));
    }
  }

  async function prepareNext() {
    if (!address || !step) return;
    setState("preparing");
    setError(null);
    try {
      const response = await fetch("/api/ops/phloem-deploy/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, completed: results, stepId: step.id }),
      });
      const payload = await response.json() as PreparedPhloemUpload & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Preparation returned HTTP ${response.status}.`);
      setPrepared(payload);
      setState("ready");
    } catch (reason) {
      setState("error");
      setError(reason instanceof Error ? reason.message : "Upload preparation failed.");
    }
  }

  async function signAndSubmit() {
    if (!address || !prepared || !step) return;
    if (prepared.stepId !== step.id || prepared.expiresAt <= Math.floor(Date.now() / 1000)) {
      setPrepared(null);
      setState("error");
      setError("Prepared transaction is stale or expired. Simulate it again.");
      return;
    }

    setState("signing");
    setError(null);
    let failureStage = "Client transaction audit";
    try {
      const [{ StellarWalletsKit }, StellarSdk] = await Promise.all([
        import("@creit.tech/stellar-wallets-kit"),
        import("@stellar/stellar-sdk"),
      ]);
      const unsigned = StellarSdk.TransactionBuilder.fromXDR(prepared.transactionXdr, PHLOEM_NETWORK.networkPassphrase);
      if (!(unsigned instanceof StellarSdk.Transaction) || unsigned.source !== address) {
        throw new Error("Prepared transaction does not belong to the connected Freighter account.");
      }
      const operation = unsigned.operations[0];
      if (
        unsigned.operations.length !== 1
        || !operation
        || operation.type !== "invokeHostFunction"
        || operation.func.type !== "hostFunctionTypeUploadContractWasm"
      ) {
        throw new Error("Client audit rejected a non-upload operation.");
      }
      const artifact = PHLOEM_ARTIFACTS[step.artifactId];
      if (await browserSha256(operation.func.wasm) !== artifact.sha256) {
        throw new Error("Client audit rejected a substituted WASM artifact.");
      }
      if (
        BigInt(unsigned.fee) > BigInt(prepared.feeLimit.artifactGuardrailStroops)
        || BigInt(prepared.feeLimit.projectedTotalStroops) > BigInt(prepared.feeLimit.approvedTotalGuardrailStroops)
      ) {
        throw new Error("Client audit rejected a fee above the approved preflight limit.");
      }

      failureStage = "Freighter signing";
      const { signedTxXdr, signerAddress } = await StellarWalletsKit.signTransaction(prepared.transactionXdr, {
        address,
        networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
      });
      if (signerAddress && signerAddress !== address) throw new Error("Freighter signed with a different account.");
      const signed = StellarSdk.TransactionBuilder.fromXDR(signedTxXdr, PHLOEM_NETWORK.networkPassphrase);
      const rpcServer = new StellarSdk.rpc.Server(PHLOEM_NETWORK.rpcUrl);
      failureStage = "RPC submission";
      const submitted = await rpcServer.sendTransaction(signed);
      if (submitted.status === "ERROR") throw new Error("Testnet rejected the signed WASM upload.");
      if (submitted.status === "TRY_AGAIN_LATER") throw new Error("Testnet is busy. Prepare this upload again.");
      failureStage = "Testnet confirmation";
      const final = await rpcServer.pollTransaction(submitted.hash, { attempts: 30 });
      if (final.status !== StellarSdk.rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`WASM upload ended with ${final.status}.`);
      }
      failureStage = "WASM hash verification";
      const uploaded = await rpcServer.getContractWasmByHash(hexToBytes(artifact.sha256));
      if (await browserSha256(uploaded) !== artifact.sha256) throw new Error("Uploaded Testnet WASM hash verification failed.");

      const completedStep: CompletedPhloemUpload = {
        artifactId: step.artifactId,
        ledger: final.ledger,
        resource: prepared.resource,
        stepId: step.id,
        transactionHash: submitted.hash,
        wasmHash: artifact.sha256,
      };
      const nextResults = [...results, completedStep];
      setResults(nextResults);
      saveProgress(nextResults);
      setPrepared(null);
      setState(nextResults.length === PHLOEM_UPLOAD_STEPS.length ? "complete" : "idle");
      try {
        const recorded = await fetch("/api/ops/phloem-deploy/progress", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address, results: nextResults }),
        });
        if (!recorded.ok) throw new Error(`Evidence endpoint returned HTTP ${recorded.status}.`);
        setRecordWarning(null);
      } catch (recordReason) {
        setRecordWarning(recordReason instanceof Error ? recordReason.message : "Repo-local evidence recording failed.");
      }
    } catch (reason) {
      setState("error");
      setError(walletStageError(failureStage, reason, "Signing or submission failed."));
    }
  }

  return (
    <div className="deploy-console">
      <section className="deploy-overview" aria-labelledby="deployment-title">
        <div>
          <p className="eyebrow">Approved fee-only Testnet operation</p>
          <h1 id="deployment-title">Phloem WASM uploads</h1>
          <p>Six pinned contract artifacts are uploaded one at a time. Instantiation, initialization and asset movement are structurally excluded.</p>
        </div>
        <dl>
          <div><dt>Source revision</dt><dd>{PHLOEM_CONTRACT_SOURCE_REVISION.slice(0, 12)}</dd></div>
          <div><dt>Deployer</dt><dd>{short(PHLOEM_DEPLOYER)}</dd></div>
          <div><dt>Preflight estimate</dt><dd>{stroopsToXlm(PHLOEM_UPLOAD_FEE_LIMIT_STROOPS)} XLM</dd></div>
          <div><dt>1% stop guardrail</dt><dd>{stroopsToXlm(feeGuardrailStroops(PHLOEM_UPLOAD_FEE_LIMIT_STROOPS))} XLM</dd></div>
          <div><dt>Asset movement</dt><dd className="ready-text">Disabled</dd></div>
        </dl>
      </section>

      <section className="panel deploy-panel" aria-labelledby="signing-title">
        <div className="panel-heading">
          <div><p className="eyebrow">Freighter boundary</p><h2 id="signing-title">Inspect and approve each upload</h2></div>
          <span className={`status-chip ${completed ? "is-ready" : "is-pending"}`}><span aria-hidden="true" className="status-dot" />{results.length} / {PHLOEM_UPLOAD_STEPS.length}</span>
        </div>

        {!address ? (
          <div className="deploy-action">
            <p>Connect the approved funded Testnet deployer. No signing request occurs during connection.</p>
            <button className="primary-button" disabled={state === "connecting"} onClick={connectFreighter} type="button">
              {state === "connecting" ? "Connecting…" : "Connect Freighter"}
            </button>
          </div>
        ) : step ? (
          <div className="deploy-action">
            <div className="address-block"><span>Approved deployer · Testnet</span><strong title={address}>{short(address)}</strong></div>
            <span className="step-index">UPLOAD {String(results.length + 1).padStart(2, "0")}</span>
            <h3>{step.label}</h3>
            {prepared ? (
              <div className="transaction-review" aria-label="Prepared upload review">
                <p>{prepared.summary}</p>
                <dl>
                  <div><dt>Host function</dt><dd>{prepared.safety.hostFunction}</dd></div>
                  <div><dt>Operations</dt><dd>{prepared.safety.operationCount}</dd></div>
                  <div><dt>Contract invocation</dt><dd className="ready-text">None</dd></div>
                  <div><dt>Asset movement</dt><dd className="ready-text">None</dd></div>
                  <div><dt>Maximum fee</dt><dd>{stroopsToXlm(prepared.resource.totalFeeStroops)} XLM</dd></div>
                  <div><dt>Projected cumulative</dt><dd>{stroopsToXlm(prepared.feeLimit.projectedTotalStroops)} XLM</dd></div>
                  <div><dt>Instructions</dt><dd>{prepared.resource.instructions.toLocaleString("en-US")}</dd></div>
                  <div><dt>Write bytes</dt><dd>{prepared.resource.writeBytes.toLocaleString("en-US")}</dd></div>
                </dl>
                <code>{prepared.expectedWasmHash}</code>
                <button className="primary-button" disabled={state === "signing"} onClick={signAndSubmit} type="button">
                  {state === "signing" ? "Waiting for Freighter…" : "Sign and upload this WASM"}
                </button>
              </div>
            ) : (
              <button className="primary-button" disabled={state === "preparing"} onClick={prepareNext} type="button">
                {state === "preparing" ? "Simulating on Testnet…" : "Prepare and inspect upload"}
              </button>
            )}
          </div>
        ) : (
          <div className="deploy-complete" role="status">
            <strong>All six approved WASM uploads are confirmed.</strong>
            <span>Confirmed declared fees: {stroopsToXlm(confirmedFee)} XLM</span>
          </div>
        )}

        {error ? <p className="inline-error" role="alert">{error}</p> : null}
        {recordWarning ? <p className="inline-notice" role="status">Upload confirmed, but repo-local evidence recording failed: {recordWarning}</p> : null}
        <p className="helper-text">This console cannot create contracts, invoke constructors, initialize state, or move XLM/USDC except for the network fee charged for each WASM upload.</p>
      </section>

      <section className="deploy-ledger" aria-labelledby="ledger-title">
        <div className="section-heading"><p className="eyebrow">Upload ledger</p><h2 id="ledger-title">Pinned artifacts</h2></div>
        <ol>
          {PHLOEM_UPLOAD_STEPS.map((upload, index) => {
            const result = results[index];
            const artifact = PHLOEM_ARTIFACTS[upload.artifactId];
            return (
              <li className={result ? "is-complete" : index === results.length ? "is-current" : ""} key={upload.id}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div><strong>{upload.label}</strong><small>{artifact.sha256.slice(0, 14)}… · {artifact.size.toLocaleString("en-US")} bytes</small></div>
                <b>{result ? `ledger ${result.ledger}` : index === results.length ? "next" : "pending"}</b>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
