import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  BASE_FEE,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";

const root = resolve(import.meta.dirname, "../..");
const evidencePath = resolve(root, "evidence/testnet/p0-finalization-deployment-preflight.json");
const rpcUrl = "https://soroban-testnet.stellar.org";
const uploader = "GA5GAXIGEEQTRI4Y67DTX5D44MO5C6F4NMEBPMK5ER4WQXOO2XYICFCI";
const sourceRevision = "2d7fc18ff7c48be3608ccdb8a33d2eaaeb21fc22";

const artifacts = [
  {
    id: "auditTotalSpendLeqVerifierV1",
    path: "target/wasm32v1-none/release/phloem_audit_total_spend_leq_verifier.wasm",
    sha256: "415805bd7213128dc84cd21225888786781444655492462fb1544c2366d460e4",
    verificationKeyPath: ".phloem/audit-total-spend-leq-setup/verification_key.json",
  },
  {
    id: "treasuryControllerV2",
    path: "target/wasm32v1-none/release/phloem_treasury_controller.wasm",
    sha256: "a77bf56561530bf8fbc9894dcd80869b9e257d2fb296b61e10b7225b1bf32a70",
  },
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertContractSourcesClean() {
  const status = execFileSync(
    "git",
    ["status", "--short", "--", "contracts", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml"],
    { cwd: root, encoding: "utf8" },
  ).trim();
  if (status) throw new Error("Contract inputs have uncommitted changes; refusing to simulate deployment provenance.");
}

function resourceSnapshot(simulation, transaction) {
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

assertContractSourcesClean();
const server = new rpc.Server(rpcUrl);
const account = await server.getAccount(uploader);
const prepared = [];

for (const artifact of artifacts) {
  const path = resolve(root, artifact.path);
  const wasm = await readFile(path);
  if (sha256(wasm) !== artifact.sha256) {
    throw new Error(`${artifact.id} differs from the reviewed finalization artifact.`);
  }
  let alreadyPresent = false;
  try {
    const networkWasm = await server.getContractWasmByHash(Buffer.from(artifact.sha256, "hex"));
    if (sha256(networkWasm) !== artifact.sha256) throw new Error(`${artifact.id} network hash mismatch.`);
    alreadyPresent = true;
  } catch (reason) {
    if (reason instanceof Error && reason.message.includes("network hash mismatch")) throw reason;
  }
  if (alreadyPresent) {
    prepared.push({
      artifactId: artifact.id,
      bytes: wasm.byteLength,
      status: "reuse-existing-testnet-code",
      wasmSha256: artifact.sha256,
      ...(artifact.verificationKeyPath ? {
        verificationKey: {
          path: artifact.verificationKeyPath,
          sha256: sha256(await readFile(resolve(root, artifact.verificationKeyPath))),
        },
      } : {}),
    });
    continue;
  }

  const raw = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.uploadContractWasm({ wasm }))
    .setTimeout(300)
    .build();
  const simulation = await server.simulateTransaction(raw);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`${artifact.id} upload simulation failed: ${simulation.error}`);
  }
  if (!rpc.Api.isSimulationSuccess(simulation)) {
    throw new Error(`${artifact.id} upload simulation did not complete.`);
  }
  const transaction = rpc.assembleTransaction(raw, simulation).build();
  const operation = transaction.operations[0];
  if (transaction.operations.length !== 1
    || !operation
    || operation.type !== "invokeHostFunction"
    || operation.func.type !== "hostFunctionTypeUploadContractWasm"
    || sha256(operation.func.wasm) !== artifact.sha256) {
    throw new Error(`${artifact.id} simulation produced a non-canonical upload envelope.`);
  }
  prepared.push({
    artifactId: artifact.id,
    bytes: wasm.byteLength,
    resource: resourceSnapshot(simulation, transaction),
    safety: {
      assetMovement: false,
      contractInvocation: false,
      hostFunction: "uploadContractWasm",
      operationCount: 1,
      signed: false,
      submitted: false,
    },
    status: "simulation-only",
    transactionHash: Buffer.from(transaction.hash()).toString("hex"),
    wasmSha256: artifact.sha256,
    ...(artifact.verificationKeyPath ? {
      verificationKey: {
        path: artifact.verificationKeyPath,
        sha256: sha256(await readFile(resolve(root, artifact.verificationKeyPath))),
      },
    } : {}),
  });
}

const pending = prepared.filter((item) => item.status === "simulation-only");
const totalFeeStroops = pending.reduce((sum, item) => sum + BigInt(item.resource.totalFeeStroops), 0n);
const evidence = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  sourceRevision,
  network: "testnet",
  networkPassphrase: Networks.TESTNET,
  rpcUrl,
  uploader,
  scope: {
    purpose: "P0 lifecycle plus final TOTAL_SPEND_LEQ deployment",
    assetMovement: false,
    allowance: false,
    contractInvocation: false,
    instanceCreation: false,
    signed: false,
    submitted: false,
  },
  artifacts: prepared,
  resources: {
    pendingUploadCount: pending.length,
    totalFeeStroops: totalFeeStroops.toString(),
    totalFeeXlm: (Number(totalFeeStroops) / 10_000_000).toFixed(7),
    totalInstructions: pending.reduce((sum, item) => sum + item.resource.instructions, 0),
    totalWriteBytes: pending.reduce((sum, item) => sum + item.resource.writeBytes, 0),
  },
  nextGate: "explicit user approval before either upload is signed or submitted",
};

await mkdir(dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify(evidence, null, 2));
