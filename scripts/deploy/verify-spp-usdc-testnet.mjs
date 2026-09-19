#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  contract,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const manifest = JSON.parse(await readFile(resolve(REPO_ROOT, "deployments", "testnet.json"), "utf8"));
const sdkDeployment = JSON.parse(await readFile(resolve(REPO_ROOT, "deployments", "spp-usdc-testnet.sdk.json"), "utf8"));
const server = new rpc.Server("https://soroban-testnet.stellar.org");

const stepArtifact = {
  "upload-pool": "pool",
  "create-asp-membership": "aspMembership",
  "create-asp-non-membership": "aspNonMembership",
  "create-verifier": "verifierB",
  "create-public-key-registry": "publicKeyRegistry",
  "create-pool": "pool",
};
const stepContract = {
  "create-asp-membership": "aspMembership",
  "create-asp-non-membership": "aspNonMembership",
  "create-verifier": "verifierB",
  "create-public-key-registry": "publicKeyRegistry",
  "create-pool": "pool",
};
const artifactFile = {
  aspMembership: "asp_membership.wasm",
  aspNonMembership: "asp_non_membership.wasm",
  verifierB: "circom_groth16_verifier_B.wasm",
  publicKeyRegistry: "public_key_registry.wasm",
  pool: "pool.wasm",
};

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonSafe(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
}

async function specFor(artifactId) {
  const wasm = await readFile(resolve(REPO_ROOT, "target", "spp-testnet-usdc", artifactFile[artifactId]));
  const artifact = manifest.spp.artifacts[artifactId];
  invariant(wasm.byteLength === artifact.bytes, `${artifactId}: local WASM size mismatch`);
  invariant(sha256(wasm) === artifact.sha256, `${artifactId}: local WASM hash mismatch`);
  return contract.Spec.fromWasm(wasm);
}

function decodeConstructor(spec, args) {
  if (args.length === 0) return {};
  const inputs = spec.getFunc("__constructor").inputs;
  invariant(inputs.length === args.length, "constructor argument count mismatch");
  return Object.fromEntries(inputs.map((input, index) => [
    input.name.toString(),
    jsonSafe(spec.scValToNative(args[index], input.type)),
  ]));
}

const expectedConstructors = {
  "create-asp-membership": {
    admin: manifest.admin,
    levels: manifest.spp.configuration.aspLevels,
  },
  "create-asp-non-membership": {
    admin: manifest.admin,
  },
  "create-verifier": {},
  "create-public-key-registry": {},
  "create-pool": {
    admin: manifest.admin,
    token: manifest.spp.asset.sacContractId,
    verifier: manifest.spp.contracts.verifierB,
    asp_membership: manifest.spp.contracts.aspMembership,
    asp_non_membership: manifest.spp.contracts.aspNonMembership,
    maximum_deposit_amount: manifest.spp.configuration.maximumDepositAmount,
    levels: manifest.spp.configuration.poolLevels,
    policy_flags: manifest.spp.configuration.policyFlags,
  },
};

const transactionChecks = [];
for (const evidence of manifest.spp.transactions) {
  const result = await server.getTransaction(evidence.hash);
  invariant(result.status === rpc.Api.GetTransactionStatus.SUCCESS, `${evidence.step}: transaction is not successful`);
  invariant(result.ledger === evidence.ledger, `${evidence.step}: ledger mismatch`);
  const transaction = TransactionBuilder.fromXDR(result.envelopeXdr.toXDR("base64"), Networks.TESTNET);
  invariant(transaction.source === manifest.deployer, `${evidence.step}: source mismatch`);
  invariant(transaction.operations.length === 1, `${evidence.step}: expected one operation`);
  const operation = transaction.operations[0];
  invariant(operation?.type === "invokeHostFunction", `${evidence.step}: non-host-function operation`);

  const artifactId = stepArtifact[evidence.step];
  invariant(artifactId, `${evidence.step}: unknown evidence step`);
  const artifact = manifest.spp.artifacts[artifactId];
  if (evidence.step === "upload-pool") {
    invariant(operation.func.type === "hostFunctionTypeUploadContractWasm", "pool upload has the wrong host function");
    invariant(sha256(operation.func.wasm) === artifact.sha256, "uploaded pool WASM hash mismatch");
    invariant(Buffer.from(scValToNative(result.returnValue)).toString("hex") === artifact.sha256, "upload return hash mismatch");
  } else {
    invariant(operation.func.type === "hostFunctionTypeCreateContractV2", `${evidence.step}: wrong host function`);
    const create = operation.func.createContractV2;
    invariant(Buffer.from(create.executable.wasmHash.value).toString("hex") === artifact.sha256, `${evidence.step}: executable hash mismatch`);
    const contractKey = stepContract[evidence.step];
    const contractId = Address.fromScVal(result.returnValue).toString();
    invariant(contractId === manifest.spp.contracts[contractKey], `${evidence.step}: return contract ID mismatch`);
    const constructor = decodeConstructor(await specFor(artifactId), create.constructorArgs);
    invariant(JSON.stringify(constructor) === JSON.stringify(expectedConstructors[evidence.step]), `${evidence.step}: constructor mismatch`);
  }
  transactionChecks.push({ hash: evidence.hash, ledger: evidence.ledger, operation: operation.func.type, step: evidence.step });
}

