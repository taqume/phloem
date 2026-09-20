import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";

const root = resolve(import.meta.dirname, "../..");
const rpcUrl = "https://soroban-testnet.stellar.org";
const identityAlias = "phloem-testnet-wasm-uploader";
const uploader = "GA5GAXIGEEQTRI4Y67DTX5D44MO5C6F4NMEBPMK5ER4WQXOO2XYICFCI";
const sourceRevision = "2d7fc18ff7c48be3608ccdb8a33d2eaaeb21fc22";
const evidencePath = resolve(root, "evidence/testnet/p0-finalization-wasm-uploads.json");
const totalPreflightFeeStroops = 145_875_407n;
const toleranceBasisPoints = 100n;

const artifacts = [
  {
    id: "auditTotalSpendLeqVerifierV1",
    label: "AuditTotalSpendLeqVerifier V1",
    path: "target/wasm32v1-none/release/phloem_audit_total_spend_leq_verifier.wasm",
    preflightFeeStroops: 15_598_833n,
    sha256: "415805bd7213128dc84cd21225888786781444655492462fb1544c2366d460e4",
    size: 6_238,
  },
  {
    id: "treasuryControllerV2",
    label: "TreasuryController V2",
    path: "target/wasm32v1-none/release/phloem_treasury_controller.wasm",
    preflightFeeStroops: 130_276_574n,
    sha256: "a77bf56561530bf8fbc9894dcd80869b9e257d2fb296b61e10b7225b1bf32a70",
    size: 79_627,
  },
];

