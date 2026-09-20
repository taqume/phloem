import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  Address,
  BASE_FEE,
  Contract,
  Networks,
  Transaction,
  TransactionBuilder,
  contract,
  rpc,
} from "@stellar/stellar-sdk";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const RPC_URL = "https://soroban-testnet.stellar.org";
const DEPLOYER = "GA5GAXIGEEQTRI4Y67DTX5D44MO5C6F4NMEBPMK5ER4WQXOO2XYICFCI";
const DEPLOYMENT_PATH = resolve(REPO_ROOT, "evidence", "testnet", "phloem-instance-deployment.json");
const EVIDENCE_PATH = resolve(REPO_ROOT, "evidence", "testnet", "phloem-instance-verification.json");
const BN254_BASE_FIELD_MODULUS =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

const EXPECTED_CONTROLLER_CONFIG = {
  protocol_version: 1,
  storage_schema_version: 1,
  get_standard_asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  get_agent_account_wasm_hash: "0a9d54d3bf278131cf2239e1db52eee54f057d4e3241a6aafc2b28bca22d156d",
  get_budget_transition_verifier: "CD3GQVHD4R3E4WMFEFB6H5IJJUZXYE3IFFNY65P2J3L2V6R6A6FTJQ4O",
  get_root_backing_verifier: "CBR7ZUMSLGWHUJBL7YKL2HRTYAWB34CPM5MG5OFYANENMOTCBHH3A5PA",
  get_private_binding_verifier: "CA5MLD4MNE2S3TQ3C47PARFSWL3XPXTQS5HQHS7ZDGTKXB7TMVNXVRRW",
  get_spp_pool: "CC57FDSWPIHALXW2XWVSKEA7FA72Z37Y7AP5ASRY6V3CXAZCWQAOSLB4",
};

