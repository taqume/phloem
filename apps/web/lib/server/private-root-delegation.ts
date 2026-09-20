import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

import { LocalGroth16ProofWorker } from "@phloem/privacy-runtime";
import { PrivateBudgetDelegationProofPlanner } from "@phloem/privacy-runtime/delegation";
import type { EncryptedPrivacyStateStore } from "@phloem/privacy-runtime/state-store";
import { networkId, toHex } from "@phloem/protocol-types";
import { Client, type BudgetNode, type BudgetNoteState, type Session } from "@phloem/treasury-controller-client";
import {
  Address,
  Transaction,
  TransactionBuilder,
  inspectAuthEntry,
  rpc,
} from "@stellar/stellar-sdk";

import { PHLOEM_NETWORK } from "../network";
import type {
  PreparedPrivateRootDelegation,
  PrivateRootDelegationConfirmation,
} from "../private-root-delegation-types";
import { openEncryptedAgentIdentityVault } from "./live-agent-runtime";

const SUPERVISOR_CATEGORY_MASK = 4n;
const SUPERVISOR_ALLOWED_ACTIONS_MASK = 5n;
const SUPERVISOR_DELEGATION_DEPTH = 1;
const ROOT_DELEGATION_FEE_CEILING_STROOPS = 10_000_000n;

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

function controller(publicKey = PHLOEM_NETWORK.companyFundingPublicKey): Client {
  return new Client({
    contractId: PHLOEM_NETWORK.treasuryControllerId,
    networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
    rpcUrl: PHLOEM_NETWORK.rpcUrl,
    publicKey,
  });
}

function assertRootState(input: {
  readonly sessionId: string;
  readonly session: Session;
  readonly note: BudgetNoteState;
  readonly node: BudgetNode;
  readonly opening: Readonly<{
    noteId: string;
    nodeId: string;
    owner: string;
    commitment: string;
    policyHash: string;
    contextHash: string;
  }>;
  readonly contextHash: bigint;
  readonly latestLedger: number;
}): void {
  if (toHex(input.session.id) !== input.sessionId
    || input.session.lifecycle.tag !== "Active"
    || input.session.safety.tag !== "Normal"
    || input.session.settlement_mode.tag !== "Private"
    || input.session.expires_at_ledger <= input.latestLedger
    || toHex(input.session.root_budget_note_id ?? Buffer.alloc(0)) !== input.opening.noteId
    || toHex(input.session.root_budget_node_id ?? Buffer.alloc(0)) !== input.opening.nodeId
    || input.note.state.tag !== "Active"
    || input.note.owner.tag !== "RootCompany"
    || input.node.state.tag !== "Active"
    || input.node.owner.tag !== "RootCompany"
    || input.node.branch_frozen
    || toHex(input.note.id) !== input.opening.noteId
    || toHex(input.note.node_id) !== input.opening.nodeId
    || toHex(input.node.id) !== input.opening.nodeId
    || input.note.commitment.toString() !== input.opening.commitment
    || input.note.policy_hash.toString() !== input.opening.policyHash
    || input.contextHash.toString() !== input.opening.contextHash) {
    throw new Error("encrypted root opening differs from canonical PRIVATE authority");
  }
}

function assertDelegationEnvelope(transaction: Transaction): void {
  if (transaction.source !== PHLOEM_NETWORK.companyFundingPublicKey || transaction.operations.length !== 1) {
    throw new Error("root delegation has an unexpected source or operation count");
  }
  const operation = transaction.operations[0];
  if (!operation
    || operation.type !== "invokeHostFunction"
    || operation.func.type !== "hostFunctionTypeInvokeContract") {
    throw new Error("root delegation is not one contract invocation");
  }
  const invocation = operation.func.invokeContract;
  if (Address.fromScAddress(invocation.contractAddress).toString() !== PHLOEM_NETWORK.treasuryControllerId
    || invocation.functionName.toString() !== "delegate_private_root") {
    throw new Error("root delegation targets an unexpected contract function");
  }
  const auth = operation.auth ?? [];
  if (auth.length !== 1) throw new Error("root delegation must contain one company authorization");
  const inspected = inspectAuthEntry(auth[0]!);
  if (inspected.credentialType !== "sourceAccount"
    || inspected.address !== null
    || inspected.invocation.subInvocations.length !== 0
    || inspected.invocation.function.type !== "sorobanAuthorizedFunctionTypeContractFn") {
    throw new Error("root delegation contains authorization beyond its company call");
  }
  const authorized = inspected.invocation.function.value;
  if (Address.fromScAddress(authorized.contractAddress).toString() !== PHLOEM_NETWORK.treasuryControllerId
    || authorized.functionName.toString() !== "delegate_private_root") {
    throw new Error("company authorization is not bound to PRIVATE root delegation");
  }
}

