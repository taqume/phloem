import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  BASE_FEE,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const DEPLOYMENT_PATH = resolve(REPO_ROOT, "deployments", "testnet.json");
const EVIDENCE_PATH = resolve(REPO_ROOT, "evidence", "testnet", "phloem-deployment-preflight.json");
const RPC_URL = "https://soroban-testnet.stellar.org";
const BUILD_COMMAND = "pnpm contracts:build";
const CONTRACT_SOURCE_REVISION = "164d0ed224b2cacedcc9afb9252dff0705fa4ec2";

const ARTIFACTS = [
  {
    id: "ed25519Verifier",
    path: "target/wasm32v1-none/release/phloem_ed25519_verifier.wasm",
    sha256: "aa15e1a91fd5d41a755b5321f97bb4290e0db4595dd4408e2e89f16d4d066600",
  },
  {
    id: "budgetTransitionVerifierV1",
    path: "target/wasm32v1-none/release/phloem_budget_transition_verifier.wasm",
    sha256: "0e068ff97a66fb5056c7249444e2b31762dc1ae9031a725d7f5ae8f1676ddb0d",
    verificationKey: {
      path: ".phloem/budget-transition-setup/verification_key.json",
      sha256: "52d999f482d0309fe332ff042250385419568d2d4d07e97e775439938955d772",
    },
  },
  {
    id: "privateRootBackingVerifierV1",
    path: "target/wasm32v1-none/release/phloem_private_root_backing_verifier.wasm",
    sha256: "779d500e9afcf7d07eac315ae41ecc4e23df581dfceec2fd5a7668d45a270005",
    verificationKey: {
      path: ".phloem/private-root-backing-setup/verification_key.json",
      sha256: "36cd9762d1ffcdd5d32c35f11d31e707a03fc1738a6432439a576923e590fb8c",
    },
  },
  {
    id: "privateSettlementBindingVerifierV1",
    path: "target/wasm32v1-none/release/phloem_private_settlement_binding_verifier.wasm",
    sha256: "058079beb6e94dec7bfc594c3a2f21554af82d4bdd62a8fa70689d8ba0c72029",
    verificationKey: {
      path: ".phloem/private-binding-setup/verification_key.json",
      sha256: "c727f8b2656231bd50cb0139bde6e998e4f922766f2d351d76ddb88e322c485d",
    },
  },
  {
    id: "agentAccount",
    path: "target/wasm32v1-none/release/phloem_agent_account.wasm",
    sha256: "0a9d54d3bf278131cf2239e1db52eee54f057d4e3241a6aafc2b28bca22d156d",
  },
  {
    id: "treasuryController",
    path: "target/wasm32v1-none/release/phloem_treasury_controller.wasm",
    sha256: "c4607977b54c68d3344fdfeee669ee9a15a6fda81ee0e98357020b2ad7dd0f44",
  },
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function verifiedFile(entry) {
  const bytes = await readFile(resolve(REPO_ROOT, entry.path));
  const digest = sha256(bytes);
  if (digest !== entry.sha256) {
    throw new Error(`${entry.path} hash mismatch; run ${BUILD_COMMAND} and review the contract diff.`);
  }
  return { bytes, bytesLength: bytes.byteLength, sha256: digest };
}

function assertContractSourcesClean() {
  const status = execFileSync(
    "git",
    ["status", "--short", "--", "contracts", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  ).trim();
  if (status) throw new Error("Contract inputs have uncommitted changes; refusing to record deployment provenance.");
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

function sumBigInt(records, key) {
  return records.reduce((total, record) => total + BigInt(record.resource[key]), 0n).toString();
}

assertContractSourcesClean();

const deployment = JSON.parse(await readFile(DEPLOYMENT_PATH, "utf8"));
const deployer = deployment.deployer;
if (!StrKey.isValidEd25519PublicKey(deployer)) throw new Error("Deployment manifest has no valid deployer G-address.");
if (deployment.networkPassphrase !== Networks.TESTNET) throw new Error("Deployment manifest is not bound to Testnet.");
if (!StrKey.isValidContract(deployment.spp?.contracts?.pool)) throw new Error("Deployment manifest has no valid SPP pool.");
if (!StrKey.isValidContract(deployment.spp?.asset?.sacContractId)) throw new Error("Deployment manifest has no valid USDC SAC.");

const server = new rpc.Server(RPC_URL);
const account = await server.getAccount(deployer);
const simulations = [];

for (const artifact of ARTIFACTS) {
  const wasm = await verifiedFile(artifact);
  if (artifact.verificationKey) await verifiedFile(artifact.verificationKey);

  let alreadyPresent = false;
  try {
    const deployedWasm = await server.getContractWasmByHash(Buffer.from(artifact.sha256, "hex"));
    if (sha256(deployedWasm) !== artifact.sha256) throw new Error(`Testnet returned wrong WASM for ${artifact.id}.`);
    alreadyPresent = true;
  } catch (reason) {
    if (reason instanceof Error && reason.message.includes("wrong WASM")) throw reason;
  }

  if (alreadyPresent) {
    simulations.push({
      artifactId: artifact.id,
      artifactBytes: wasm.bytesLength,
      safety: { assetMovement: false, hostFunction: "none", reason: "WASM already present on Testnet" },
      status: "reuse-existing-testnet-code",
      wasmSha256: artifact.sha256,
      ...(artifact.verificationKey ? { verificationKey: artifact.verificationKey } : {}),
    });
    continue;
  }

  const raw = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.uploadContractWasm({ wasm: wasm.bytes }))
    .setTimeout(300)
    .build();
  const simulation = await server.simulateTransaction(raw);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Testnet rejected ${artifact.id} upload simulation: ${simulation.error}`);
  }
  if (!rpc.Api.isSimulationSuccess(simulation)) {
    throw new Error(`Testnet did not complete ${artifact.id} upload simulation.`);
  }
  const prepared = rpc.assembleTransaction(raw, simulation).build();
  if (prepared.operations.length !== 1 || prepared.operations[0]?.type !== "invokeHostFunction") {
    throw new Error(`${artifact.id} simulation produced an unexpected operation set.`);
  }
  if (prepared.operations[0].func.type !== "hostFunctionTypeUploadContractWasm") {
    throw new Error(`${artifact.id} simulation is not a WASM upload.`);
  }

  simulations.push({
    artifactId: artifact.id,
    artifactBytes: wasm.bytesLength,
    resource: resourceSnapshot(simulation, prepared),
    safety: { assetMovement: false, hostFunction: "uploadContractWasm", operationCount: 1 },
    status: "simulation-only",
    wasmSha256: artifact.sha256,
    ...(artifact.verificationKey ? { verificationKey: artifact.verificationKey } : {}),
  });
}

const pending = simulations.filter((record) => record.status === "simulation-only");
const evidence = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  network: "testnet",
  networkPassphrase: Networks.TESTNET,
  rpcUrl: RPC_URL,
  deployer,
  sourceRevision: CONTRACT_SOURCE_REVISION,
  build: {
    command: BUILD_COMMAND,
    rustToolchain: "1.95.0",
    sorobanSdk: "28.0.0",
  },
  pinnedDependencies: {
    standardAsset: deployment.spp.asset,
    sppPool: deployment.spp.contracts.pool,
    sppSourceRevision: deployment.spp.sourceRevision,
  },
  scope: {
    auditAccumulatorVerifier: "excluded: reusable test primitive; not a canonical STANDARD or PRIVATE settlement dependency",
    assetMovement: false,
    constructorTransactions: "deferred until referenced WASM hashes exist on Testnet",
    signed: false,
    submitted: false,
  },
  artifacts: simulations,
  resources: {
    pendingUploadCount: pending.length,
    totalFeeStroops: sumBigInt(pending, "totalFeeStroops"),
    totalFeeXlm: (Number(sumBigInt(pending, "totalFeeStroops")) / 10_000_000).toFixed(7),
    totalInstructions: pending.reduce((total, record) => total + record.resource.instructions, 0),
    totalWriteBytes: pending.reduce((total, record) => total + record.resource.writeBytes, 0),
  },
};

await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify(evidence, null, 2));