function feeGuardrail(value) {
  return (value * (10_000n + toleranceBasisPoints) + 9_999n) / 10_000n;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertContractSourcesClean() {
  const status = execFileSync(
    "git",
    ["status", "--short", "--", "contracts", "crates", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml"],
    { cwd: root, encoding: "utf8" },
  ).trim();
  if (status) throw new Error("Contract inputs have uncommitted changes; refusing to sign deployment provenance.");
}

function assertUploadOnly(transaction, artifact, wasm) {
  if (!(transaction instanceof Transaction)) throw new Error("Expected a classic transaction envelope.");
  if (transaction.source !== uploader) throw new Error("Transaction source is not the dedicated uploader.");
  if (transaction.operations.length !== 1) throw new Error("Expected exactly one operation.");
  const operation = transaction.operations[0];
  if (!operation
    || operation.type !== "invokeHostFunction"
    || operation.func.type !== "hostFunctionTypeUploadContractWasm"
    || operation.auth.length !== 0
    || operation.func.wasm.byteLength !== wasm.byteLength
    || sha256(operation.func.wasm) !== artifact.sha256) {
    throw new Error(`${artifact.label} envelope is not the pinned uploadContractWasm operation.`);
  }
  if (BigInt(transaction.fee) > feeGuardrail(artifact.preflightFeeStroops)) {
    throw new Error(`${artifact.label} fee exceeds its approved 1% preflight guardrail.`);
  }
}

function signWithSecureStore(transactionXdr) {
  const signedXdr = execFileSync(
    "stellar",
    ["tx", "sign", "--quiet", "--sign-with-key", identityAlias, "--network", "testnet"],
    {
      cwd: root,
      encoding: "utf8",
      input: `${transactionXdr}\n`,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["pipe", "pipe", "inherit"],
    },
  ).trim();
  if (!signedXdr) throw new Error("Stellar CLI returned no signed transaction.");
  return signedXdr;
}

async function writeEvidence(evidence) {
  await mkdir(resolve(root, "evidence/testnet"), { recursive: true });
  const temporaryPath = `${evidencePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, evidencePath);
}

assertContractSourcesClean();
const execute = process.argv.includes("--execute");
const cliAddress = execFileSync("stellar", ["keys", "public-key", identityAlias], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (cliAddress !== uploader) throw new Error("Secure-store identity does not match the approved uploader address.");

const server = new rpc.Server(rpcUrl);
const results = [];
let projectedFeeStroops = 0n;

for (const artifact of artifacts) {
  const wasm = await readFile(resolve(root, artifact.path));
  if (wasm.byteLength !== artifact.size || sha256(wasm) !== artifact.sha256) {
    throw new Error(`${artifact.label} differs from the approved artifact.`);
  }

  try {
    const existing = await server.getContractWasmByHash(Buffer.from(artifact.sha256, "hex"));
    if (existing.byteLength !== wasm.byteLength || sha256(existing) !== artifact.sha256) {
      throw new Error(`${artifact.label} network bytes do not match the pinned hash.`);
    }
    results.push({
      artifactId: artifact.id,
      artifact: { bytes: wasm.byteLength, path: artifact.path, sha256: artifact.sha256 },
      status: "already_present",
      verification: { networkWasmBytes: existing.byteLength, networkWasmHash: artifact.sha256 },
    });
    continue;
  } catch (reason) {
    if (reason instanceof Error && reason.message.includes("network bytes do not match")) throw reason;
  }

  const account = await server.getAccount(uploader);
  const raw = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.uploadContractWasm({ wasm }))
    .setTimeout(300)
    .build();
  const simulation = await server.simulateTransaction(raw);
  if (rpc.Api.isSimulationError(simulation)) throw new Error(`${artifact.label} simulation failed: ${simulation.error}`);
  if (!rpc.Api.isSimulationSuccess(simulation)) throw new Error(`${artifact.label} simulation did not complete.`);
  const prepared = rpc.assembleTransaction(raw, simulation).build();
  assertUploadOnly(prepared, artifact, wasm);
  projectedFeeStroops += BigInt(prepared.fee);
  if (projectedFeeStroops > feeGuardrail(totalPreflightFeeStroops)) {
    throw new Error("Projected cumulative fee exceeds the approved 1% total guardrail.");
  }
  const resources = simulation.transactionData.build().resources;
  const record = {
    artifactId: artifact.id,
    artifact: { bytes: wasm.byteLength, path: artifact.path, sha256: artifact.sha256 },
    preflight: {
      approvedArtifactGuardrailStroops: feeGuardrail(artifact.preflightFeeStroops).toString(),
      approvedArtifactPreflightStroops: artifact.preflightFeeStroops.toString(),
      envelopeBytes: Buffer.from(prepared.toXDR(), "base64").byteLength,
      instructions: resources.instructions,
      latestLedger: simulation.latestLedger,
      maximumFeeStroops: prepared.fee,
      transactionHash: Buffer.from(prepared.hash()).toString("hex"),
      writeBytes: resources.writeBytes,
    },
    safety: {
      allowance: false,
      assetMovement: false,
      contractInitialization: false,
      contractInvocation: false,
      hostFunction: "uploadContractWasm",
      operationCount: 1,
    },
    status: execute ? "approved_for_execution" : "simulation_only",
  };
  if (!execute) {
    results.push(record);
    continue;
  }

  const signedXdr = signWithSecureStore(prepared.toXDR());
  const signed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
  assertUploadOnly(signed, artifact, wasm);
  if (signed.signatures.length !== 1) throw new Error(`${artifact.label} must have exactly one uploader signature.`);
  const signature = signed.signatures[0]?.signature.value;
  if (!signature || !Keypair.fromPublicKey(uploader).verify(signed.hash(), signature)) {
    throw new Error(`${artifact.label} secure-store signature verification failed.`);
  }
  const submitted = await server.sendTransaction(signed);
  if (submitted.status === "ERROR") throw new Error(`Testnet rejected ${artifact.label}.`);
  if (submitted.status === "TRY_AGAIN_LATER") throw new Error(`Testnet asked ${artifact.label} to retry later.`);
  const final = await server.pollTransaction(submitted.hash, { attempts: 60 });
  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`${artifact.label} upload ended with ${final.status}.`);
  }
  const uploaded = await server.getContractWasmByHash(Buffer.from(artifact.sha256, "hex"));
  if (uploaded.byteLength !== wasm.byteLength || sha256(uploaded) !== artifact.sha256) {
    throw new Error(`${artifact.label} post-submit WASM verification failed.`);
  }
  results.push({
    ...record,
    status: "success",
    transaction: {
      feeChargedStroops: final.resultXdr.feeCharged.toString(),
      hash: submitted.hash,
      ledger: final.ledger,
      maximumFeeStroops: prepared.fee,
    },
    verification: {
      networkWasmBytes: uploaded.byteLength,
      networkWasmHash: artifact.sha256,
      transactionStatus: "SUCCESS",
    },
  });
}

const evidence = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  sourceRevision,
  network: "testnet",
  networkPassphrase: Networks.TESTNET,
  rpcUrl,
  uploader: {
    address: uploader,
    authority: "none: code upload only; not a Phloem financial or contract-instance authority",
    identityAlias,
    secretStorage: "macOS Keychain via Stellar CLI secure store",
  },
  approval: {
    scope: "two uploadContractWasm operations only",
    approvedTotalPreflightStroops: totalPreflightFeeStroops.toString(),
    approvedTotalGuardrailStroops: feeGuardrail(totalPreflightFeeStroops).toString(),
  },
  execution: execute ? "submitted" : "simulation_only",
  projectedFeeStroops: projectedFeeStroops.toString(),
  results,
};

if (execute) await writeEvidence(evidence);
console.log(JSON.stringify(evidence, null, 2));
