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
const SOURCE_REVISION = "27ea0e36ea42a975b824eec568522fe70d316806";
const EVIDENCE_PATH = resolve(REPO_ROOT, "evidence", "testnet", "phloem-instance-preflight.json");
const DEPLOYMENT_EVIDENCE_PATH = resolve(REPO_ROOT, "evidence", "testnet", "phloem-instance-deployment.json");
const PROGRESS_PATH = resolve(REPO_ROOT, "deployments", "local", "phloem-instance-testnet-progress.json");
const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const SPP_POOL = "CC57FDSWPIHALXW2XWVSKEA7FA72Z37Y7AP5ASRY6V3CXAZCWQAOSLB4";
const AGENT_ACCOUNT_WASM_HASH = "0a9d54d3bf278131cf2239e1db52eee54f057d4e3241a6aafc2b28bca22d156d";
const BN254_BASE_FIELD_MODULUS =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;
// Refreshed after four confirmed creates: 1% over the final 1,445,403-stroop projection.
const TOTAL_FEE_CEILING_STROOPS = 1_459_858n;

const STEPS = [
  {
    id: "create-ed25519-verifier",
    artifact: "ed25519Verifier",
    expectedContractId: "CC3HSAEYBR5EHKVFQ2QUYZ3HWFIDDPNEQ2JT5EB2ZXWS3M34ITJ25NRR",
    wasmPath: "target/wasm32v1-none/release/phloem_ed25519_verifier.wasm",
    wasmSha256: "aa15e1a91fd5d41a755b5321f97bb4290e0db4595dd4408e2e89f16d4d066600",
  },
  {
    id: "create-budget-transition-verifier-v1",
    artifact: "budgetTransitionVerifierV1",
    expectedContractId: "CD3GQVHD4R3E4WMFEFB6H5IJJUZXYE3IFFNY65P2J3L2V6R6A6FTJQ4O",
    wasmPath: "target/wasm32v1-none/release/phloem_budget_transition_verifier.wasm",
    wasmSha256: "0e068ff97a66fb5056c7249444e2b31762dc1ae9031a725d7f5ae8f1676ddb0d",
    verificationKeyPath: ".phloem/budget-transition-setup/verification_key.json",
    verificationKeySha256: "52d999f482d0309fe332ff042250385419568d2d4d07e97e775439938955d772",
    publicInputCount: 8,
  },
  {
    id: "create-private-root-backing-verifier-v1",
    artifact: "privateRootBackingVerifierV1",
    expectedContractId: "CBR7ZUMSLGWHUJBL7YKL2HRTYAWB34CPM5MG5OFYANENMOTCBHH3A5PA",
    wasmPath: "target/wasm32v1-none/release/phloem_private_root_backing_verifier.wasm",
    wasmSha256: "779d500e9afcf7d07eac315ae41ecc4e23df581dfceec2fd5a7668d45a270005",
    verificationKeyPath: ".phloem/private-root-backing-setup/verification_key.json",
    verificationKeySha256: "36cd9762d1ffcdd5d32c35f11d31e707a03fc1738a6432439a576923e590fb8c",
    publicInputCount: 7,
  },
  {
    id: "create-private-settlement-binding-verifier-v1",
    artifact: "privateSettlementBindingVerifierV1",
    expectedContractId: "CA5MLD4MNE2S3TQ3C47PARFSWL3XPXTQS5HQHS7ZDGTKXB7TMVNXVRRW",
    wasmPath: "target/wasm32v1-none/release/phloem_private_settlement_binding_verifier.wasm",
    wasmSha256: "058079beb6e94dec7bfc594c3a2f21554af82d4bdd62a8fa70689d8ba0c72029",
    verificationKeyPath: ".phloem/private-binding-setup/verification_key.json",
    verificationKeySha256: "c727f8b2656231bd50cb0139bde6e998e4f922766f2d351d76ddb88e322c485d",
    publicInputCount: 16,
  },
  {
    id: "create-treasury-controller",
    artifact: "treasuryController",
    expectedContractId: "CDSG6DMWDPFDIBEXFSNTONEDDJ4CCNP2UJZJUFTRGX63ZDZMRGMZFHAH",
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
  if (!signedXdr) throw new Error("Stellar CLI returned no signed instance transaction.");
  return signedXdr;
}

async function writeJsonAtomic(path, value, mode = 0o600) {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
  await rename(temporaryPath, path);
}

async function readProgress() {
  try {
    const progress = JSON.parse(await readFile(PROGRESS_PATH, "utf8"));
    if (
      progress.schemaVersion !== 1
      || progress.sourceRevision !== SOURCE_REVISION
      || progress.network !== "testnet"
      || progress.deployer !== DEPLOYER
      || progress.assetMovement !== false
      || !Array.isArray(progress.steps)
      || progress.steps.length > STEPS.length
    ) {
      throw new Error("Local instance progress does not match the pinned deployment.");
    }
    progress.steps.forEach((result, index) => {
      const expected = STEPS[index];
      if (
        !expected
        || result.stepId !== expected.id
        || result.artifact !== expected.artifact
        || result.contractId !== expected.expectedContractId
        || result.wasmSha256 !== expected.wasmSha256
        || result.transaction?.status !== "SUCCESS"
      ) {
        throw new Error("Local instance progress contains an unexpected completed step.");
      }
    });
    return progress.steps;
  } catch (reason) {
    if (reason?.code === "ENOENT") return [];
    throw reason;
  }
}

const server = new rpc.Server(RPC_URL);
const execute = process.argv.includes("--execute");
if (execute) {
  const cliAddress = execFileSync("stellar", ["keys", "public-key", IDENTITY_ALIAS], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  if (cliAddress !== DEPLOYER) throw new Error("Secure-store identity does not match the approved instance deployer.");
}
const results = [];
const contractIds = {};
let projectedTotalFee = 0n;
let chargedTotalFee = 0n;
const completedSteps = execute ? await readProgress() : [];

for (const step of STEPS) {
  const wasm = await verifiedFile(step.wasmPath, step.wasmSha256);
  const networkWasm = await server.getContractWasmByHash(Buffer.from(step.wasmSha256, "hex"));
  if (sha256(networkWasm) !== step.wasmSha256 || networkWasm.byteLength !== wasm.byteLength) {
    throw new Error(`Testnet WASM differs for ${step.artifact}.`);
  }
  const completed = completedSteps[results.length];
  if (completed) {
    const [deployedWasm, transaction] = await Promise.all([
      server.getContractWasmByContractId(completed.contractId),
      server.getTransaction(completed.transaction.hash),
    ]);
    if (sha256(deployedWasm) !== step.wasmSha256 || deployedWasm.byteLength !== wasm.byteLength) {
      throw new Error(`Completed ${step.id} instance has an unexpected WASM artifact.`);
    }
    if (
      transaction.status !== rpc.Api.GetTransactionStatus.SUCCESS
      || transaction.ledger !== completed.transaction.ledger
      || transaction.resultXdr.feeCharged.toString() !== completed.transaction.feeChargedStroops
    ) {
      throw new Error(`Completed ${step.id} transaction evidence failed Testnet verification.`);
    }
    contractIds[step.artifact] = completed.contractId;
    projectedTotalFee += BigInt(completed.resource.totalFeeStroops);
    chargedTotalFee += BigInt(completed.transaction.feeChargedStroops);
    results.push(completed);
    continue;
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
  const account = await server.getAccount(DEPLOYER);
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
  if (contractId !== step.expectedContractId) throw new Error(`${step.id} produced an unexpected deterministic contract ID.`);
  projectedTotalFee += BigInt(prepared.fee);
  if (projectedTotalFee > TOTAL_FEE_CEILING_STROOPS) {
    throw new Error(
      `Projected instance fees ${projectedTotalFee} exceed the approved ${TOTAL_FEE_CEILING_STROOPS}-stroop total ceiling.`,
    );
  }
  contractIds[step.artifact] = contractId;
  const result = {
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
      submitted: execute,
    },
  };

  if (execute) {
    const signedXdr = signWithSecureStore(prepared.toXDR());
    const signed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
    assertCreateOnly(signed, expectedHostFunctionHash, true);
    if (signed.signatures.length !== 1) throw new Error(`Expected one envelope signature for ${step.id}.`);
    const signature = signed.signatures[0];
    if (!signature || !Keypair.fromPublicKey(DEPLOYER).verify(signed.hash(), signature.signature)) {
      throw new Error(`Secure-store signature verification failed for ${step.id}.`);
    }
    const submitted = await server.sendTransaction(signed);
    if (submitted.status === "ERROR") throw new Error(`Testnet rejected ${step.id}.`);
    if (submitted.status === "TRY_AGAIN_LATER") throw new Error(`Testnet asked ${step.id} to retry later.`);
    const final = await server.pollTransaction(submitted.hash, { attempts: 60 });
    if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`${step.id} ended with ${final.status}.`);
    }
    const deployedWasm = await server.getContractWasmByContractId(contractId);
    if (sha256(deployedWasm) !== step.wasmSha256 || deployedWasm.byteLength !== wasm.byteLength) {
      throw new Error(`${step.id} deployed an unexpected WASM artifact.`);
    }
    const feeChargedStroops = final.resultXdr.feeCharged.toString();
    chargedTotalFee += BigInt(feeChargedStroops);
    result.transaction = {
      hash: submitted.hash,
      ledger: final.ledger,
      feeChargedStroops,
      maximumFeeStroops: prepared.fee,
      approvedTotalFeeCeilingStroops: TOTAL_FEE_CEILING_STROOPS.toString(),
      status: "SUCCESS",
    };
  }

  results.push(result);
  if (execute) {
    await writeJsonAtomic(PROGRESS_PATH, {
      schemaVersion: 1,
      status: results.length === STEPS.length ? "complete" : "in_progress",
      recordedAt: new Date().toISOString(),
      sourceRevision: SOURCE_REVISION,
      network: "testnet",
      deployer: DEPLOYER,
      assetMovement: false,
      steps: results,
    });
  }
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
    signed: execute,
    submitted: execute,
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
    approvedFeeCeilingStroops: TOTAL_FEE_CEILING_STROOPS.toString(),
    ...(execute ? {
      feeChargedStroops: chargedTotalFee.toString(),
      feeChargedXlm: (Number(chargedTotalFee) / 10_000_000).toFixed(7),
    } : {}),
  },
};

await writeJsonAtomic(execute ? DEPLOYMENT_EVIDENCE_PATH : EVIDENCE_PATH, evidence, execute ? 0o600 : 0o644);
console.log(JSON.stringify({ status: execute ? "success" : "simulation_only", ...evidence }, null, 2));
