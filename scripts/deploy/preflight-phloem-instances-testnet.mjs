import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

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

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const RPC_URL = "https://soroban-testnet.stellar.org";
const DEPLOYER = "GA5GAXIGEEQTRI4Y67DTX5D44MO5C6F4NMEBPMK5ER4WQXOO2XYICFCI";
const SOURCE_REVISION = "27ea0e36ea42a975b824eec568522fe70d316806";
const EVIDENCE_PATH = resolve(REPO_ROOT, "evidence", "testnet", "phloem-instance-preflight.json");
const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const SPP_POOL = "CC57FDSWPIHALXW2XWVSKEA7FA72Z37Y7AP5ASRY6V3CXAZCWQAOSLB4";
const AGENT_ACCOUNT_WASM_HASH = "0a9d54d3bf278131cf2239e1db52eee54f057d4e3241a6aafc2b28bca22d156d";
const BN254_BASE_FIELD_MODULUS =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

const STEPS = [
  {
    id: "create-ed25519-verifier",
    artifact: "ed25519Verifier",
    wasmPath: "target/wasm32v1-none/release/phloem_ed25519_verifier.wasm",
    wasmSha256: "aa15e1a91fd5d41a755b5321f97bb4290e0db4595dd4408e2e89f16d4d066600",
  },
  {
    id: "create-budget-transition-verifier-v1",
    artifact: "budgetTransitionVerifierV1",
    wasmPath: "target/wasm32v1-none/release/phloem_budget_transition_verifier.wasm",
    wasmSha256: "0e068ff97a66fb5056c7249444e2b31762dc1ae9031a725d7f5ae8f1676ddb0d",
    verificationKeyPath: ".phloem/budget-transition-setup/verification_key.json",
    verificationKeySha256: "52d999f482d0309fe332ff042250385419568d2d4d07e97e775439938955d772",
    publicInputCount: 8,
  },
  {
    id: "create-private-root-backing-verifier-v1",
    artifact: "privateRootBackingVerifierV1",
    wasmPath: "target/wasm32v1-none/release/phloem_private_root_backing_verifier.wasm",
    wasmSha256: "779d500e9afcf7d07eac315ae41ecc4e23df581dfceec2fd5a7668d45a270005",
    verificationKeyPath: ".phloem/private-root-backing-setup/verification_key.json",
    verificationKeySha256: "36cd9762d1ffcdd5d32c35f11d31e707a03fc1738a6432439a576923e590fb8c",
    publicInputCount: 7,
  },
  {
    id: "create-private-settlement-binding-verifier-v1",
    artifact: "privateSettlementBindingVerifierV1",
    wasmPath: "target/wasm32v1-none/release/phloem_private_settlement_binding_verifier.wasm",
    wasmSha256: "058079beb6e94dec7bfc594c3a2f21554af82d4bdd62a8fa70689d8ba0c72029",
    verificationKeyPath: ".phloem/private-binding-setup/verification_key.json",
    verificationKeySha256: "c727f8b2656231bd50cb0139bde6e998e4f922766f2d351d76ddb88e322c485d",
    publicInputCount: 16,
  },
  {
    id: "create-treasury-controller",
    artifact: "treasuryController",
    wasmPath: "target/wasm32v1-none/release/phloem_treasury_controller.wasm",
    wasmSha256: "e7a219c685300db12b1725a14113c7b05a54103e021f9af2f20412955c085e1f",
  },
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function coordinateBytes(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("Verification key contains a non-decimal BN254 coordinate.");
  }
  const coordinate = BigInt(value);
  if (coordinate < 0n || coordinate >= BN254_BASE_FIELD_MODULUS) {
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
  if (
    !Array.isArray(point)
    || point.length !== 3
    || !Array.isArray(point[0])
    || !Array.isArray(point[1])
    || !Array.isArray(point[2])
    || point[0].length !== 2
    || point[1].length !== 2
    || point[2][0] !== "1"
    || point[2][1] !== "0"
  ) {
    throw new Error("Verification key contains a non-affine G2 point.");
  }
  return Buffer.concat([
    coordinateBytes(point[0][1]),
    coordinateBytes(point[0][0]),
    coordinateBytes(point[1][1]),
    coordinateBytes(point[1][0]),
  ]);
}

async function verifiedFile(relativePath, expectedHash) {
  const bytes = await readFile(resolve(REPO_ROOT, relativePath));
  if (sha256(bytes) !== expectedHash) throw new Error(`${relativePath} differs from its pinned SHA-256.`);
  return bytes;
}

async function verificationKey(step) {
  const bytes = await verifiedFile(step.verificationKeyPath, step.verificationKeySha256);
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (parsed.protocol !== "groth16" || parsed.curve !== "bn128" || parsed.nPublic !== step.publicInputCount) {
    throw new Error(`${step.artifact} verification key metadata does not match its circuit.`);
  }
  if (!Array.isArray(parsed.IC) || parsed.IC.length !== step.publicInputCount + 1) {
    throw new Error(`${step.artifact} verification key has the wrong IC length.`);
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
  return createHash("sha256").update(`PHLOEM_TESTNET_V1:${SOURCE_REVISION}:${stepId}`, "utf8").digest();
}

function hostFunctionHash(operation) {
  return sha256(operation.func.toXDR());
}

function assertCreateOnly(transaction, expectedHostFunctionHash, prepared = false) {
  if (!(transaction instanceof Transaction)) throw new Error("Expected a classic transaction envelope.");
  if (transaction.source !== DEPLOYER) throw new Error("Instance transaction source differs from the pinned deployer.");
  if (transaction.operations.length !== 1) throw new Error("Instance transaction must contain exactly one operation.");
  const operation = transaction.operations[0];
  if (
    !operation
    || operation.type !== "invokeHostFunction"
    || operation.func.type !== "hostFunctionTypeCreateContractV2"
  ) {
    throw new Error("Instance transaction contains a host function other than createContractV2.");
  }
  if (hostFunctionHash(operation) !== expectedHostFunctionHash) {
    throw new Error("Simulation changed the pinned contract creation host function.");
  }
  if (!prepared && operation.auth.length !== 0) {
    throw new Error("Raw instance creation unexpectedly contains Soroban auth entries.");
  }
  if (prepared) {
    if (operation.auth.length !== 1) throw new Error("Prepared instance creation must contain one source-account auth entry.");
    const auth = inspectAuthEntry(operation.auth[0]);
    if (
      auth.credentialType !== "sourceAccount"
      || auth.address !== null
      || auth.invocation.function.type !== "sorobanAuthorizedFunctionTypeCreateContractV2HostFn"
      || auth.invocation.subInvocations.length !== 0
      || sha256(auth.invocation.function.value.toXDR()) !== sha256(operation.func.value.toXDR())
    ) {
      throw new Error("Prepared instance creation contains unexpected Soroban authorization.");
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

const server = new rpc.Server(RPC_URL);
const account = await server.getAccount(DEPLOYER);
const results = [];
const contractIds = {};

for (const step of STEPS) {
  const wasm = await verifiedFile(step.wasmPath, step.wasmSha256);
  const networkWasm = await server.getContractWasmByHash(Buffer.from(step.wasmSha256, "hex"));
  if (sha256(networkWasm) !== step.wasmSha256 || networkWasm.byteLength !== wasm.byteLength) {
    throw new Error(`Testnet WASM differs for ${step.artifact}.`);
  }
  const spec = contract.Spec.fromWasm(wasm);
  let constructorArgs = [];
  if (step.verificationKeyPath) {
    constructorArgs = spec.funcArgsToScVals("__constructor", {
      verification_key: await verificationKey(step),
    });
  } else if (step.artifact === "treasuryController") {
    constructorArgs = spec.funcArgsToScVals("__constructor", {
      standard_asset: USDC_SAC,
      agent_account_wasm_hash: Buffer.from(AGENT_ACCOUNT_WASM_HASH, "hex"),
      budget_transition_verifier: contractIds.budgetTransitionVerifierV1,
      private_root_backing_verifier: contractIds.privateRootBackingVerifierV1,
      private_binding_verifier: contractIds.privateSettlementBindingVerifierV1,
      spp_pool: SPP_POOL,
    });
  }

  const operation = Operation.createCustomContract({
    address: new Address(DEPLOYER),
    constructorArgs,
    salt: deterministicSalt(step.id),
    wasmHash: Buffer.from(step.wasmSha256, "hex"),
  });
  const raw = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(operation)
    .setTimeout(300)
    .build();
  const expectedHostFunctionHash = hostFunctionHash(raw.operations[0]);
  assertCreateOnly(raw, expectedHostFunctionHash);
  const simulation = await server.simulateTransaction(raw);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Testnet rejected ${step.id}: ${simulation.error}`);
  }
  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
    throw new Error(`Testnet did not complete ${step.id} simulation.`);
  }
  const prepared = rpc.assembleTransaction(raw, simulation).build();
  assertCreateOnly(prepared, expectedHostFunctionHash, true);
  const contractId = Address.fromScVal(simulation.result.retval).toString();
  contractIds[step.artifact] = contractId;
  results.push({
    stepId: step.id,
    artifact: step.artifact,
    contractId,
    wasmSha256: step.wasmSha256,
    saltSha256: deterministicSalt(step.id).toString("hex"),
    ...(step.verificationKeySha256 ? { verificationKeySha256: step.verificationKeySha256 } : {}),
    resource: resourceSnapshot(simulation, prepared),
    safety: {
      assetMovement: false,
      contractInvocation: false,
      hostFunction: "createContractV2",
      operationCount: 1,
      submitted: false,
    },
  });
}

const totalFeeStroops = results.reduce((sum, result) => sum + BigInt(result.resource.totalFeeStroops), 0n);
const evidence = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  sourceRevision: SOURCE_REVISION,
  network: "testnet",
  networkPassphrase: Networks.TESTNET,
  rpcUrl: RPC_URL,
  deployer: {
    address: DEPLOYER,
    authority: "none after creation; constructors pin protocol dependencies and no deployer/admin key",
  },
  dependencies: {
    standardAsset: USDC_SAC,
    sppPool: SPP_POOL,
    agentAccountWasmHash: AGENT_ACCOUNT_WASM_HASH,
  },
  scope: {
    signed: false,
    submitted: false,
    assetMovement: false,
    agentAccountInstances: "deferred until session-specific keys and expiry are fixed",
    auditAccumulatorVerifier: "excluded from canonical P0 settlement dependencies",
  },
  steps: results,
  resources: {
    transactionCount: results.length,
    totalFeeStroops: totalFeeStroops.toString(),
    totalFeeXlm: (Number(totalFeeStroops) / 10_000_000).toFixed(7),
    totalInstructions: results.reduce((sum, result) => sum + result.resource.instructions, 0),
    totalWriteBytes: results.reduce((sum, result) => sum + result.resource.writeBytes, 0),
  },
};

await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify(evidence, null, 2));
