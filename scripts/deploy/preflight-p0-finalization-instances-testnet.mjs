import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  Address,
  BASE_FEE,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  contract,
  inspectAuthEntry,
  rpc,
} from "@stellar/stellar-sdk";

const root = resolve(import.meta.dirname, "../..");
const evidencePath = resolve(root, "evidence/testnet/p0-finalization-instance-preflight.json");
const rpcUrl = "https://soroban-testnet.stellar.org";
const deployer = "GA5GAXIGEEQTRI4Y67DTX5D44MO5C6F4NMEBPMK5ER4WQXOO2XYICFCI";
const sourceRevision = "2d7fc18ff7c48be3608ccdb8a33d2eaaeb21fc22";
const usdcSac = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const sppPool = "CC57FDSWPIHALXW2XWVSKEA7FA72Z37Y7AP5ASRY6V3CXAZCWQAOSLB4";
const agentAccountWasmHash = "0a9d54d3bf278131cf2239e1db52eee54f057d4e3241a6aafc2b28bca22d156d";
const budgetTransitionVerifier = "CD3GQVHD4R3E4WMFEFB6H5IJJUZXYE3IFFNY65P2J3L2V6R6A6FTJQ4O";
const privateRootBackingVerifier = "CBR7ZUMSLGWHUJBL7YKL2HRTYAWB34CPM5MG5OFYANENMOTCBHH3A5PA";
const privateBindingVerifier = "CA5MLD4MNE2S3TQ3C47PARFSWL3XPXTQS5HQHS7ZDGTKXB7TMVNXVRRW";
const bn254BaseFieldModulus =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