function delegationRuntime(store: EncryptedPrivacyStateStore) {
  const root = repositoryRoot();
  return new PrivateBudgetDelegationProofPlanner({
    store,
    proofWorker: new LocalGroth16ProofWorker({
      snarkJsCli: join(root, "node_modules/snarkjs/build/cli.cjs"),
    }),
    artifacts: {
      wasmPath: join(root, ".phloem/budget-transition-setup/BudgetTransitionV1_js/BudgetTransitionV1.wasm"),
      zkeyPath: join(root, ".phloem/budget-transition-setup/budget_transition_final.zkey"),
      verificationKeyPath: join(root, ".phloem/budget-transition-setup/verification_key.json"),
      publicInputCount: 8,
    },
    random: { bytes: (length: number) => randomBytes(length) },
  });
}

export async function preparePrivateRootDelegation(input: {
  readonly company: string;
  readonly sessionId: string;
}): Promise<PreparedPrivateRootDelegation> {
  if (input.company !== PHLOEM_NETWORK.companyFundingPublicKey) {
    throw new Error("connected company account does not match the controlled Testnet wallet");
  }
  const sessionId = canonicalBytes32(input.sessionId, "session id");
  const { store, vault } = await openEncryptedAgentIdentityVault();
  const runtime = delegationRuntime(store);
  let operationId: Buffer | undefined;
  try {
    const snapshot = await store.readSnapshot();
    const openings = snapshot.budgetNotes.filter((note) => (
      note.sessionId === input.sessionId && note.owner === input.company && note.status === "ACTIVE"
    ));
    if (openings.length !== 1) throw new Error(`expected one active root opening, found ${openings.length}`);
    const opening = openings[0]!;
    const supervisor = await vault.resolve(input.sessionId, "SUPERVISOR");
    if (supervisor.status !== "DEPLOYED" || !supervisor.contractId) {
      throw new Error("session-bound Supervisor AgentAccount is not confirmed on Testnet");
    }
    const api = controller(input.company);
    const server = new rpc.Server(PHLOEM_NETWORK.rpcUrl);
    const [sessionRead, noteRead, nodeRead, contextRead, latest] = await Promise.all([
      api.get_session({ session_id: sessionId }),
      api.get_budget_note({ note_id: Buffer.from(opening.noteId, "hex") }),
      api.get_budget_node({ node_id: Buffer.from(opening.nodeId, "hex") }),
      api.get_budget_note_context_hash({ note_id: Buffer.from(opening.noteId, "hex") }),
      server.getLatestLedger(),
    ]);
    if (!sessionRead.result || !noteRead.result || !nodeRead.result) {
      throw new Error("canonical PRIVATE root authority is unavailable");
    }
    assertRootState({
      sessionId: input.sessionId,
      session: sessionRead.result,
      note: noteRead.result,
      node: nodeRead.result,
      opening,
      contextHash: contextRead.result,
      latestLedger: latest.sequence,
    });
    const expiry = sessionRead.result.expires_at_ledger;
    const prepared = await runtime.prepare({
      sessionId,
      sourceBudgetNoteId: Buffer.from(opening.noteId, "hex"),
      sourceAgent: input.company,
      networkId: networkId(PHLOEM_NETWORK.networkPassphrase),
      treasuryController: PHLOEM_NETWORK.treasuryControllerId,
      childOwner: supervisor.contractId,
      childPolicy: {
        category_mask: SUPERVISOR_CATEGORY_MASK,
        allowed_actions_mask: SUPERVISOR_ALLOWED_ACTIONS_MASK,
        expiry,
        remaining_delegation_depth: SUPERVISOR_DELEGATION_DEPTH,
      },
      delegatedAmountAtomic: BigInt(opening.amountAtomic),
      createdAtUnixMs: Date.now(),
    });
    operationId = prepared.operationId;
    const assembled = await api.delegate_private_root({
      session_id: prepared.sessionId,
      source_note_id: prepared.sourceNoteId,
      delegation: prepared.delegation,
      proof: prepared.proof,
    }, { timeoutInSeconds: 300 });
    if (!assembled.built || assembled.isReadCall || assembled.needsNonInvokerSigningBy().length !== 0) {
      throw new Error("root delegation simulation did not produce one source-authorized write");
    }
    assertDelegationEnvelope(assembled.built);
    if (BigInt(assembled.built.fee) > ROOT_DELEGATION_FEE_CEILING_STROOPS) {
      throw new Error("root delegation fee exceeds the approved P0 ceiling");
    }
    const resources = assembled.simulationData.transactionData.resources;
    return Object.freeze({
      transactionXdr: assembled.toXdr(),
      transactionHash: toHex(assembled.built.hash()),
      operationId: toHex(prepared.operationId),
      sessionId: input.sessionId,
      sourceNoteId: opening.noteId,
      childNodeId: toHex(prepared.delegation.child_node_id),
      childNoteId: toHex(prepared.delegation.child_note_id),
      supervisor: supervisor.contractId,
      delegatedAmountAtomic: opening.amountAtomic,
      policy: Object.freeze({
        categoryMask: "4" as const,
        allowedActionsMask: "5" as const,
        remainingDelegationDepth: 1 as const,
        expiry,
      }),
      resource: Object.freeze({
        instructions: resources.instructions,
        diskReadBytes: resources.diskReadBytes,
        writeBytes: resources.writeBytes,
        envelopeBytes: Buffer.from(assembled.toXdr(), "base64").byteLength,
        maximumFeeStroops: assembled.built.fee,
        approvedFeeCeilingStroops: ROOT_DELEGATION_FEE_CEILING_STROOPS.toString(),
      }),
      safety: Object.freeze({
        operationCount: 1 as const,
        contractId: PHLOEM_NETWORK.treasuryControllerId,
        functionName: "delegate_private_root" as const,
        companyAuthorization: "source-account" as const,
        assetMovement: false as const,
      }),
    });
  } catch (error: unknown) {
    if (operationId) await runtime.abort(operationId).catch(() => undefined);
    throw error;
  } finally {
    store.close();
  }
}

