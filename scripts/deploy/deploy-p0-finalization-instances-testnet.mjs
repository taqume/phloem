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

const root = resolve(import.meta.dirname, "../..");
const rpcUrl = "https://soroban-testnet.stellar.org";
const identityAlias = "phloem-testnet-wasm-uploader";
const deployer = "GA5GAXIGEEQTRI4Y67DTX5D44MO5C6F4NMEBPMK5ER4WQXOO2XYICFCI";
const sourceRevision = "2d7fc18ff7c48be3608ccdb8a33d2eaaeb21fc22";
const preflightPath = resolve(root, "evidence/testnet/p0-finalization-instance-preflight.json");
const evidencePath = resolve(root, "evidence/testnet/p0-finalization-instance-deployment.json");
const progressPath = resolve(root, "deployments/local/p0-finalization-instance-progress.json");
const totalFeeCeilingStroops = 589_738n;
const bn254BaseFieldModulus =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

const dependencies = Object.freeze({
  standardAsset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  agentAccountWasmHash: "0a9d54d3bf278131cf2239e1db52eee54f057d4e3241a6aafc2b28bca22d156d",
  budgetTransitionVerifier: "CD3GQVHD4R3E4WMFEFB6H5IJJUZXYE3IFFNY65P2J3L2V6R6A6FTJQ4O",
  privateRootBackingVerifier: "CBR7ZUMSLGWHUJBL7YKL2HRTYAWB34CPM5MG5OFYANENMOTCBHH3A5PA",
  privateBindingVerifier: "CA5MLD4MNE2S3TQ3C47PARFSWL3XPXTQS5HQHS7ZDGTKXB7TMVNXVRRW",
  sppPool: "CC57FDSWPIHALXW2XWVSKEA7FA72Z37Y7AP5ASRY6V3CXAZCWQAOSLB4",
});