const controllerArtifact = {
  id: "treasuryControllerV2",
  path: "target/wasm32v1-none/release/phloem_treasury_controller.wasm",
  sha256: "a77bf56561530bf8fbc9894dcd80869b9e257d2fb296b61e10b7225b1bf32a70",
};
const auditArtifact = {
  id: "auditTotalSpendLeqVerifierV1",
  path: "target/wasm32v1-none/release/phloem_audit_total_spend_leq_verifier.wasm",
  sha256: "415805bd7213128dc84cd21225888786781444655492462fb1544c2366d460e4",
  verificationKeyPath: ".phloem/audit-total-spend-leq-setup/verification_key.json",
  verificationKeySha256: "2cceaad298a9c90e9f569ed677808f827471f8872c0727988bab9c7720efab19",
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertContractSourcesClean() {
  const status = execFileSync(
    "git",
    ["status", "--short", "--", "contracts", "crates", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml"],
    { cwd: root, encoding: "utf8" },
  ).trim();
  if (status) throw new Error("Contract inputs have uncommitted changes; refusing to simulate instance provenance.");
}

function coordinateBytes(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("Verification key contains a non-decimal BN254 coordinate.");
  }
  const coordinate = BigInt(value);
  if (coordinate < 0n || coordinate >= bn254BaseFieldModulus) {
    throw new Error("Verification key contains a non-canonical BN254 coordinate.");
  }
  return Buffer.from(coordinate.toString(16).padStart(64, "0"), "hex");
}

function g1(point) {
  if (!Array.isArray(point) || point.length !== 3 || point[2] !== "1") {
    throw new Error("Verification key contains a non-affine G1 point.");
  }
  return Buffer.concat([coordinateBytes(point[0]), coordinateBytes(point[1])]);
}

function g2(point) {
  if (!Array.isArray(point)
    || point.length !== 3
    || !Array.isArray(point[0])
    || !Array.isArray(point[1])
    || !Array.isArray(point[2])
    || point[0].length !== 2
    || point[1].length !== 2
    || point[2][0] !== "1"
    || point[2][1] !== "0") {
    throw new Error("Verification key contains a non-affine G2 point.");
  }
  return Buffer.concat([
    coordinateBytes(point[0][1]),
    coordinateBytes(point[0][0]),
    coordinateBytes(point[1][1]),
    coordinateBytes(point[1][0]),
  ]);
}

async function auditVerificationKey() {
  const bytes = await readFile(resolve(root, auditArtifact.verificationKeyPath));
  if (sha256(bytes) !== auditArtifact.verificationKeySha256) {
    throw new Error("AuditTotalSpendLeq verification key differs from the pinned ceremony artifact.");
  }
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (parsed.protocol !== "groth16" || parsed.curve !== "bn128" || parsed.nPublic !== 7
    || !Array.isArray(parsed.IC) || parsed.IC.length !== 8) {
    throw new Error("AuditTotalSpendLeq verification key metadata is invalid.");
  }
  return {
    alpha: g1(parsed.vk_alpha_1),
    beta: g2(parsed.vk_beta_2),
    gamma: g2(parsed.vk_gamma_2),
    delta: g2(parsed.vk_delta_2),
    ic: parsed.IC.map(g1),
  };
}

function deterministicSalt(stepId) {
  return createHash("sha256")
    .update(`PHLOEM_TESTNET_FINALIZATION_V1:${sourceRevision}:${stepId}`, "utf8")
    .digest();
}

function hostFunctionHash(operation) {
  return sha256(operation.func.toXDR());
}

function assertCreateOnly(transaction, expectedHostFunctionHash, prepared) {
  if (!(transaction instanceof Transaction)
    || transaction.source !== deployer
    || transaction.operations.length !== 1) {
    throw new Error("Instance transaction has an unexpected envelope shape.");
  }
  const operation = transaction.operations[0];
  if (!operation
    || operation.type !== "invokeHostFunction"
    || operation.func.type !== "hostFunctionTypeCreateContractV2"
    || hostFunctionHash(operation) !== expectedHostFunctionHash) {
    throw new Error("Instance transaction is not the pinned createContractV2 host function.");
  }
  if (!prepared && operation.auth.length !== 0) {
    throw new Error("Raw instance creation unexpectedly contains Soroban auth.");
  }
  if (prepared) {
    if (operation.auth.length !== 1) throw new Error("Prepared instance creation must have one source auth entry.");
    const auth = inspectAuthEntry(operation.auth[0]);
    if (auth.credentialType !== "sourceAccount"
      || auth.address !== null
      || auth.invocation.function.type !== "sorobanAuthorizedFunctionTypeCreateContractV2HostFn"
      || auth.invocation.subInvocations.length !== 0
      || sha256(auth.invocation.function.value.toXDR()) !== sha256(operation.func.value.toXDR())) {
      throw new Error("Prepared instance creation contains unexpected authorization.");
    }
  }
}

function resourceSnapshot(simulation, transaction) {
  const resources = simulation.transactionData.build().resources;
  return {
    diskReadBytes: resources.diskReadBytes,
    envelopeBytes: Buffer.from(transaction.toXDR(), "base64").byteLength,
    footprintReadOnlyEntries: resources.footprint.readOnly.length,
    footprintReadWriteEntries: resources.footprint.readWrite.length,
    instructions: resources.instructions,
    minResourceFeeStroops: simulation.minResourceFee,
    totalFeeStroops: transaction.fee,
    writeBytes: resources.writeBytes,
  };
}

async function verifiedWasm(artifact) {
  const bytes = await readFile(resolve(root, artifact.path));
  if (sha256(bytes) !== artifact.sha256) throw new Error(`${artifact.id} differs from its pinned WASM.`);
  const network = await server.getContractWasmByHash(Buffer.from(artifact.sha256, "hex"));
  if (network.byteLength !== bytes.byteLength || sha256(network) !== artifact.sha256) {
    throw new Error(`${artifact.id} network WASM verification failed.`);
  }
  return bytes;
}

async function simulateCreate(input) {
  const account = await server.getAccount(deployer);
  const operation = Operation.createCustomContract({
    address: new Address(deployer),
    constructorArgs: input.constructorArgs,
    salt: deterministicSalt(input.stepId),
    wasmHash: Buffer.from(input.artifact.sha256, "hex"),
  });
  const raw = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(operation)
    .setTimeout(300)
    .build();
  const expectedHostFunctionHash = hostFunctionHash(raw.operations[0]);
  assertCreateOnly(raw, expectedHostFunctionHash, false);
  const simulation = await server.simulateTransaction(raw);
  if (rpc.Api.isSimulationError(simulation)) throw new Error(`${input.stepId} simulation failed: ${simulation.error}`);
  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
    throw new Error(`${input.stepId} simulation did not complete.`);
  }
  const prepared = rpc.assembleTransaction(raw, simulation).build();
  assertCreateOnly(prepared, expectedHostFunctionHash, true);
  return {
    artifactId: input.artifact.id,
    contractId: Address.fromScVal(simulation.result.retval).toString(),
    hostFunctionHash: expectedHostFunctionHash,
    resource: resourceSnapshot(simulation, prepared),
    safety: {
      allowance: false,
      assetMovement: false,
      constructorInvocation: true,
      hostFunction: "createContractV2",
      operationCount: 1,
      signed: false,
      submitted: false,
    },
    saltSha256: deterministicSalt(input.stepId).toString("hex"),
    stepId: input.stepId,
    transactionHash: Buffer.from(prepared.hash()).toString("hex"),
    wasmSha256: input.artifact.sha256,
  };
}

