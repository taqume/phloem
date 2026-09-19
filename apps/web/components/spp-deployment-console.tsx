"use client";

import { useMemo, useState } from "react";

import { PHLOEM_NETWORK } from "../lib/network";
import {
  SPP_ARTIFACTS,
  SPP_DEPLOYMENT_STEPS,
  SPP_SOURCE_REVISION,
  SPP_USDC_ASSET,
  type CompletedSppDeploymentStep,
  type PreparedSppDeploymentStep,
  type SppContractIds,
} from "../lib/spp-deployment-types";

type ConsoleState = "idle" | "connecting" | "preparing" | "ready" | "signing" | "complete" | "error";

function short(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function stroopsToXlm(stroops: string): string {
  const value = BigInt(stroops);
  const whole = value / 10_000_000n;
  const fractional = (value % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return fractional ? `${whole}.${fractional}` : whole.toString();
}

function contractsFrom(results: CompletedSppDeploymentStep[]): SppContractIds {
  const contracts: SppContractIds = {};
  for (const result of results) {
    if (!result.contractId) continue;
    if (result.stepId === "create-asp-membership") contracts.aspMembership = result.contractId;
    if (result.stepId === "create-asp-non-membership") contracts.aspNonMembership = result.contractId;
    if (result.stepId === "create-verifier") contracts.verifier = result.contractId;
    if (result.stepId === "create-public-key-registry") contracts.publicKeyRegistry = result.contractId;
    if (result.stepId === "create-pool") contracts.pool = result.contractId;
  }
  return contracts;
}

export function SppDeploymentConsole() {
  const [address, setAddress] = useState<string | null>(null);
  const [state, setState] = useState<ConsoleState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [recordWarning, setRecordWarning] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedSppDeploymentStep | null>(null);
  const [results, setResults] = useState<CompletedSppDeploymentStep[]>([]);
  const step = SPP_DEPLOYMENT_STEPS[results.length];
  const contracts = useMemo(() => contractsFrom(results), [results]);
  const completed = results.length === SPP_DEPLOYMENT_STEPS.length;
  const totalFeeStroops = useMemo(
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
      const [{ address: connectedAddress }, network] = await Promise.all([
        StellarWalletsKit.fetchAddress(),
        StellarWalletsKit.getNetwork(),
      ]);
      if (network.networkPassphrase !== PHLOEM_NETWORK.networkPassphrase) {
        throw new Error("Freighter must be switched to Stellar Testnet.");
      }
      const storageKey = `phloem:spp-usdc-deployment:v2:${connectedAddress}`;
      const stored = window.localStorage.getItem(storageKey);
      const restored = stored ? (JSON.parse(stored) as CompletedSppDeploymentStep[]) : [];
      const valid = restored.every((result, index) => {
        const expected = SPP_DEPLOYMENT_STEPS[index];
        return expected?.id === result.stepId && SPP_ARTIFACTS[expected.artifactId].sha256 === result.wasmHash;
      });
      if (!valid || restored.length > SPP_DEPLOYMENT_STEPS.length) {
        throw new Error("Saved deployment progress is invalid. Remove the local browser record before continuing.");
      }
      setAddress(connectedAddress);
      setResults(restored);
      setPrepared(null);
      setState(restored.length === SPP_DEPLOYMENT_STEPS.length ? "complete" : "idle");
    } catch (reason) {
      setState("error");
      setError(reason instanceof Error ? reason.message : "Freighter connection failed.");
    }
  }

  async function prepareNext() {
    if (!address || !step) return;
    setState("preparing");
    setError(null);
    try {
      const response = await fetch("/api/ops/spp-deploy/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, contracts, stepId: step.id }),
      });
      const payload = (await response.json()) as PreparedSppDeploymentStep & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Preparation returned HTTP ${response.status}.`);
      setPrepared(payload);
      setState("ready");
    } catch (reason) {
      setState("error");
      setError(reason instanceof Error ? reason.message : "Transaction preparation failed.");
    }
  }

  async function signAndSubmit() {
    if (!address || !prepared || !step) return;
    if (prepared.stepId !== step.id) {
      setPrepared(null);
      setState("error");
      setError("Prepared transaction is stale. Prepare this step again.");
      return;
    }
    if (prepared.expiresAt <= Math.floor(Date.now() / 1000)) {
      setPrepared(null);
      setState("error");
      setError("Prepared transaction expired. Prepare it again with a fresh account sequence.");
      return;
    }

    setState("signing");
    setError(null);
    try {
      const [{ StellarWalletsKit }, StellarSdk] = await Promise.all([
        import("@creit.tech/stellar-wallets-kit"),
        import("@stellar/stellar-sdk"),
      ]);
      const unsignedTransaction = StellarSdk.TransactionBuilder.fromXDR(
        prepared.transactionXdr,
        PHLOEM_NETWORK.networkPassphrase,
      );
      if (!(unsignedTransaction instanceof StellarSdk.Transaction) || unsignedTransaction.source !== address) {
        throw new Error("Prepared transaction does not belong to the connected Freighter account.");
      }
      const unsignedOperation = unsignedTransaction.operations[0];
      const expectedHostFunction = step.kind === "upload"
        ? "hostFunctionTypeUploadContractWasm"
        : "hostFunctionTypeCreateContractV2";
      if (
        unsignedTransaction.operations.length !== 1
        || !unsignedOperation
        || unsignedOperation.type !== "invokeHostFunction"
        || unsignedOperation.func.type !== expectedHostFunction
      ) {
        throw new Error("Prepared transaction failed the client-side no-asset-movement audit.");
      }
      const { signedTxXdr, signerAddress } = await StellarWalletsKit.signTransaction(prepared.transactionXdr, {
        address,
        networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
      });
      if (signerAddress && signerAddress !== address) throw new Error("Freighter signed with a different account.");

      const transaction = StellarSdk.TransactionBuilder.fromXDR(signedTxXdr, PHLOEM_NETWORK.networkPassphrase);
      const rpcServer = new StellarSdk.rpc.Server(PHLOEM_NETWORK.rpcUrl);
      const submitted = await rpcServer.sendTransaction(transaction);
      if (submitted.status === "ERROR") throw new Error("Testnet rejected the signed deployment transaction.");
      if (submitted.status === "TRY_AGAIN_LATER") throw new Error("Testnet is temporarily busy. Prepare and sign this step again.");
      const final = await rpcServer.pollTransaction(submitted.hash, { attempts: 30 });
      if (final.status !== StellarSdk.rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`Deployment transaction ended with ${final.status}.`);
      }

      let contractId: string | undefined;
      if (step.kind === "create") {
        if (!final.returnValue) throw new Error("Deployment succeeded without a returned contract ID.");
        contractId = StellarSdk.Address.fromScVal(final.returnValue).toString();
        if (contractId !== prepared.expectedContractId) throw new Error("Created contract ID differs from the simulated ID.");
      }

      const completedStep: CompletedSppDeploymentStep = {
        ...(contractId ? { contractId } : {}),
        ledger: final.ledger,
        resource: prepared.resource,
        stepId: step.id,
        transactionHash: submitted.hash,
        wasmHash: prepared.expectedWasmHash,
      };
      const nextResults = [...results, completedStep];
      setResults(nextResults);
      window.localStorage.setItem(`phloem:spp-usdc-deployment:v2:${address}`, JSON.stringify(nextResults));
      setPrepared(null);
      setState(nextResults.length === SPP_DEPLOYMENT_STEPS.length ? "complete" : "idle");
      try {
        const recorded = await fetch("/api/ops/spp-deploy/progress", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address, results: nextResults }),
        });
        if (!recorded.ok) throw new Error(`Progress endpoint returned HTTP ${recorded.status}.`);
        setRecordWarning(null);
      } catch (recordReason) {
        setRecordWarning(recordReason instanceof Error ? recordReason.message : "Local evidence recording failed.");
      }
    } catch (reason) {
      setState("error");
      setError(reason instanceof Error ? reason.message : "Signing or submission failed.");
    }
  }

  return (
    <div className="deploy-console">
      <section className="deploy-overview" aria-labelledby="deployment-title">
        <div>
          <p className="eyebrow">Controlled Testnet operation</p>
          <h1 id="deployment-title">SPP / USDC deployment</h1>
          <p>
            Six explicit Freighter approvals create a fresh blocklist SPP deployment. Four pinned WASMs already on Testnet are reused; only the missing pool WASM is uploaded.
          </p>
        </div>
        <dl>
          <div><dt>Asset</dt><dd>{SPP_USDC_ASSET.code} · {short(SPP_USDC_ASSET.issuer)}</dd></div>
          <div><dt>SAC</dt><dd>{short(SPP_USDC_ASSET.sacContractId)}</dd></div>
          <div><dt>SPP revision</dt><dd>{SPP_SOURCE_REVISION.slice(0, 12)}</dd></div>
          <div><dt>Asset movement</dt><dd className="ready-text">Disabled</dd></div>
        </dl>
      </section>

      <section className="panel deploy-panel" aria-labelledby="signing-title">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Freighter boundary</p>
            <h2 id="signing-title">Review, then sign one transaction</h2>
          </div>
          <span className={`status-chip ${completed ? "is-ready" : "is-pending"}`}>
            <span aria-hidden="true" className="status-dot" />
            {results.length} / {SPP_DEPLOYMENT_STEPS.length}
          </span>
        </div>

        {!address ? (
          <div className="deploy-action">
            <p>Connect the same funded Testnet account that will own and administer the SPP contracts.</p>
            <button className="primary-button" disabled={state === "connecting"} onClick={connectFreighter} type="button">
              {state === "connecting" ? "Connecting…" : "Connect Freighter"}
            </button>
          </div>
        ) : (
          <>
            <div className="address-block">
              <span>Deployer and admin · Testnet</span>
              <strong title={address}>{short(address)}</strong>
            </div>

            {step ? (
              <div className="deploy-action">
                <span className="step-index">STEP {String(results.length + 1).padStart(2, "0")}</span>
                <h3>{step.label}</h3>
                <p>{step.kind === "upload" ? "Uploads pinned contract bytecode only." : "Creates the contract and applies its fixed constructor configuration."}</p>

                {prepared ? (
                  <div className="transaction-review" aria-label="Prepared transaction review">
                    <p>{prepared.summary}</p>
                    <dl>
                      <div><dt>Host function</dt><dd>{prepared.safety.hostFunction}</dd></div>
                      <div><dt>Operations</dt><dd>{prepared.safety.operationCount}</dd></div>
                      <div><dt>Asset movement</dt><dd className="ready-text">None</dd></div>
                      <div><dt>Maximum fee</dt><dd>{stroopsToXlm(prepared.resource.totalFeeStroops)} XLM</dd></div>
                      <div><dt>Instructions</dt><dd>{prepared.resource.instructions.toLocaleString("en-US")}</dd></div>
                      <div><dt>Write bytes</dt><dd>{prepared.resource.writeBytes.toLocaleString("en-US")}</dd></div>
                    </dl>
                    {prepared.expectedContractId ? <code>{prepared.expectedContractId}</code> : <code>{prepared.expectedWasmHash}</code>}
                    <button className="primary-button" disabled={state === "signing"} onClick={signAndSubmit} type="button">
                      {state === "signing" ? "Waiting for Freighter…" : "Sign and submit this fee-only transaction"}
                    </button>
                  </div>
                ) : (
                  <button className="primary-button" disabled={state === "preparing"} onClick={prepareNext} type="button">
                    {state === "preparing" ? "Simulating on Testnet…" : "Prepare and inspect transaction"}
                  </button>
                )}
              </div>
            ) : (
              <div className="deploy-complete" role="status">
                <strong>Fresh SPP USDC deployment complete.</strong>
                <span>Maximum fees declared across confirmed transactions: {stroopsToXlm(totalFeeStroops)} XLM</span>
                <code>{contracts.pool}</code>
              </div>
            )}
          </>
        )}

        {error ? <p className="inline-error" role="alert">{error}</p> : null}
        {recordWarning ? <p className="inline-notice" role="status">Transaction confirmed; browser recovery state is safe, but the repo-local evidence copy failed: {recordWarning}</p> : null}
        <p className="helper-text">No USDC deposit, transfer, allowance, trustline or withdrawal operation can be generated by this console.</p>
      </section>

      <section className="deploy-ledger" aria-labelledby="ledger-title">
        <div className="section-heading">
          <p className="eyebrow">Evidence ledger</p>
          <h2 id="ledger-title">Pinned artifacts and confirmed transactions</h2>
        </div>
        <ol>
          {SPP_DEPLOYMENT_STEPS.map((deploymentStep, index) => {
            const result = results[index];
            const artifact = SPP_ARTIFACTS[deploymentStep.artifactId];
            return (
              <li className={result ? "is-complete" : index === results.length ? "is-current" : ""} key={deploymentStep.id}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <strong>{deploymentStep.label}</strong>
                  <small>{artifact.sha256.slice(0, 14)}… · {artifact.size.toLocaleString("en-US")} bytes</small>
                </div>
                <b>{result ? `ledger ${result.ledger}` : index === results.length ? "next" : "pending"}</b>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
