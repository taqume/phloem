import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  Address,
  BASE_FEE,
  Keypair,
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
const IDENTITY_ALIAS = "phloem-testnet-wasm-uploader";
const SOURCE_REVISION = "164d0ed224b2cacedcc9afb9252dff0705fa4ec2";
const WASM_SHA256 = "c4607977b54c68d3344fdfeee669ee9a15a6fda81ee0e98357020b2ad7dd0f44";
const WASM_PATH = resolve(REPO_ROOT, "target", "wasm32v1-none", "release", "phloem_treasury_controller.wasm");
const EVIDENCE_PATH = resolve(REPO_ROOT, "evidence", "testnet", "phloem-treasury-controller-164d0ed-instance.json");
const MAX_TOTAL_FEE_STROOPS = 250_000n;

const DEPENDENCIES = Object.freeze({
  standardAsset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  agentAccountWasmHash: "0a9d54d3bf278131cf2239e1db52eee54f057d4e3241a6aafc2b28bca22d156d",
  budgetTransitionVerifier: "CD3GQVHD4R3E4WMFEFB6H5IJJUZXYE3IFFNY65P2J3L2V6R6A6FTJQ4O",
  privateRootBackingVerifier: "CBR7ZUMSLGWHUJBL7YKL2HRTYAWB34CPM5MG5OFYANENMOTCBHH3A5PA",
  privateBindingVerifier: "CA5MLD4MNE2S3TQ3C47PARFSWL3XPXTQS5HQHS7ZDGTKXB7TMVNXVRRW",
  sppPool: "CC57FDSWPIHALXW2XWVSKEA7FA72Z37Y7AP5ASRY6V3CXAZCWQAOSLB4",
});
const EXPECTED_READS = Object.freeze({
  protocol_version: 1,
  storage_schema_version: 1,
  get_standard_asset: DEPENDENCIES.standardAsset,
  get_agent_account_wasm_hash: DEPENDENCIES.agentAccountWasmHash,
  get_budget_transition_verifier: DEPENDENCIES.budgetTransitionVerifier,
  get_root_backing_verifier: DEPENDENCIES.privateRootBackingVerifier,
  get_private_binding_verifier: DEPENDENCIES.privateBindingVerifier,
  get_spp_pool: DEPENDENCIES.sppPool,
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function salt() {
  return createHash("sha256")
    .update(`PHLOEM_TESTNET_V1:${SOURCE_REVISION}:create-treasury-controller`, "utf8")
    .digest();
}

function hostFunctionHash(operation) {
  return sha256(operation.func.toXDR());
}

function assertCreateOnly(transaction, expectedHostFunctionHash, prepared = false) {
  if (!(transaction instanceof Transaction)) throw new Error("Expected a classic transaction envelope.");
  if (transaction.source !== DEPLOYER) throw new Error("Transaction source differs from the pinned deployer.");
  if (transaction.operations.length !== 1) throw new Error("Expected exactly one operation.");
  const operation = transaction.operations[0];
  if (!operation || operation.type !== "invokeHostFunction" || operation.func.type !== "hostFunctionTypeCreateContractV2") {
    throw new Error("Transaction contains a host function other than createContractV2.");
  }
  if (hostFunctionHash(operation) !== expectedHostFunctionHash) {
    throw new Error("Simulation changed the pinned contract creation host function.");
  }
  if (!prepared && operation.auth.length !== 0) {
    throw new Error("Raw contract creation unexpectedly contains Soroban auth entries.");
  }
  if (prepared) {
    if (operation.auth.length !== 1) throw new Error("Prepared creation must contain one source-account auth entry.");
    const auth = inspectAuthEntry(operation.auth[0]);
    if (
      auth.credentialType !== "sourceAccount"
      || auth.address !== null
      || auth.invocation.function.type !== "sorobanAuthorizedFunctionTypeCreateContractV2HostFn"
      || auth.invocation.subInvocations.length !== 0
      || sha256(auth.invocation.function.value.toXDR()) !== sha256(operation.func.value.toXDR())
    ) {
      throw new Error("Prepared creation contains unexpected Soroban authorization.");
    }
  }
  if (BigInt(transaction.fee) > MAX_TOTAL_FEE_STROOPS) {
    throw new Error(`Transaction fee ${transaction.fee} exceeds the ${MAX_TOTAL_FEE_STROOPS}-stroop ceiling.`);
  }
}

function signWithSecureStore(transactionXdr) {
  const signedXdr = execFileSync(
    "stellar",
    ["tx", "sign", "--quiet", "--sign-with-key", IDENTITY_ALIAS, "--network", "testnet"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      input: `${transactionXdr}\n`,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["pipe", "pipe", "inherit"],
    },
  ).trim();
  if (!signedXdr) throw new Error("Stellar CLI returned no signed transaction.");
  return signedXdr;
}

async function writeEvidence(value) {
  await mkdir(resolve(EVIDENCE_PATH, ".."), { recursive: true });
  const temporaryPath = `${EVIDENCE_PATH}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, EVIDENCE_PATH);
}

const execute = process.argv.includes("--execute");
const wasm = await readFile(WASM_PATH);
if (sha256(wasm) !== WASM_SHA256) throw new Error("TreasuryController WASM differs from the pinned artifact.");

const server = new rpc.Server(RPC_URL);
const networkWasm = await server.getContractWasmByHash(Buffer.from(WASM_SHA256, "hex"));
if (networkWasm.byteLength !== wasm.byteLength || sha256(networkWasm) !== WASM_SHA256) {
  throw new Error("Testnet does not contain the pinned TreasuryController WASM.");
}

if (execute) {
  const cliAddress = execFileSync("stellar", ["keys", "public-key", IDENTITY_ALIAS], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  if (cliAddress !== DEPLOYER) throw new Error("Secure-store identity does not match the pinned deployer.");
}

const spec = contract.Spec.fromWasm(wasm);
const constructorArgs = spec.funcArgsToScVals("__constructor", {
  standard_asset: DEPENDENCIES.standardAsset,
  agent_account_wasm_hash: Buffer.from(DEPENDENCIES.agentAccountWasmHash, "hex"),
  budget_transition_verifier: DEPENDENCIES.budgetTransitionVerifier,
  private_root_backing_verifier: DEPENDENCIES.privateRootBackingVerifier,
  private_binding_verifier: DEPENDENCIES.privateBindingVerifier,
  spp_pool: DEPENDENCIES.sppPool,
});
const operation = Operation.createCustomContract({
  address: new Address(DEPLOYER),
  constructorArgs,
  salt: salt(),
  wasmHash: Buffer.from(WASM_SHA256, "hex"),
});
const account = await server.getAccount(DEPLOYER);
const raw = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
  .addOperation(operation)
  .setTimeout(300)
  .build();
const expectedHostFunctionHash = hostFunctionHash(raw.operations[0]);
assertCreateOnly(raw, expectedHostFunctionHash);

const simulation = await server.simulateTransaction(raw);
if (rpc.Api.isSimulationError(simulation)) throw new Error(`Testnet simulation failed: ${simulation.error}`);
if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
  throw new Error("Testnet did not complete the controller creation simulation.");
}
const prepared = rpc.assembleTransaction(raw, simulation).build();
assertCreateOnly(prepared, expectedHostFunctionHash, true);
const contractId = Address.fromScVal(simulation.result.retval).toString();
const resources = simulation.transactionData.build().resources;

const baseEvidence = {
  schemaVersion: 1,
  sourceRevision: SOURCE_REVISION,
  network: "testnet",
  networkPassphrase: Networks.TESTNET,
  rpcUrl: RPC_URL,
  deployer: {
    address: DEPLOYER,
    authority: "none after creation; constructor pins dependencies and exposes no deployer/admin authority",
  },
  artifact: { bytes: wasm.byteLength, sha256: WASM_SHA256 },
  contractId,
  constructor: DEPENDENCIES,
  saltSha256: salt().toString("hex"),
  safety: {
    assetMovement: false,
    contractInvocation: false,
    hostFunction: "createContractV2",
    operationCount: 1,
  },
  resource: {
    diskReadBytes: resources.diskReadBytes,
    envelopeBytes: Buffer.from(prepared.toXDR(), "base64").byteLength,
    footprintReadOnlyEntries: resources.footprint.readOnly.length,
    footprintReadWriteEntries: resources.footprint.readWrite.length,
    instructions: resources.instructions,
    latestLedger: simulation.latestLedger,
    minResourceFeeStroops: simulation.minResourceFee,
    maximumFeeStroops: prepared.fee,
    approvedFeeCeilingStroops: MAX_TOTAL_FEE_STROOPS.toString(),
    writeBytes: resources.writeBytes,
  },
};

if (!execute) {
  console.log(JSON.stringify({ status: "simulation_only", ...baseEvidence }, null, 2));
  process.exit(0);
}

const signedXdr = signWithSecureStore(prepared.toXDR());
const signed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
assertCreateOnly(signed, expectedHostFunctionHash, true);
if (signed.signatures.length !== 1) throw new Error("Expected exactly one deployer signature.");
const signature = signed.signatures[0];
if (!signature || !Keypair.fromPublicKey(DEPLOYER).verify(signed.hash(), signature.signature)) {
  throw new Error("Secure-store signature verification failed.");
}

const submitted = await server.sendTransaction(signed);
if (submitted.status === "ERROR") throw new Error("Testnet rejected the controller creation.");
if (submitted.status === "TRY_AGAIN_LATER") throw new Error("Testnet asked the deployer to retry later.");
const final = await server.pollTransaction(submitted.hash, { attempts: 60 });
if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`Controller creation ended with ${final.status}.`);
const deployedWasm = await server.getContractWasmByContractId(contractId);
if (deployedWasm.byteLength !== wasm.byteLength || sha256(deployedWasm) !== WASM_SHA256) {
  throw new Error("Created controller does not resolve to the pinned WASM.");
}
const readonlyConfig = {};
for (const [method, expected] of Object.entries(EXPECTED_READS)) {
  const response = await server.queryContract(contractId, method);
  const actual = method === "get_agent_account_wasm_hash"
    ? Buffer.from(response.result).toString("hex")
    : response.result;
  if (actual !== expected) throw new Error(`Created controller ${method} differs from its pinned constructor config.`);
  readonlyConfig[method] = actual;
}

const evidence = {
  ...baseEvidence,
  recordedAt: new Date().toISOString(),
  transaction: {
    hash: submitted.hash,
    ledger: final.ledger,
    feeChargedStroops: final.resultXdr.feeCharged.toString(),
    maximumFeeStroops: prepared.fee,
    status: "SUCCESS",
  },
  verification: {
    config: readonlyConfig,
    networkWasmBytes: deployedWasm.byteLength,
    networkWasmHash: sha256(deployedWasm),
    transactionStatus: "SUCCESS",
  },
};
await writeEvidence(evidence);
console.log(JSON.stringify({ status: "success", ...evidence }, null, 2));