assertContractSourcesClean();
const server = new rpc.Server(rpcUrl);
const [controllerWasm, auditWasm, verificationKey] = await Promise.all([
  verifiedWasm(controllerArtifact),
  verifiedWasm(auditArtifact),
  auditVerificationKey(),
]);
const controllerSpec = contract.Spec.fromWasm(controllerWasm);
const controller = await simulateCreate({
  artifact: controllerArtifact,
  stepId: "create-treasury-controller-v2",
  constructorArgs: controllerSpec.funcArgsToScVals("__constructor", {
    standard_asset: usdcSac,
    agent_account_wasm_hash: Buffer.from(agentAccountWasmHash, "hex"),
    budget_transition_verifier: budgetTransitionVerifier,
    private_root_backing_verifier: privateRootBackingVerifier,
    private_binding_verifier: privateBindingVerifier,
    spp_pool: sppPool,
  }),
});
const auditSpec = contract.Spec.fromWasm(auditWasm);
const auditVerifier = await simulateCreate({
  artifact: auditArtifact,
  stepId: "create-audit-total-spend-leq-verifier-v1",
  constructorArgs: auditSpec.funcArgsToScVals("__constructor", {
    controller: controller.contractId,
    verification_key: verificationKey,
  }),
});
const steps = [controller, auditVerifier];
const totalFeeStroops = steps.reduce((sum, step) => sum + BigInt(step.resource.totalFeeStroops), 0n);
const evidence = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  sourceRevision,
  network: "testnet",
  networkPassphrase: Networks.TESTNET,
  rpcUrl,
  deployer,
  dependencies: {
    agentAccountWasmHash,
    budgetTransitionVerifier,
    privateBindingVerifier,
    privateRootBackingVerifier,
    sppPool,
    standardAsset: usdcSac,
  },
  verificationKey: {
    path: auditArtifact.verificationKeyPath,
    sha256: auditArtifact.verificationKeySha256,
  },
  scope: {
    assetMovement: false,
    constructorInvocation: true,
    instanceCreation: true,
    signed: false,
    submitted: false,
  },
  steps,
  resources: {
    totalFeeStroops: totalFeeStroops.toString(),
    totalFeeXlm: (Number(totalFeeStroops) / 10_000_000).toFixed(7),
    totalInstructions: steps.reduce((sum, step) => sum + step.resource.instructions, 0),
    totalWriteBytes: steps.reduce((sum, step) => sum + step.resource.writeBytes, 0),
  },
  nextGate: "explicit user approval before either createContractV2 constructor is signed or submitted",
};

await mkdir(dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify(evidence, null, 2));