const contractChecks = {};
for (const [name, contractId] of Object.entries(manifest.spp.contracts)) {
  const bytes = await server.getContractWasmByContractId(contractId);
  const artifact = manifest.spp.artifacts[name];
  invariant(artifact, `${name}: no artifact evidence`);
  invariant(bytes.byteLength === artifact.bytes, `${name}: live WASM size mismatch`);
  invariant(sha256(bytes) === artifact.sha256, `${name}: live WASM hash mismatch`);
  contractChecks[name] = { bytes: bytes.byteLength, contractId, wasmHash: artifact.sha256 };
}

const anchorTomlUrl = "https://tr-mock-anchor.fly.dev/.well-known/stellar.toml";
const stellarToml = await (await fetch(anchorTomlUrl)).text();
invariant(stellarToml.includes(`issuer="${manifest.spp.asset.issuer}"`) || stellarToml.includes(`issuer = "${manifest.spp.asset.issuer}"`), "Anchor no longer advertises the pinned USDC issuer");
const derivedSac = new Asset(manifest.spp.asset.code, manifest.spp.asset.issuer).contractId(Networks.TESTNET);
invariant(derivedSac === manifest.spp.asset.sacContractId, "derived USDC SAC mismatch");

const pool = new Contract(manifest.spp.contracts.pool);
const source = await server.getAccount(manifest.deployer);
const poolSpec = await specFor("pool");
const poolReadMethods = ["get_root", "get_policy_flags", "get_asp_membership_root", "get_asp_non_membership_root"];
const poolReads = {};
for (const method of poolReadMethods) {
  const transaction = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(pool.call(method))
    .setTimeout(60)
    .build();
  const simulation = await server.simulateTransaction(transaction);
  invariant(rpc.Api.isSimulationSuccess(simulation) && simulation.result, `${method}: simulation failed`);
  const resources = simulation.transactionData.build().resources;
  poolReads[method] = {
    result: jsonSafe(poolSpec.funcResToNative(method, simulation.result.retval)),
    resources: {
      diskReadBytes: resources.diskReadBytes,
      instructions: resources.instructions,
      readOnlyEntries: resources.footprint.readOnly.length,
      readWriteEntries: resources.footprint.readWrite.length,
      writeBytes: resources.writeBytes,
    },
  };
}

invariant(sdkDeployment.pools[0].poolContractId === manifest.spp.contracts.pool, "SDK pool ID mismatch");
invariant(sdkDeployment.pools[0].tokenContractId === manifest.spp.asset.sacContractId, "SDK token ID mismatch");
invariant(sdkDeployment.verifiers.B === manifest.spp.contracts.verifierB, "SDK verifier ID mismatch");

const health = await server.getHealth();
const ledger = await server.getLatestLedger();
console.log(JSON.stringify({
  contracts: contractChecks,
  poolReads,
  rpc: {
    latestLedger: ledger.sequence,
    oldestLedger: health.oldestLedger,
    protocolVersion: ledger.protocolVersion,
    status: health.status,
  },
  transactions: transactionChecks,
}, null, 2));
