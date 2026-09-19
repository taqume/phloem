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

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const RPC_URL = "https://soroban-testnet.stellar.org";
const IDENTITY_ALIAS = "phloem-testnet-wasm-uploader";
const UPLOADER_ADDRESS = "GA5GAXIGEEQTRI4Y67DTX5D44MO5C6F4NMEBPMK5ER4WQXOO2XYICFCI";
const WASM_PATH = resolve(REPO_ROOT, "target", "wasm32v1-none", "release", "phloem_treasury_controller.wasm");
const EXPECTED_WASM_BYTES = 73_920;
const EXPECTED_WASM_SHA256 = "e7a219c685300db12b1725a14113c7b05a54103e021f9af2f20412955c085e1f";
const MAX_TOTAL_FEE_STROOPS = 112_709_770n;
const SOURCE_REVISION = "27ea0e36ea42a975b824eec568522fe70d316806";
const EVIDENCE_PATH = resolve(REPO_ROOT, "evidence", "testnet", "phloem-treasury-controller-27ea0e3-upload.json");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertUploadOnly(transaction, wasm) {
  if (!(transaction instanceof Transaction)) throw new Error("Expected a classic transaction envelope.");
  if (transaction.source !== UPLOADER_ADDRESS) throw new Error("Transaction source is not the dedicated uploader.");
  if (transaction.operations.length !== 1) throw new Error("Expected exactly one operation.");
  const operation = transaction.operations[0];
  if (
    !operation
    || operation.type !== "invokeHostFunction"
    || operation.func.type !== "hostFunctionTypeUploadContractWasm"
  ) {
    throw new Error("Transaction contains an operation other than uploadContractWasm.");
  }
  if (operation.auth.length !== 0) throw new Error("WASM upload unexpectedly contains Soroban authorization entries.");
  if (operation.func.wasm.byteLength !== wasm.byteLength || sha256(operation.func.wasm) !== EXPECTED_WASM_SHA256) {
    throw new Error("Transaction does not contain the pinned TreasuryController WASM.");
  }
  if (BigInt(transaction.fee) > MAX_TOTAL_FEE_STROOPS) {
    throw new Error(`Transaction fee ${transaction.fee} exceeds the approved ${MAX_TOTAL_FEE_STROOPS}-stroop ceiling.`);
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

async function writeEvidence(evidence) {
  await mkdir(resolve(REPO_ROOT, "evidence", "testnet"), { recursive: true });
  const temporaryPath = `${EVIDENCE_PATH}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, EVIDENCE_PATH);
}

const execute = process.argv.includes("--execute");
const wasm = await readFile(WASM_PATH);
if (wasm.byteLength !== EXPECTED_WASM_BYTES || sha256(wasm) !== EXPECTED_WASM_SHA256) {
  throw new Error("TreasuryController WASM differs from the pinned deployment artifact.");
}

const server = new rpc.Server(RPC_URL);
try {
  const existing = await server.getContractWasmByHash(Buffer.from(EXPECTED_WASM_SHA256, "hex"));
  if (existing.byteLength !== wasm.byteLength || sha256(existing) !== EXPECTED_WASM_SHA256) {
    throw new Error("Testnet returned unexpected bytes for the pinned WASM hash.");
  }
  console.log(JSON.stringify({ status: "already_present", wasmSha256: EXPECTED_WASM_SHA256 }, null, 2));
  process.exit(0);
} catch (reason) {
  if (reason instanceof Error && reason.message.includes("unexpected bytes")) throw reason;
}

const cliAddress = execFileSync("stellar", ["keys", "public-key", IDENTITY_ALIAS], {
  cwd: REPO_ROOT,
  encoding: "utf8",
}).trim();
if (cliAddress !== UPLOADER_ADDRESS) throw new Error("Secure-store identity does not match the approved uploader address.");

const account = await server.getAccount(UPLOADER_ADDRESS);
const raw = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
  .addOperation(Operation.uploadContractWasm({ wasm }))
  .setTimeout(300)
  .build();
const simulation = await server.simulateTransaction(raw);
if (rpc.Api.isSimulationError(simulation)) throw new Error(`Testnet simulation failed: ${simulation.error}`);
if (!rpc.Api.isSimulationSuccess(simulation)) throw new Error("Testnet did not complete upload simulation.");

const prepared = rpc.assembleTransaction(raw, simulation).build();
assertUploadOnly(prepared, wasm);
const resources = simulation.transactionData.build().resources;
const preflight = {
  status: execute ? "approved_for_execution" : "simulation_only",
  network: "testnet",
  uploader: UPLOADER_ADDRESS,
  operation: "uploadContractWasm",
  assetMovement: false,
  contractInvocation: false,
  wasmSha256: EXPECTED_WASM_SHA256,
  wasmBytes: wasm.byteLength,
  maximumFeeStroops: prepared.fee,
  approvedFeeCeilingStroops: MAX_TOTAL_FEE_STROOPS.toString(),
  instructions: resources.instructions,
  writeBytes: resources.writeBytes,
  envelopeBytes: Buffer.from(prepared.toXDR(), "base64").byteLength,
  latestLedger: simulation.latestLedger,
};

if (!execute) {
  console.log(JSON.stringify(preflight, null, 2));
  process.exit(0);
}

const signedXdr = signWithSecureStore(prepared.toXDR());
const signed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
assertUploadOnly(signed, wasm);
if (signed.signatures.length !== 1) throw new Error("Expected exactly one uploader signature.");
const signature = signed.signatures[0];
if (!signature || !Keypair.fromPublicKey(UPLOADER_ADDRESS).verify(signed.hash(), signature.signature)) {
  throw new Error("Secure-store signature verification failed.");
}

const submitted = await server.sendTransaction(signed);
if (submitted.status === "ERROR") throw new Error("Testnet rejected the signed WASM upload.");
if (submitted.status === "TRY_AGAIN_LATER") throw new Error("Testnet asked the uploader to retry later; transaction not confirmed.");
const final = await server.pollTransaction(submitted.hash, { attempts: 60 });
if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
  throw new Error(`WASM upload ended with ${final.status}.`);
}
const uploaded = await server.getContractWasmByHash(Buffer.from(EXPECTED_WASM_SHA256, "hex"));
if (uploaded.byteLength !== wasm.byteLength || sha256(uploaded) !== EXPECTED_WASM_SHA256) {
  throw new Error("Uploaded Testnet WASM verification failed.");
}

const evidence = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  sourceRevision: SOURCE_REVISION,
  network: "testnet",
  networkPassphrase: Networks.TESTNET,
  rpcUrl: RPC_URL,
  uploader: {
    address: UPLOADER_ADDRESS,
    identityAlias: IDENTITY_ALIAS,
    funding: "Stellar Testnet Friendbot",
    authority: "none: code upload only; not a Phloem admin, treasury, or contract instance authority",
    secretStorage: "macOS Keychain via Stellar CLI secure store",
  },
  transaction: {
    hash: submitted.hash,
    ledger: final.ledger,
    feeChargedStroops: final.resultXdr.feeCharged.toString(),
    maximumFeeStroops: prepared.fee,
    approvedFeeCeilingStroops: MAX_TOTAL_FEE_STROOPS.toString(),
    operationCount: signed.operations.length,
    hostFunction: "uploadContractWasm",
    assetMovement: false,
    contractInvocation: false,
  },
  artifact: {
    name: "TreasuryController",
    path: "target/wasm32v1-none/release/phloem_treasury_controller.wasm",
    bytes: wasm.byteLength,
    sha256: EXPECTED_WASM_SHA256,
  },
  resources: {
    instructions: resources.instructions,
    writeBytes: resources.writeBytes,
    envelopeBytes: Buffer.from(prepared.toXDR(), "base64").byteLength,
    simulationLedger: simulation.latestLedger,
  },
  verification: {
    transactionStatus: "SUCCESS",
    networkWasmHash: EXPECTED_WASM_SHA256,
    networkWasmBytes: uploaded.byteLength,
  },
};
await writeEvidence(evidence);
console.log(JSON.stringify({ status: "success", ...evidence }, null, 2));