const PROOF_CHECKS = {
  budgetTransitionVerifierV1: {
    wasmPath: "target/wasm32v1-none/release/phloem_budget_transition_verifier.wasm",
    proofPath: ".phloem/budget-transition-setup/reservation-proof.json",
    publicPath: ".phloem/budget-transition-setup/reservation-public.json",
  },
  privateRootBackingVerifierV1: {
    wasmPath: "target/wasm32v1-none/release/phloem_private_root_backing_verifier.wasm",
    proofPath: ".phloem/private-root-backing-setup/proof.json",
    publicPath: ".phloem/private-root-backing-setup/public.json",
  },
  privateSettlementBindingVerifierV1: {
    wasmPath: "target/wasm32v1-none/release/phloem_private_settlement_binding_verifier.wasm",
    proofPath: ".phloem/private-binding-setup/proof.json",
    publicPath: ".phloem/private-binding-setup/public.json",
  },
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function coordinateBytes(value) {
  const coordinate = BigInt(value);
  if (coordinate < 0n || coordinate >= BN254_BASE_FIELD_MODULUS) {
    throw new Error("Proof contains a non-canonical BN254 coordinate.");
  }
  return Buffer.from(coordinate.toString(16).padStart(64, "0"), "hex");
}

function proofFromSnarkJs(value) {
  if (
    value.protocol !== "groth16"
    || value.curve !== "bn128"
    || value.pi_a?.[2] !== "1"
    || value.pi_c?.[2] !== "1"
    || value.pi_b?.[2]?.[0] !== "1"
    || value.pi_b?.[2]?.[1] !== "0"
  ) {
    throw new Error("Proof is not an affine snarkjs BN254 Groth16 proof.");
  }
  return {
    a: Buffer.concat([coordinateBytes(value.pi_a[0]), coordinateBytes(value.pi_a[1])]),
    b: Buffer.concat([
      coordinateBytes(value.pi_b[0][1]),
      coordinateBytes(value.pi_b[0][0]),
      coordinateBytes(value.pi_b[1][1]),
      coordinateBytes(value.pi_b[1][0]),
    ]),
    c: Buffer.concat([coordinateBytes(value.pi_c[0]), coordinateBytes(value.pi_c[1])]),
  };
}

function resourceSnapshot(simulation, transaction) {
  const resources = simulation.transactionData.build().resources;
  return {
    envelopeBytes: Buffer.from(transaction.toXDR(), "base64").byteLength,
    instructions: resources.instructions,
    diskReadBytes: resources.diskReadBytes,
    writeBytes: resources.writeBytes,
    readOnlyEntries: resources.footprint.readOnly.length,
    readWriteEntries: resources.footprint.readWrite.length,
    simulatedFeeStroops: transaction.fee,
  };
}

const deployment = JSON.parse(await readFile(DEPLOYMENT_PATH, "utf8"));
if (
  deployment.network !== "testnet"
  || deployment.deployer.address !== DEPLOYER
  || deployment.scope.assetMovement !== false
  || deployment.steps?.length !== 5
) {
  throw new Error("Instance deployment evidence is not the pinned five-step Testnet deployment.");
}

const server = new rpc.Server(RPC_URL);
const transactionChecks = [];
for (const step of deployment.steps) {
  const [transaction, deployedWasm] = await Promise.all([
    server.getTransaction(step.transaction.hash),
    server.getContractWasmByContractId(step.contractId),
  ]);
  if (
    transaction.status !== rpc.Api.GetTransactionStatus.SUCCESS
    || transaction.ledger !== step.transaction.ledger
    || transaction.resultXdr.feeCharged.toString() !== step.transaction.feeChargedStroops
    || Address.fromScVal(transaction.returnValue).toString() !== step.contractId
    || sha256(deployedWasm) !== step.wasmSha256
  ) {
    throw new Error(`Network evidence failed for ${step.stepId}.`);
  }
  const parsed = TransactionBuilder.fromXDR(transaction.envelopeXdr, Networks.TESTNET);
  const operation = parsed.operations[0];
  if (
    !(parsed instanceof Transaction)
    || parsed.source !== DEPLOYER
    || parsed.operations.length !== 1
    || operation?.type !== "invokeHostFunction"
    || operation.func.type !== "hostFunctionTypeCreateContractV2"
  ) {
    throw new Error(`${step.stepId} envelope contains an unexpected operation.`);
  }
  transactionChecks.push({
    stepId: step.stepId,
    contractId: step.contractId,
    transactionHash: step.transaction.hash,
    ledger: step.transaction.ledger,
    wasmSha256: step.wasmSha256,
    status: "SUCCESS",
  });
}

const controllerId = deployment.steps.find((step) => step.artifact === "treasuryController")?.contractId;
if (!controllerId) throw new Error("Deployment evidence has no TreasuryController contract ID.");
const controllerConfig = {};
for (const [method, expected] of Object.entries(EXPECTED_CONTROLLER_CONFIG)) {
  const response = await server.queryContract(controllerId, method);
  const value = method === "get_agent_account_wasm_hash"
    ? Buffer.from(response.result).toString("hex")
    : response.result;
  if (value !== expected) throw new Error(`TreasuryController ${method} does not match the pinned deployment.`);
  controllerConfig[method] = value;
}

const account = await server.getAccount(DEPLOYER);
const proofChecks = [];
for (const step of deployment.steps) {
  const check = PROOF_CHECKS[step.artifact];
  if (!check) continue;
  const [wasm, proofJson, publicJson] = await Promise.all([
    readFile(resolve(REPO_ROOT, check.wasmPath)),
    readFile(resolve(REPO_ROOT, check.proofPath), "utf8"),
    readFile(resolve(REPO_ROOT, check.publicPath), "utf8"),
  ]);
  const spec = contract.Spec.fromWasm(wasm);
  const args = spec.funcArgsToScVals("verify", {
    proof: proofFromSnarkJs(JSON.parse(proofJson)),
    public_inputs: JSON.parse(publicJson).map(BigInt),
  });
  const raw = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(step.contractId).call("verify", ...args))
    .setTimeout(300)
    .build();
  const simulation = await server.simulateTransaction(raw);
  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
    throw new Error(`${step.artifact} proof verification simulation failed.`);
  }
  const result = spec.funcResToNative("verify", simulation.result.retval);
  if (result?.constructor?.name !== "Ok" || result.value !== true) {
    throw new Error(`${step.artifact} rejected its pinned deployment proof.`);
  }
  const prepared = rpc.assembleTransaction(raw, simulation).build();
  proofChecks.push({
    artifact: step.artifact,
    contractId: step.contractId,
    verificationKeySha256: step.verificationKeySha256,
    accepted: true,
    submitted: false,
    resource: resourceSnapshot(simulation, prepared),
  });
}

const evidence = {
  schemaVersion: 1,
  verifiedAt: new Date().toISOString(),
  network: "testnet",
  networkPassphrase: Networks.TESTNET,
  rpcUrl: RPC_URL,
  sourceRevision: deployment.sourceRevision,
  assetMovement: false,
  transactionChecks,
  controller: {
    contractId: controllerId,
    config: controllerConfig,
  },
  verifierProofChecks: proofChecks,
};

await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify(evidence, null, 2));
