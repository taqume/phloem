import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  contract,
  rpc,
} from "@stellar/stellar-sdk";

import { PHLOEM_NETWORK } from "../network";
import {
  SPP_ARTIFACTS,
  SPP_DEPLOYMENT_CONFIG,
  SPP_DEPLOYMENT_STEPS,
  SPP_REUSED_TESTNET_WASM,
  SPP_SOURCE_REVISION,
  SPP_USDC_ASSET,
  type PreparedSppDeploymentStep,
  type CompletedSppDeploymentStep,
  type SppArtifactId,
  type SppContractIds,
  type SppDeploymentStep,
  type SppDeploymentStepId,
} from "../spp-deployment-types";

const REPO_ROOT = existsSync(resolve(process.cwd(), "pnpm-workspace.yaml"))
  ? process.cwd()
  : resolve(process.cwd(), "..", "..");
const WASM_DIRECTORY = resolve(REPO_ROOT, "target", "spp-testnet-usdc");
const LOCAL_DEPLOYMENT_DIRECTORY = resolve(REPO_ROOT, "deployments", "local");
const LOCAL_DEPLOYMENT_FILE = resolve(LOCAL_DEPLOYMENT_DIRECTORY, "spp-usdc-testnet-progress.json");
const TRANSACTION_TIMEOUT_SECONDS = 300;

const server = new rpc.Server(PHLOEM_NETWORK.rpcUrl);

function tomlValue(block: string, key: string): string | undefined {
  const match = block.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"\\s*$`, "m"));
  return match?.[1];
}

export async function verifySppUsdcAsset() {
  const stellarTomlUrl = `${PHLOEM_NETWORK.anchorBaseUrl}/.well-known/stellar.toml`;
  const issuerAccountUrl = `${PHLOEM_NETWORK.horizonUrl}/accounts/${SPP_USDC_ASSET.issuer}`;
  const [tomlResponse, issuerResponse, symbol, name, decimals] = await Promise.all([
    fetch(stellarTomlUrl, { cache: "no-store", signal: AbortSignal.timeout(10_000) }),
    fetch(issuerAccountUrl, { cache: "no-store", signal: AbortSignal.timeout(10_000) }),
    server.queryContract<string>(SPP_USDC_ASSET.sacContractId, "symbol"),
    server.queryContract<string>(SPP_USDC_ASSET.sacContractId, "name"),
    server.queryContract<number>(SPP_USDC_ASSET.sacContractId, "decimals"),
  ]);
  if (!tomlResponse.ok) throw new Error(`Anchor stellar.toml returned HTTP ${tomlResponse.status}.`);
  if (!issuerResponse.ok) throw new Error(`Testnet issuer account returned HTTP ${issuerResponse.status}.`);

  const stellarToml = await tomlResponse.text();
  const currency = stellarToml
    .split("[[CURRENCIES]]")
    .slice(1)
    .find((block) => tomlValue(block, "code") === SPP_USDC_ASSET.code);
  if (!currency) throw new Error("Anchor discovery does not advertise USDC.");
  if (tomlValue(currency, "issuer") !== SPP_USDC_ASSET.issuer) {
    throw new Error("Anchor USDC issuer differs from the pinned deployment asset.");
  }

  const derivedSac = new Asset(SPP_USDC_ASSET.code, SPP_USDC_ASSET.issuer).contractId(Networks.TESTNET);
  if (derivedSac !== SPP_USDC_ASSET.sacContractId) throw new Error("Derived Testnet USDC SAC differs from the deployment asset.");
  if (symbol.result !== SPP_USDC_ASSET.code || decimals.result !== 7) {
    throw new Error("Testnet USDC SAC metadata does not match the expected asset.");
  }
  const expectedName = `${SPP_USDC_ASSET.code}:${SPP_USDC_ASSET.issuer}`;
  if (name.result !== expectedName) throw new Error("Testnet USDC SAC name does not bind the expected issuer.");

  return {
    anchorStellarToml: stellarTomlUrl,
    checkedAt: new Date().toISOString(),
    decimals: decimals.result,
    issuerAccount: issuerAccountUrl,
    name: name.result,
    symbol: symbol.result,
  };
}