const steps = [
  {
    id: "create-treasury-controller-v2",
    artifact: "treasuryControllerV2",
    contractId: "CDGSEV2HZZM4YLVQXXS3EWVZILOFGWHNNVEEZM3S4P7FESA6JIRVJ2T2",
    hostFunctionHash: "0b89c4c56390c9604aec793f5f00a6b003e44bf41adb65a359f6f8edae0ee57f",
    wasmPath: "target/wasm32v1-none/release/phloem_treasury_controller.wasm",
    wasmSha256: "a77bf56561530bf8fbc9894dcd80869b9e257d2fb296b61e10b7225b1bf32a70",
  },
  {
    id: "create-audit-total-spend-leq-verifier-v1",
    artifact: "auditTotalSpendLeqVerifierV1",
    contractId: "CAM5OBYNHYPTZKLUE2NGI7ORPBLBU456KFFXYWZZ5V6EUJWMVXZP57DE",
    hostFunctionHash: "e41de3d05a60980167abd28c03edcbe4d29103337afa2ca074634d71e094e12b",
    wasmPath: "target/wasm32v1-none/release/phloem_audit_total_spend_leq_verifier.wasm",
    wasmSha256: "415805bd7213128dc84cd21225888786781444655492462fb1544c2366d460e4",
    verificationKeyPath: ".phloem/audit-total-spend-leq-setup/verification_key.json",
    verificationKeySha256: "2cceaad298a9c90e9f569ed677808f827471f8872c0727988bab9c7720efab19",
  },
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function deterministicSalt(stepId) {
  return createHash("sha256")
    .update(`PHLOEM_TESTNET_FINALIZATION_V1:${sourceRevision}:${stepId}`, "utf8")
    .digest();
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
  if (!Array.isArray(point) || point.length !== 3 || !Array.isArray(point[0])
    || !Array.isArray(point[1]) || !Array.isArray(point[2]) || point[0].length !== 2
    || point[1].length !== 2 || point[2][0] !== "1" || point[2][1] !== "0") {
    throw new Error("Verification key contains a non-affine G2 point.");
  }
  return Buffer.concat([
    coordinateBytes(point[0][1]), coordinateBytes(point[0][0]),
    coordinateBytes(point[1][1]), coordinateBytes(point[1][0]),
  ]);
}

async function auditVerificationKey(step) {
  const bytes = await readFile(resolve(root, step.verificationKeyPath));
  if (sha256(bytes) !== step.verificationKeySha256) {
    throw new Error("Audit verification key differs from the pinned ceremony artifact.");
  }
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (parsed.protocol !== "groth16" || parsed.curve !== "bn128" || parsed.nPublic !== 7
    || !Array.isArray(parsed.IC) || parsed.IC.length !== 8) {
    throw new Error("Audit verification key metadata is invalid.");
  }
  return {
    alpha: g1(parsed.vk_alpha_1), beta: g2(parsed.vk_beta_2),
    gamma: g2(parsed.vk_gamma_2), delta: g2(parsed.vk_delta_2), ic: parsed.IC.map(g1),
  };
}

function hostFunctionHash(operation) {
  return sha256(operation.func.toXDR());
}

function assertCreateOnly(transaction, step, prepared = false) {
  if (!(transaction instanceof Transaction) || transaction.source !== deployer
    || transaction.operations.length !== 1) {
    throw new Error(`${step.id} has an unexpected envelope shape.`);
  }
  const operation = transaction.operations[0];
  if (!operation || operation.type !== "invokeHostFunction"
    || operation.func.type !== "hostFunctionTypeCreateContractV2"
    || hostFunctionHash(operation) !== step.hostFunctionHash) {
    throw new Error(`${step.id} is not the preflight-pinned createContractV2 host function.`);
  }
  if (!prepared && operation.auth.length !== 0) {
    throw new Error(`${step.id} raw transaction unexpectedly contains Soroban auth.`);
  }
  if (prepared) {
    if (operation.auth.length !== 1) throw new Error(`${step.id} must contain one source auth entry.`);
    const auth = inspectAuthEntry(operation.auth[0]);
    if (auth.credentialType !== "sourceAccount" || auth.address !== null
      || auth.invocation.function.type !== "sorobanAuthorizedFunctionTypeCreateContractV2HostFn"
      || auth.invocation.subInvocations.length !== 0
      || sha256(auth.invocation.function.value.toXDR()) !== sha256(operation.func.value.toXDR())) {
      throw new Error(`${step.id} contains unexpected authorization.`);
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

function signWithSecureStore(transactionXdr) {
  const signedXdr = execFileSync(
    "stellar", ["tx", "sign", "--quiet", "--sign-with-key", identityAlias, "--network", "testnet"],
    { cwd: root, encoding: "utf8", input: `${transactionXdr}\n`, maxBuffer: 2 * 1024 * 1024,
      stdio: ["pipe", "pipe", "inherit"] },
  ).trim();
  if (!signedXdr) throw new Error("Stellar CLI returned no signed transaction.");
  return signedXdr;
}

async function writeJsonAtomic(path, value, mode = 0o600) {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
  await rename(temporaryPath, path);
}

const preflight = JSON.parse(await readFile(preflightPath, "utf8"));
if (preflight.sourceRevision !== sourceRevision || preflight.deployer !== deployer
  || preflight.resources.totalFeeStroops !== "583899" || preflight.steps.length !== steps.length) {
  throw new Error("Committed instance preflight does not match the approved deployment.");
}
for (const [index, step] of steps.entries()) {
  const approved = preflight.steps[index];
  if (approved.stepId !== step.id || approved.contractId !== step.contractId
    || approved.hostFunctionHash !== step.hostFunctionHash || approved.wasmSha256 !== step.wasmSha256) {
    throw new Error(`Committed preflight differs for ${step.id}.`);
  }
}

const cliAddress = execFileSync("stellar", ["keys", "public-key", identityAlias], {
  cwd: root, encoding: "utf8",
}).trim();
if (cliAddress !== deployer) throw new Error("Secure-store identity does not match the approved deployer.");

const server = new rpc.Server(rpcUrl);
const results = [];
let projectedTotalFee = 0n;
let chargedTotalFee = 0n;

for (const step of steps) {
  const wasm = await readFile(resolve(root, step.wasmPath));
  if (sha256(wasm) !== step.wasmSha256) throw new Error(`${step.artifact} differs from its pinned WASM.`);
  const networkWasm = await server.getContractWasmByHash(Buffer.from(step.wasmSha256, "hex"));
  if (networkWasm.byteLength !== wasm.byteLength || sha256(networkWasm) !== step.wasmSha256) {
    throw new Error(`${step.artifact} network WASM verification failed.`);
  }

  const spec = contract.Spec.fromWasm(wasm);
  const constructorArgs = step.artifact === "treasuryControllerV2"
    ? spec.funcArgsToScVals("__constructor", {
      standard_asset: dependencies.standardAsset,
      agent_account_wasm_hash: Buffer.from(dependencies.agentAccountWasmHash, "hex"),
      budget_transition_verifier: dependencies.budgetTransitionVerifier,
      private_root_backing_verifier: dependencies.privateRootBackingVerifier,
      private_binding_verifier: dependencies.privateBindingVerifier,
      spp_pool: dependencies.sppPool,
    })
    : spec.funcArgsToScVals("__constructor", {
      controller: steps[0].contractId,
      verification_key: await auditVerificationKey(step),
    });
  const operation = Operation.createCustomContract({
    address: new Address(deployer), constructorArgs,
    salt: deterministicSalt(step.id), wasmHash: Buffer.from(step.wasmSha256, "hex"),
  });
  const account = await server.getAccount(deployer);
  const raw = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(operation).setTimeout(300).build();
  assertCreateOnly(raw, step);
  const simulation = await server.simulateTransaction(raw);
  if (rpc.Api.isSimulationError(simulation)) throw new Error(`${step.id} simulation failed: ${simulation.error}`);
  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
    throw new Error(`${step.id} simulation did not complete.`);
  }
  const prepared = rpc.assembleTransaction(raw, simulation).build();
  assertCreateOnly(prepared, step, true);
  const contractId = Address.fromScVal(simulation.result.retval).toString();
  if (contractId !== step.contractId) throw new Error(`${step.id} produced an unexpected contract ID.`);
  projectedTotalFee += BigInt(prepared.fee);
  if (projectedTotalFee > totalFeeCeilingStroops) {
    throw new Error(`Projected fees exceed the approved ${totalFeeCeilingStroops}-stroop ceiling.`);
  }

  const signedXdr = signWithSecureStore(prepared.toXDR());
  const signed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
  assertCreateOnly(signed, step, true);
  if (signed.signatures.length !== 1) throw new Error(`${step.id} must have one deployer signature.`);
  const signature = signed.signatures[0]?.signature;
  if (!signature || !Keypair.fromPublicKey(deployer).verify(signed.hash(), signature)) {
    throw new Error(`${step.id} signature verification failed.`);
  }
  const submitted = await server.sendTransaction(signed);
  if (submitted.status === "ERROR" || submitted.status === "TRY_AGAIN_LATER") {
    throw new Error(`Testnet rejected ${step.id} with ${submitted.status}.`);
  }
  const final = await server.pollTransaction(submitted.hash, { attempts: 60 });
  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`${step.id} ended with ${final.status}.`);
  const deployedWasm = await server.getContractWasmByContractId(contractId);
  if (deployedWasm.byteLength !== wasm.byteLength || sha256(deployedWasm) !== step.wasmSha256) {
    throw new Error(`${step.id} deployed an unexpected WASM artifact.`);
  }
  const feeChargedStroops = final.resultXdr.feeCharged.toString();
  chargedTotalFee += BigInt(feeChargedStroops);
  const result = {
    stepId: step.id, artifact: step.artifact, contractId,
    wasmSha256: step.wasmSha256, hostFunctionHash: step.hostFunctionHash,
    saltSha256: deterministicSalt(step.id).toString("hex"),
    resource: resourceSnapshot(simulation, prepared),
    safety: { allowance: false, assetMovement: false, constructorInvocation: true,
      hostFunction: "createContractV2", operationCount: 1 },
    transaction: { hash: submitted.hash, ledger: final.ledger, feeChargedStroops,
      maximumFeeStroops: prepared.fee, status: "SUCCESS" },
  };
  results.push(result);
  await writeJsonAtomic(progressPath, { schemaVersion: 1, sourceRevision, network: "testnet", steps: results });
}

const controllerReads = {
  protocolVersion: (await server.queryContract(steps[0].contractId, "protocol_version")).result,
  storageSchemaVersion: (await server.queryContract(steps[0].contractId, "storage_schema_version")).result,
  standardAsset: (await server.queryContract(steps[0].contractId, "get_standard_asset")).result,
  agentAccountWasmHash: Buffer.from(
    (await server.queryContract(steps[0].contractId, "get_agent_account_wasm_hash")).result,
  ).toString("hex"),
  budgetTransitionVerifier: (await server.queryContract(steps[0].contractId, "get_budget_transition_verifier")).result,
  privateRootBackingVerifier: (await server.queryContract(steps[0].contractId, "get_root_backing_verifier")).result,
  privateBindingVerifier: (await server.queryContract(steps[0].contractId, "get_private_binding_verifier")).result,
  sppPool: (await server.queryContract(steps[0].contractId, "get_spp_pool")).result,
};
const expectedReads = { protocolVersion: 1, storageSchemaVersion: 2, ...dependencies };
for (const [key, expected] of Object.entries(expectedReads)) {
  if (controllerReads[key] !== expected) throw new Error(`Controller readback mismatch: ${key}.`);
}
const auditController = (await server.queryContract(steps[1].contractId, "get_controller")).result;
if (auditController !== steps[0].contractId) throw new Error("Audit verifier is not pinned to the new controller.");

const evidence = {
  schemaVersion: 1, recordedAt: new Date().toISOString(), sourceRevision,
  network: "testnet", networkPassphrase: Networks.TESTNET, rpcUrl,
  deployer: { address: deployer,
    authority: "none after creation; constructors pin dependencies and expose no deployer/admin authority" },
  approval: { scope: "two preflight-pinned createContractV2 constructors; no asset movement",
    approvedTotalPreflightStroops: "583899", approvedTotalGuardrailStroops: totalFeeCeilingStroops.toString() },
  dependencies, verificationKey: preflight.verificationKey,
  scope: { allowance: false, assetMovement: false, constructorInvocation: true, signed: true, submitted: true },
  steps: results,
  resources: { transactionCount: results.length, projectedFeeStroops: projectedTotalFee.toString(),
    feeChargedStroops: chargedTotalFee.toString(),
    feeChargedXlm: (Number(chargedTotalFee) / 10_000_000).toFixed(7) },
  verification: { controller: controllerReads, auditVerifierController: auditController,
    contractWasmHashes: "verified", transactionStatus: "SUCCESS" },
};
await writeJsonAtomic(evidencePath, evidence, 0o644);
console.log(JSON.stringify({ status: "success", ...evidence }, null, 2));
