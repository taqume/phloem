import { randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  EncryptedSppPrivateDepositPlanner,
  LocalGroth16ProofWorker,
  NativeSppDepositProcess,
  NativeSppDepositRuntimeBridge,
  PINNED_SPP_POOL,
  PrivateSessionActivationPlanner,
  StellarSppDepositConfirmationSource,
  TreasuryPrivacyKeyManager,
} from "@phloem/privacy-runtime";
import { networkId, toHex } from "@phloem/protocol-types";
import { Client } from "@phloem/treasury-controller-client";
import {
  Address,
  Asset,
  Transaction,
  TransactionBuilder,
  inspectAuthEntry,
  rpc,
} from "@stellar/stellar-sdk";

import { PHLOEM_NETWORK } from "../network";
import type {
  PreparedPrivateActivation,
  PrivateActivationConfirmation,
  PrivateActivationConfirmationInput,
} from "../private-activation-types";
import { openEncryptedAgentIdentityVault } from "./live-agent-runtime";

const PRIVATE_FUNDING_AMOUNT_ATOMIC = 10_000_000n;
const PRIVATE_ACTIVATION_FEE_CEILING_STROOPS = 10_000_000n;
const ROOT_BACKING_PUBLIC_INPUTS = 7;

function repositoryRoot(): string {
  const cwd = process.cwd();
  return basename(cwd) === "web" && basename(dirname(cwd)) === "apps"
    ? resolve(cwd, "../..")
    : cwd;
}