function deploymentStep(stepId: string): SppDeploymentStep {
  const step = SPP_DEPLOYMENT_STEPS.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error("Unknown SPP deployment step.");
  return step;
}

async function readVerifiedArtifact(artifactId: SppArtifactId): Promise<Uint8Array> {
  const artifact = SPP_ARTIFACTS[artifactId];
  const bytes = await readFile(resolve(WASM_DIRECTORY, artifact.fileName));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== artifact.sha256 || bytes.byteLength !== artifact.size) {
    throw new Error(`Pinned SPP artifact mismatch for ${artifact.fileName}. Rebuild before signing.`);
  }
  return bytes;
}

async function verifyTestnetWasm(artifactId: SppArtifactId) {
  const artifact = SPP_ARTIFACTS[artifactId];
  const bytes = await server.getContractWasmByHash(Buffer.from(artifact.sha256, "hex"));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== artifact.sha256 || bytes.byteLength !== artifact.size) {
    throw new Error(`Testnet WASM does not match the pinned ${artifact.fileName} artifact.`);
  }
  return { byteLength: bytes.byteLength, sha256: digest };
}

export async function verifySppTestnetWasmAvailability() {
  return Object.fromEntries(await Promise.all(
    (Object.keys(SPP_ARTIFACTS) as SppArtifactId[]).map(async (artifactId) => [
      artifactId,
      await verifyTestnetWasm(artifactId),
    ]),
  ));
}

function requiredContract(contracts: SppContractIds, key: keyof SppContractIds): string {
  const value = contracts[key];
  if (!value || !StrKey.isValidContract(value)) {
    throw new Error(`Deployment step requires a valid ${key} contract ID.`);
  }
  return value;
}

function constructorArgs(
  step: SppDeploymentStep,
  wasm: Uint8Array,
  address: string,
  contracts: SppContractIds,
) {
  const spec = contract.Spec.fromWasm(wasm);
  switch (step.id) {
    case "create-asp-membership":
      return spec.funcArgsToScVals("__constructor", {
        admin: address,
        levels: SPP_DEPLOYMENT_CONFIG.aspLevels,
      });
    case "create-asp-non-membership":
      return spec.funcArgsToScVals("__constructor", { admin: address });
    case "create-pool":
      return spec.funcArgsToScVals("__constructor", {
        admin: address,
        asp_membership: requiredContract(contracts, "aspMembership"),
        asp_non_membership: requiredContract(contracts, "aspNonMembership"),
        levels: SPP_DEPLOYMENT_CONFIG.poolLevels,
        maximum_deposit_amount: BigInt(SPP_DEPLOYMENT_CONFIG.maximumDepositAmount),
        policy_flags: SPP_DEPLOYMENT_CONFIG.policyFlags,
        token: SPP_USDC_ASSET.sacContractId,
        verifier: requiredContract(contracts, "verifier"),
      });
    case "create-public-key-registry":
    case "create-verifier":
      return [];
    default:
      throw new Error(`Step ${step.id} does not create a contract.`);
  }
}

function contractKey(step: SppDeploymentStep): keyof SppContractIds {
  return step.artifactId;
}

function assertCreateDependencies(step: SppDeploymentStep, contracts: SppContractIds): void {
  if (step.id === "create-pool") {
    requiredContract(contracts, "aspMembership");
    requiredContract(contracts, "aspNonMembership");
    requiredContract(contracts, "verifier");
  }
  const key = contractKey(step);
  if (contracts[key]) throw new Error(`${key} is already recorded for this deployment.`);
}

function summaryFor(step: SppDeploymentStep, expectedContractId?: string): string {
  if (step.kind === "upload") {
    return `${step.label}. No token operation or contract invocation is present.`;
  }
  return `${step.label}${expectedContractId ? ` as ${expectedContractId}` : ""}. Constructor writes configuration only; no token transfer is present.`;
}

function safetyFor(step: SppDeploymentStep): PreparedSppDeploymentStep["safety"] {
  return {
    assetMovement: false,
    hostFunction: step.kind === "upload" ? "uploadContractWasm" : "createContractV2",
    operationCount: 1,
  };
}

