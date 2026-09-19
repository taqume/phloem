import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { BASE_FEE, Networks, Operation, StrKey, Transaction, TransactionBuilder, rpc } from "@stellar/stellar-sdk";

import { PHLOEM_NETWORK } from "../network";
import {
  PHLOEM_ARTIFACTS,
  PHLOEM_DEPLOYER,
  PHLOEM_UPLOAD_FEE_LIMIT_STROOPS,
  PHLOEM_UPLOAD_STEPS,
  feeGuardrailStroops,
  type CompletedPhloemUpload,
  type PhloemArtifactId,
  type PhloemUploadResourceSnapshot,
  type PreparedPhloemUpload,
} from "../phloem-deployment-types";

const REPO_ROOT = existsSync(resolve(process.cwd(), "pnpm-workspace.yaml"))
  ? process.cwd()
  : resolve(process.cwd(), "..", "..");
const WASM_DIRECTORY = resolve(REPO_ROOT, "target", "wasm32v1-none", "release");
const LOCAL_DEPLOYMENT_DIRECTORY = resolve(REPO_ROOT, "deployments", "local");
const LOCAL_UPLOAD_FILE = resolve(LOCAL_DEPLOYMENT_DIRECTORY, "phloem-testnet-upload-progress.json");
const TRANSACTION_TIMEOUT_SECONDS = 300;

const server = new rpc.Server(PHLOEM_NETWORK.rpcUrl);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function uploadStep(stepId: string) {
  const step = PHLOEM_UPLOAD_STEPS.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error("Unknown Phloem WASM upload step.");
  return step;
}

function validateCompletedUploads(results: CompletedPhloemUpload[]): void {
  if (results.length > PHLOEM_UPLOAD_STEPS.length) throw new Error("Upload progress has too many steps.");
  let totalFee = 0n;
  results.forEach((result, index) => {
    const expected = PHLOEM_UPLOAD_STEPS[index];
    if (!expected || expected.id !== result.stepId || expected.artifactId !== result.artifactId) {
      throw new Error("Upload progress is out of order.");
    }
    const artifact = PHLOEM_ARTIFACTS[expected.artifactId];
    if (result.wasmHash !== artifact.sha256) throw new Error(`Upload progress has the wrong hash for ${result.stepId}.`);
    if (!/^[0-9a-f]{64}$/i.test(result.transactionHash)) throw new Error("Upload progress has an invalid transaction hash.");
    if (!Number.isSafeInteger(result.ledger) || result.ledger <= 0) throw new Error("Upload progress has an invalid ledger.");
    if (BigInt(result.resource.totalFeeStroops) > BigInt(feeGuardrailStroops(artifact.maxFeeStroops))) {
      throw new Error(`${result.stepId} exceeds its approved preflight fee.`);
    }
    totalFee += BigInt(result.resource.totalFeeStroops);
  });
  if (totalFee > BigInt(feeGuardrailStroops(PHLOEM_UPLOAD_FEE_LIMIT_STROOPS))) {
    throw new Error("Upload progress exceeds the approved total fee limit.");
  }
}

async function readVerifiedArtifact(artifactId: PhloemArtifactId): Promise<Uint8Array> {
  const artifact = PHLOEM_ARTIFACTS[artifactId];
  const bytes = await readFile(resolve(WASM_DIRECTORY, artifact.fileName));
  if (bytes.byteLength !== artifact.size || sha256(bytes) !== artifact.sha256) {
    throw new Error(`${artifact.fileName} differs from the approved preflight artifact.`);
  }
  return bytes;
}

async function verifyCompletedUpload(result: CompletedPhloemUpload): Promise<void> {
  const [bytes, transaction] = await Promise.all([
    server.getContractWasmByHash(Buffer.from(result.wasmHash, "hex")),
    server.getTransaction(result.transactionHash),
  ]);
  if (sha256(bytes) !== result.wasmHash) throw new Error(`Testnet WASM verification failed for ${result.artifactId}.`);
  if (transaction.status !== rpc.Api.GetTransactionStatus.SUCCESS || transaction.ledger !== result.ledger) {
    throw new Error(`Testnet transaction verification failed for ${result.artifactId}.`);
  }
  const parsed = TransactionBuilder.fromXDR(transaction.envelopeXdr, Networks.TESTNET);
  if (!(parsed instanceof Transaction) || parsed.source !== PHLOEM_DEPLOYER) {
    throw new Error(`Upload transaction source verification failed for ${result.artifactId}.`);
  }
  const operation = parsed.operations[0];
  if (
    parsed.operations.length !== 1
    || !operation
    || operation.type !== "invokeHostFunction"
    || operation.func.type !== "hostFunctionTypeUploadContractWasm"
    || sha256(operation.func.wasm) !== result.wasmHash
  ) {
    throw new Error(`Upload transaction contents verification failed for ${result.artifactId}.`);
  }
}

function assertUploadOnly(transaction: ReturnType<TransactionBuilder["build"]>, address: string): void {
  if (transaction.source !== address) throw new Error("Prepared transaction source does not match Freighter.");
  if (transaction.operations.length !== 1) throw new Error("Upload transaction must contain exactly one operation.");
  const operation = transaction.operations[0];
  if (
    !operation
    || operation.type !== "invokeHostFunction"
    || operation.func.type !== "hostFunctionTypeUploadContractWasm"
  ) {
    throw new Error("Prepared transaction contains a non-upload operation.");
  }
}