export async function confirmPrivateRootDelegation(input: {
  readonly transactionHash: string;
  readonly operationId: string;
  readonly sessionId: string;
}): Promise<PrivateRootDelegationConfirmation> {
  const transactionHash = canonicalBytes32(input.transactionHash, "transaction hash");
  const operationId = canonicalBytes32(input.operationId, "operation id");
  canonicalBytes32(input.sessionId, "session id");
  const server = new rpc.Server(PHLOEM_NETWORK.rpcUrl);
  const final = await server.getTransaction(input.transactionHash);
  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error("root delegation transaction is not confirmed successfully");
  }
  const transaction = TransactionBuilder.fromXDR(final.envelopeXdr, PHLOEM_NETWORK.networkPassphrase);
  if (!(transaction instanceof Transaction)) throw new Error("root delegation is not a classic transaction envelope");
  assertDelegationEnvelope(transaction);

  const { store } = await openEncryptedAgentIdentityVault();
  const runtime = delegationRuntime(store);
  try {
    const staged = (await store.readSnapshot()).privateBudgetDelegations.find(
      (candidate) => candidate.operationId === input.operationId && candidate.sessionId === input.sessionId,
    );
    if (!staged || staged.status !== "PREPARED") throw new Error("prepared root delegation state was not found");
    const [noteRead, nodeRead] = await Promise.all([
      controller().get_budget_note({ note_id: Buffer.from(staged.childBudgetNote.noteId, "hex") }),
      controller().get_budget_node({ node_id: Buffer.from(staged.childBudgetNote.nodeId, "hex") }),
    ]);
    const note = noteRead.result;
    const node = nodeRead.result;
    if (!note || !node
      || note.state.tag !== "Active"
      || node.state.tag !== "Active"
      || note.owner.tag !== "AgentSmartAccount"
      || node.owner.tag !== "AgentSmartAccount"
      || note.owner.values[0] !== staged.childBudgetNote.owner
      || node.owner.values[0] !== staged.childBudgetNote.owner
      || note.commitment.toString() !== staged.childBudgetNote.commitment) {
      throw new Error("canonical Supervisor authority differs from the encrypted delegation");
    }
    await runtime.confirm({ operationId, transactionHash, ledgerSequence: final.ledger });
    return Object.freeze({
      transactionHash: input.transactionHash,
      ledger: final.ledger,
      feeChargedStroops: final.resultXdr.feeCharged.toString(),
      sessionId: input.sessionId,
      supervisor: staged.childBudgetNote.owner,
      childNodeId: staged.childBudgetNote.nodeId,
      childNoteId: staged.childBudgetNote.noteId,
    });
  } finally {
    store.close();
  }
}

export async function abortPrivateRootDelegation(input: {
  readonly operationId: string;
  readonly sessionId: string;
}): Promise<void> {
  const operationId = canonicalBytes32(input.operationId, "operation id");
  canonicalBytes32(input.sessionId, "session id");
  const { store } = await openEncryptedAgentIdentityVault();
  const runtime = delegationRuntime(store);
  try {
    const staged = (await store.readSnapshot()).privateBudgetDelegations.find(
      (candidate) => candidate.operationId === input.operationId && candidate.sessionId === input.sessionId,
    );
    if (!staged || staged.status !== "PREPARED") throw new Error("prepared root delegation state was not found");
    const source = (await controller().get_budget_note({
      note_id: Buffer.from(staged.sourceBudgetNoteId, "hex"),
    })).result;
    if (!source || source.state.tag !== "Active" || source.owner.tag !== "RootCompany") {
      throw new Error("root delegation cannot be discarded after canonical source consumption");
    }
    await runtime.abort(operationId);
  } finally {
    store.close();
  }
}