function canonicalBytes32(value: unknown, label: string): Buffer {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be 32-byte lowercase hexadecimal`);
  }
  return Buffer.from(value, "hex");
}

function fundingDisplay(value: bigint): string {
  const whole = value / 10_000_000n;
  const fractional = (value % 10_000_000n).toString().padStart(7, "0");
  return `${whole}.${fractional}`;
}

function rootBackingArtifacts(root: string) {
  const setup = join(root, ".phloem/private-root-backing-setup");
  return Object.freeze({
    wasmPath: join(setup, "PrivateRootBackingV1_js/PrivateRootBackingV1.wasm"),
    zkeyPath: join(setup, "root_backing_final.zkey"),
    verificationKeyPath: join(setup, "verification_key.json"),
    publicInputCount: ROOT_BACKING_PUBLIC_INPUTS,
  });
}

async function nativeBridgeBinary(root: string): Promise<string> {
  const path = process.env.PHLOEM_SPP_DEPOSIT_BRIDGE_BIN
    || join(root, "tools/spp-runtime-probe/target/release/spp-deposit-bridge");
  const metadata = await lstat(path).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new Error("pinned native SPP deposit bridge is missing; build the release binary first");
  }
  return path;
}

async function activationPlanner() {
  const root = repositoryRoot();
  const { store } = await openEncryptedAgentIdentityVault();
  try {
    const treasuryKeys = new TreasuryPrivacyKeyManager(store);
    const bridge = new NativeSppDepositRuntimeBridge({
      process: new NativeSppDepositProcess({
        binaryPath: await nativeBridgeBinary(root),
        workingDirectory: root,
      }),
      confirmationSource: new StellarSppDepositConfirmationSource(PHLOEM_NETWORK.rpcUrl),
    });
    return Object.freeze({
      store,
      planner: new PrivateSessionActivationPlanner({
        store,
        treasuryKeys,
        proofWorker: new LocalGroth16ProofWorker({
          snarkJsCli: join(root, "node_modules/snarkjs/build/cli.cjs"),
        }),
        rootBackingArtifacts: rootBackingArtifacts(root),
        spp: new EncryptedSppPrivateDepositPlanner({ treasuryKeys, bridge }),
        sppPool: PHLOEM_NETWORK.sppPoolId,
        random: { bytes: (length: number) => randomBytes(length) },
      }),
    });
  } catch (error: unknown) {
    store.close();
    throw error;
  }
}

function assertActivationEnvelope(transaction: Transaction): void {
  if (transaction.source !== PHLOEM_NETWORK.companyFundingPublicKey || transaction.operations.length !== 1) {
    throw new Error("PRIVATE activation has an unexpected source or operation count");
  }
  const operation = transaction.operations[0];
  if (!operation
    || operation.type !== "invokeHostFunction"
    || operation.func.type !== "hostFunctionTypeInvokeContract") {
    throw new Error("PRIVATE activation is not one contract invocation");
  }
  const invocation = operation.func.invokeContract;
  if (Address.fromScAddress(invocation.contractAddress).toString() !== PHLOEM_NETWORK.treasuryControllerId
    || invocation.functionName.toString() !== "activate_private_session") {
    throw new Error("PRIVATE activation targets an unexpected contract function");
  }
  const auth = operation.auth ?? [];
  if (auth.length !== 1) throw new Error("PRIVATE activation must contain one company authorization tree");
  const inspected = inspectAuthEntry(auth[0]!);
  if (inspected.credentialType !== "sourceAccount"
    || inspected.address !== null
    || inspected.invocation.function.type !== "sorobanAuthorizedFunctionTypeContractFn") {
    throw new Error("PRIVATE activation is not source-account authorized");
  }
  const authorized = inspected.invocation.function.value;
  if (Address.fromScAddress(authorized.contractAddress).toString() !== PHLOEM_NETWORK.treasuryControllerId
    || authorized.functionName.toString() !== "activate_private_session") {
    throw new Error("company authorization is not rooted at PRIVATE activation");
  }
}

function client(publicKey: string): Client {
  return new Client({
    contractId: PHLOEM_NETWORK.treasuryControllerId,
    networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
    rpcUrl: PHLOEM_NETWORK.rpcUrl,
    publicKey,
  });
}

export async function preparePrivateActivation(input: {
  readonly company: string;
  readonly sessionId: string;
}): Promise<PreparedPrivateActivation> {
  if (input.company !== PHLOEM_NETWORK.companyFundingPublicKey) {
    throw new Error("connected company account does not match the controlled Testnet wallet");
  }
  const sessionId = canonicalBytes32(input.sessionId, "session id");
  const server = new rpc.Server(PHLOEM_NETWORK.rpcUrl);
  const controller = client(input.company);
  const [sessionRead, latest] = await Promise.all([
    controller.get_session({ session_id: sessionId }),
    server.getLatestLedger(),
  ]);
  const session = sessionRead.result;
  const expectedAsset = new Asset(PHLOEM_NETWORK.assetCode, PHLOEM_NETWORK.assetIssuer)
    .contractId(PHLOEM_NETWORK.networkPassphrase);
  if (!session
    || session.company !== input.company
    || session.lifecycle.tag !== "Draft"
    || session.safety.tag !== "Normal"
    || session.settlement_mode.tag !== "Private"
    || session.asset !== expectedAsset
    || session.expires_at_ledger <= latest.sequence) {
    throw new Error("session is not an unexpired canonical PRIVATE draft");
  }
  if (PHLOEM_NETWORK.sppPoolId !== PINNED_SPP_POOL) {
    throw new Error("configured SPP pool differs from the pinned native bridge");
  }

  const rootNodeId = randomBytes(32);
  const rootNoteId = randomBytes(32);
  const runtime = await activationPlanner();
  let operationId: Buffer | undefined;
  try {
    const prepared = await runtime.planner.prepare({
      sessionId,
      company: input.company,
      networkId: networkId(PHLOEM_NETWORK.networkPassphrase),
      treasuryController: PHLOEM_NETWORK.treasuryControllerId,
      asset: expectedAsset,
      policyHash: session.policy_hash,
      rootNodeId,
      rootNoteId,
      fundingAmountAtomic: PRIVATE_FUNDING_AMOUNT_ATOMIC,
      createdAtUnixMs: Date.now(),
    });
    operationId = prepared.operationId;
    const assembled = await controller.activate_private_session({
      session_id: sessionId,
      input: prepared.input,
      backing_proof: prepared.backingProof,
    }, { timeoutInSeconds: 600 });
    if (!assembled.built || assembled.isReadCall || assembled.needsNonInvokerSigningBy().length !== 0) {
      throw new Error("PRIVATE activation simulation did not produce one source-authorized write");
    }
    assertActivationEnvelope(assembled.built);
    if (BigInt(assembled.built.fee) > PRIVATE_ACTIVATION_FEE_CEILING_STROOPS) {
      throw new Error("PRIVATE activation fee exceeds the approved P0 ceiling");
    }
    const resources = assembled.simulationData.transactionData.resources;
    return Object.freeze({
      transactionXdr: assembled.toXdr(),
      transactionHash: toHex(assembled.built.hash()),
      operationId: toHex(prepared.operationId),
      sessionId: input.sessionId,
      rootNodeId: toHex(rootNodeId),
      rootNoteId: toHex(rootNoteId),
      fundingAmountAtomic: PRIVATE_FUNDING_AMOUNT_ATOMIC.toString(),
      fundingAmountDisplay: fundingDisplay(PRIVATE_FUNDING_AMOUNT_ATOMIC),
      assetCode: "USDC" as const,
      assetIssuer: PHLOEM_NETWORK.assetIssuer,
      resource: Object.freeze({
        envelopeBytes: Buffer.from(assembled.toXdr(), "base64").byteLength,
        instructions: resources.instructions,
        diskReadBytes: resources.diskReadBytes,
        writeBytes: resources.writeBytes,
        readOnlyEntries: resources.footprint.readOnly.length,
        readWriteEntries: resources.footprint.readWrite.length,
        maximumFeeStroops: assembled.built.fee,
        approvedFeeCeilingStroops: PRIVATE_ACTIVATION_FEE_CEILING_STROOPS.toString(),
      }),
      safety: Object.freeze({
        operationCount: 1 as const,
        contractId: PHLOEM_NETWORK.treasuryControllerId,
        functionName: "activate_private_session" as const,
        companyAuthorization: "source-account" as const,
        sppPool: PHLOEM_NETWORK.sppPoolId,
        assetMovement: true as const,
      }),
    });
  } catch (error: unknown) {
    if (operationId) await runtime.planner.abort(operationId).catch(() => undefined);
    throw error;
  } finally {
    runtime.store.close();
  }
}

export async function confirmPrivateActivation(
  input: PrivateActivationConfirmationInput,
): Promise<PrivateActivationConfirmation> {
  const transactionHash = canonicalBytes32(input.transactionHash, "transaction hash");
  const operationId = canonicalBytes32(input.operationId, "operation id");
  const sessionId = canonicalBytes32(input.sessionId, "session id");
  const server = new rpc.Server(PHLOEM_NETWORK.rpcUrl);
  const final = await server.getTransaction(input.transactionHash);
  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error("PRIVATE activation transaction is not confirmed successfully");
  }
  const transaction = TransactionBuilder.fromXDR(final.envelopeXdr, PHLOEM_NETWORK.networkPassphrase);
  if (!(transaction instanceof Transaction)) throw new Error("PRIVATE activation is not a classic transaction envelope");
  assertActivationEnvelope(transaction);

  const runtime = await activationPlanner();
  try {
    const staged = (await runtime.store.readSnapshot()).privateSessionActivations.find(
      (candidate) => candidate.operationId === input.operationId && candidate.sessionId === input.sessionId,
    );
    if (!staged) throw new Error("prepared PRIVATE activation state was not found");
    const sessionRead = await client(PHLOEM_NETWORK.companyFundingPublicKey).get_session({ session_id: sessionId });
    const session = sessionRead.result;
    if (!session
      || session.lifecycle.tag !== "Active"
      || toHex(session.id) !== input.sessionId
      || toHex(session.root_budget_node_id ?? Buffer.alloc(0)) !== staged.rootBudgetNote.nodeId
      || toHex(session.root_budget_note_id ?? Buffer.alloc(0)) !== staged.rootBudgetNote.noteId
      || session.treasury_spp_key_commitment?.toString() !== (await runtime.store.readSnapshot())
        .treasuryPrivacyKeys.find((key) => key.sessionId === input.sessionId)?.commitment) {
      throw new Error("canonical PRIVATE activation state differs from the encrypted preparation");
    }
    await runtime.planner.confirm({
      operationId,
      transactionHash,
      ledgerSequence: final.ledger,
    });
    const confirmed = (await runtime.store.readSnapshot()).sppTreasuryNotes.find(
      (note) => note.sessionId === input.sessionId && note.confirmation?.transactionHash === input.transactionHash,
    );
    if (!confirmed?.leafIndex && confirmed?.leafIndex !== 0) {
      throw new Error("confirmed SPP funding note is missing its canonical leaf index");
    }
    return Object.freeze({
      transactionHash: input.transactionHash,
      ledger: final.ledger,
      feeChargedStroops: final.resultXdr.feeCharged.toString(),
      sessionId: input.sessionId,
      lifecycle: "Active" as const,
      rootNodeId: staged.rootBudgetNote.nodeId,
      rootNoteId: staged.rootBudgetNote.noteId,
      fundingLeafIndex: confirmed.leafIndex,
    });
  } finally {
    runtime.store.close();
  }
}

export async function abortPrivateActivation(input: {
  readonly operationId: string;
  readonly sessionId: string;
}): Promise<void> {
  const operationId = canonicalBytes32(input.operationId, "operation id");
  const sessionId = canonicalBytes32(input.sessionId, "session id");
  const runtime = await activationPlanner();
  try {
    const staged = (await runtime.store.readSnapshot()).privateSessionActivations.find(
      (candidate) => candidate.operationId === input.operationId && candidate.sessionId === input.sessionId,
    );
    if (!staged) throw new Error("prepared PRIVATE activation state was not found");
    const session = (await client(PHLOEM_NETWORK.companyFundingPublicKey).get_session({ session_id: sessionId })).result;
    if (!session || session.lifecycle.tag !== "Draft") {
      throw new Error("prepared activation cannot be discarded after the session leaves Draft");
    }
    await runtime.planner.abort(operationId);
  } finally {
    runtime.store.close();
  }
}