function resourceSnapshot(
  simulation: rpc.Api.SimulateTransactionSuccessResponse,
  transaction: ReturnType<TransactionBuilder["build"]>,
): PhloemUploadResourceSnapshot {
  const resources = simulation.transactionData.build().resources;
  return {
    diskReadBytes: resources.diskReadBytes,
    envelopeBytes: Buffer.from(transaction.toXDR(), "base64").byteLength,
    footprintReadOnlyEntries: resources.footprint.readOnly.length,
    footprintReadWriteEntries: resources.footprint.readWrite.length,
    inclusionFeeStroops: BASE_FEE,
    instructions: resources.instructions,
    latestLedger: simulation.latestLedger,
    minResourceFeeStroops: simulation.minResourceFee,
    totalFeeStroops: transaction.fee,
    writeBytes: resources.writeBytes,
  };
}

export interface PreparePhloemUploadInput {
  address: string;
  completed?: CompletedPhloemUpload[];
  stepId: string;
}

export async function preparePhloemUpload(input: PreparePhloemUploadInput): Promise<PreparedPhloemUpload> {
  if (!StrKey.isValidEd25519PublicKey(input.address)) throw new Error("A valid Freighter G-address is required.");
  if (input.address !== PHLOEM_DEPLOYER) throw new Error("Freighter address does not match the approved Testnet deployer.");
  const step = uploadStep(input.stepId);
  const completed = input.completed ?? [];
  validateCompletedUploads(completed);
  const expectedNext = PHLOEM_UPLOAD_STEPS[completed.length];
  if (!expectedNext || expectedNext.id !== step.id) throw new Error("Upload step is not the next approved operation.");
  await Promise.all(completed.map(verifyCompletedUpload));

  const artifact = PHLOEM_ARTIFACTS[step.artifactId];
  const [wasm, account] = await Promise.all([
    readVerifiedArtifact(step.artifactId),
    server.getAccount(input.address),
  ]);

  try {
    await server.getContractWasmByHash(Buffer.from(artifact.sha256, "hex"));
    throw new Error(`${artifact.label} WASM is already present on Testnet; do not pay to upload it again.`);
  } catch (reason) {
    if (reason instanceof Error && reason.message.includes("already present")) throw reason;
  }

  const rawTransaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.uploadContractWasm({ wasm }))
    .setTimeout(TRANSACTION_TIMEOUT_SECONDS)
    .build();
  assertUploadOnly(rawTransaction, input.address);

  const simulation = await server.simulateTransaction(rawTransaction);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Testnet rejected ${step.id}: ${simulation.error}`);
  }
  if (!rpc.Api.isSimulationSuccess(simulation)) throw new Error(`Testnet did not complete ${step.id} simulation.`);

  const prepared = rpc.assembleTransaction(rawTransaction, simulation).build();
  assertUploadOnly(prepared, input.address);
  const resource = resourceSnapshot(simulation, prepared);
  const priorFee = completed.reduce((sum, result) => sum + BigInt(result.resource.totalFeeStroops), 0n);
  const projectedTotal = priorFee + BigInt(resource.totalFeeStroops);
  const artifactGuardrail = feeGuardrailStroops(artifact.maxFeeStroops);
  const totalGuardrail = feeGuardrailStroops(PHLOEM_UPLOAD_FEE_LIMIT_STROOPS);
  if (BigInt(resource.totalFeeStroops) > BigInt(artifactGuardrail)) {
    throw new Error(`${artifact.label} fee exceeds its approved preflight maximum; transaction was not exposed for signing.`);
  }
  if (projectedTotal > BigInt(totalGuardrail)) {
    throw new Error("Projected upload fees exceed the approved total; transaction was not exposed for signing.");
  }

  return {
    expectedWasmHash: artifact.sha256,
    expiresAt: Number(prepared.timeBounds?.maxTime ?? 0),
    feeLimit: {
      artifactGuardrailStroops: artifactGuardrail,
      artifactPreflightStroops: artifact.maxFeeStroops,
      approvedPreflightStroops: PHLOEM_UPLOAD_FEE_LIMIT_STROOPS,
      approvedTotalGuardrailStroops: totalGuardrail,
      projectedTotalStroops: projectedTotal.toString(),
    },
    resource,
    safety: {
      assetMovement: false,
      contractInvocation: false,
      hostFunction: "uploadContractWasm",
      operationCount: 1,
    },
    stepId: step.id,
    summary: `${step.label}. Exactly one WASM upload; no contract invocation, initialization, allowance, or asset movement.`,
    transactionXdr: prepared.toXDR(),
  };
}

export async function recordPhloemUploadProgress(address: string, results: CompletedPhloemUpload[]) {
  if (address !== PHLOEM_DEPLOYER) throw new Error("Upload evidence does not belong to the approved deployer.");
  validateCompletedUploads(results);
  await Promise.all(results.map(verifyCompletedUpload));

  const record = {
    schemaVersion: 1,
    status: results.length === PHLOEM_UPLOAD_STEPS.length ? "complete" : "in_progress",
    recordedAt: new Date().toISOString(),
    network: "testnet",
    networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
    deployer: address,
    approvedFeeLimitStroops: PHLOEM_UPLOAD_FEE_LIMIT_STROOPS,
    feeDriftGuardrailStroops: feeGuardrailStroops(PHLOEM_UPLOAD_FEE_LIMIT_STROOPS),
    assetMovement: false,
    uploads: results,
  };
  await mkdir(LOCAL_DEPLOYMENT_DIRECTORY, { recursive: true });
  const temporaryFile = `${LOCAL_UPLOAD_FILE}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryFile, LOCAL_UPLOAD_FILE);
  return { path: "deployments/local/phloem-testnet-upload-progress.json", status: record.status };
}