function assertSafeTransaction(
  transaction: ReturnType<TransactionBuilder["build"]>,
  step: SppDeploymentStep,
  address: string,
): void {
  if (transaction.source !== address) throw new Error("Prepared transaction source does not match Freighter.");
  if (transaction.operations.length !== 1) throw new Error("Deployment transaction must contain exactly one operation.");
  const operation = transaction.operations[0];
  if (!operation || operation.type !== "invokeHostFunction") {
    throw new Error("Deployment transaction contains a non-contract operation.");
  }
  const expected = step.kind === "upload" ? "hostFunctionTypeUploadContractWasm" : "hostFunctionTypeCreateContractV2";
  if (operation.func.type !== expected) {
    throw new Error(`Deployment transaction contains unexpected host function ${operation.func.type}.`);
  }
}

export interface PrepareSppDeploymentInput {
  address: string;
  contracts?: SppContractIds;
  stepId: string;
}

export async function prepareSppDeploymentStep(
  input: PrepareSppDeploymentInput,
): Promise<PreparedSppDeploymentStep> {
  if (!StrKey.isValidEd25519PublicKey(input.address)) throw new Error("A valid Freighter G-address is required.");
  const step = deploymentStep(input.stepId);
  const contracts = input.contracts ?? {};
  const [wasm, account, assetVerification] = await Promise.all([
    readVerifiedArtifact(step.artifactId),
    server.getAccount(input.address),
    verifySppUsdcAsset(),
    ...(step.kind === "create" ? [verifyTestnetWasm(step.artifactId)] : []),
  ]);

  let operation;
  if (step.kind === "upload") {
    operation = Operation.uploadContractWasm({ wasm });
  } else {
    assertCreateDependencies(step, contracts);
    operation = Operation.createCustomContract({
      address: new Address(input.address),
      constructorArgs: constructorArgs(step, wasm, input.address, contracts),
      wasmHash: Buffer.from(SPP_ARTIFACTS[step.artifactId].sha256, "hex"),
    });
  }

  const rawTransaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(operation)
    .setTimeout(TRANSACTION_TIMEOUT_SECONDS)
    .build();
  assertSafeTransaction(rawTransaction, step, input.address);

  const simulation = await server.simulateTransaction(rawTransaction);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Testnet simulation rejected ${step.id}: ${simulation.error}`);
  }
  if (!rpc.Api.isSimulationSuccess(simulation)) {
    throw new Error(`Testnet simulation did not complete for ${step.id}.`);
  }
  if (!simulation.result) throw new Error(`Testnet simulation returned no host-function result for ${step.id}.`);

  const prepared = rpc.assembleTransaction(rawTransaction, simulation).build();
  assertSafeTransaction(prepared, step, input.address);
  const transactionXdr = prepared.toXDR();
  const transactionData = simulation.transactionData.build();
  const resources = transactionData.resources;
  const expectedContractId = step.kind === "create"
    ? Address.fromScVal(simulation.result.retval).toString()
    : undefined;

  return {
    assetVerification,
    ...(expectedContractId ? { expectedContractId } : {}),
    expectedWasmHash: SPP_ARTIFACTS[step.artifactId].sha256,
    expiresAt: Number(prepared.timeBounds?.maxTime ?? 0),
    resource: {
      diskReadBytes: resources.diskReadBytes,
      envelopeBytes: Buffer.from(transactionXdr, "base64").byteLength,
      footprintReadOnlyEntries: resources.footprint.readOnly.length,
      footprintReadWriteEntries: resources.footprint.readWrite.length,
      inclusionFeeStroops: BASE_FEE,
      instructions: resources.instructions,
      latestLedger: simulation.latestLedger,
      minResourceFeeStroops: simulation.minResourceFee,
      totalFeeStroops: prepared.fee,
      writeBytes: resources.writeBytes,
    },
    safety: safetyFor(step),
    stepId: step.id,
    summary: summaryFor(step, expectedContractId),
    transactionXdr,
  };
}

export function getDeploymentStep(stepId: SppDeploymentStepId): SppDeploymentStep {
  return deploymentStep(stepId);
}

export async function readPoolConfiguration(contractId: string) {
  if (!StrKey.isValidContract(contractId)) throw new Error("A valid pool contract ID is required.");
  const pool = new Contract(contractId);
  const account = await server.getAccount(SPP_USDC_ASSET.issuer);
  const methods = ["get_root", "get_policy_flags", "get_asp_membership_root", "get_asp_non_membership_root"] as const;
  const results = await Promise.all(methods.map(async (method) => {
    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(pool.call(method))
      .setTimeout(TRANSACTION_TIMEOUT_SECONDS)
      .build();
    const simulation = await server.simulateTransaction(transaction);
    if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
      throw new Error(`Pool read simulation failed for ${method}.`);
    }
    return { method, value: simulation.result.retval.toXDR("base64") };
  }));
  return results;
}

function validateCompletedSteps(results: CompletedSppDeploymentStep[]): void {
  if (results.length > SPP_DEPLOYMENT_STEPS.length) throw new Error("Deployment progress has too many steps.");
  results.forEach((result, index) => {
    const expectedStep = SPP_DEPLOYMENT_STEPS[index];
    if (!expectedStep || result.stepId !== expectedStep.id) throw new Error("Deployment progress is out of order.");
    if (result.wasmHash !== SPP_ARTIFACTS[expectedStep.artifactId].sha256) {
      throw new Error(`Deployment progress has the wrong WASM hash for ${result.stepId}.`);
    }
    if (!/^[0-9a-f]{64}$/i.test(result.transactionHash)) throw new Error("Deployment progress has an invalid transaction hash.");
    if (!Number.isSafeInteger(result.ledger) || result.ledger <= 0) throw new Error("Deployment progress has an invalid ledger.");
    if (expectedStep.kind === "create") {
      if (!result.contractId || !StrKey.isValidContract(result.contractId)) {
        throw new Error(`Deployment progress is missing the contract ID for ${result.stepId}.`);
      }
    } else if (result.contractId) {
      throw new Error(`WASM upload ${result.stepId} must not record a contract ID.`);
    }
  });
}

export async function recordSppDeploymentProgress(address: string, results: CompletedSppDeploymentStep[]) {
  if (!StrKey.isValidEd25519PublicKey(address)) throw new Error("A valid deployer G-address is required.");
  validateCompletedSteps(results);
  const [assetVerification, testnetWasm] = await Promise.all([
    verifySppUsdcAsset(),
    verifySppTestnetWasmAvailability(),
  ]);
  const poolUpload = results.find((result) => result.stepId === "upload-pool");
  const record = {
    schemaVersion: 1,
    status: results.length === SPP_DEPLOYMENT_STEPS.length ? "complete" : "in_progress",
    recordedAt: new Date().toISOString(),
    network: "testnet",
    networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
    deployer: address,
    admin: address,
    source: {
      repository: "NethermindEth/stellar-private-payments",
      revision: SPP_SOURCE_REVISION,
    },
    asset: SPP_USDC_ASSET,
    assetVerification,
    configuration: SPP_DEPLOYMENT_CONFIG,
    artifacts: SPP_ARTIFACTS,
    wasmProvisioning: {
      reusedFromTestnet: SPP_REUSED_TESTNET_WASM,
      uploadedByThisDeployment: {
        artifactId: "pool",
        transactionHash: poolUpload?.transactionHash,
      },
      verifiedOnTestnet: testnetWasm,
    },
    contracts: contractsFromCompletedSteps(results),
    transactions: results,
  };
  await mkdir(LOCAL_DEPLOYMENT_DIRECTORY, { recursive: true });
  const temporaryFile = `${LOCAL_DEPLOYMENT_FILE}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryFile, LOCAL_DEPLOYMENT_FILE);
  return { path: "deployments/local/spp-usdc-testnet-progress.json", status: record.status };
}

function contractsFromCompletedSteps(results: CompletedSppDeploymentStep[]): SppContractIds {
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
