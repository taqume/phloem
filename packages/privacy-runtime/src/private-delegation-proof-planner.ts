import {
  BN254_SCALAR_MODULUS,
  POSEIDON_DOMAINS,
  addressFields,
  addressFromStrKey,
  bytes32ToLimbs,
  deriveId,
  poseidon2Hash3,
  poseidon2HashFields,
  toHex,
} from "@phloem/protocol-types";
import type { Groth16Proof, NodePolicy, PrivateDelegationInput } from "@phloem/treasury-controller-client";
import { StrKey } from "@stellar/stellar-sdk";

import type { Groth16ProvingArtifacts, LocalGroth16ProofWorker } from "./local-proof-worker.js";
import type { EncryptedPrivacyStateStore } from "./privacy-state-store.js";
import type { BudgetNoteOpening, ChainConfirmation } from "./state.js";
import type { PrivateRandomSource } from "./voucher-issuer.js";

const BUDGET_NOTE_OUTPUT_KIND = 1n;
const NO_OUTPUT_KIND = 0n;
const U64_LIMIT = 1n << 64n;

export interface PrivateBudgetDelegationProofRequest {
  readonly sessionId: Uint8Array;
  readonly sourceBudgetNoteId: Uint8Array;
  readonly sourceAgent: string;
  readonly networkId: Uint8Array;
  readonly treasuryController: string;
  readonly childOwner: string;
  readonly childPolicy: NodePolicy;
  readonly delegatedAmountAtomic: bigint;
  readonly createdAtUnixMs: number;
}

export interface PreparedPrivateBudgetDelegationProof {
  readonly operationId: Buffer;
  readonly sessionId: Buffer;
  readonly sourceNoteId: Buffer;
  readonly delegation: PrivateDelegationInput;
  readonly proof: Groth16Proof;
  readonly publicSignals: readonly bigint[];
}

export class PrivateBudgetDelegationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateBudgetDelegationStateError";
  }
}

function canonicalBytes32(value: Uint8Array, label: string): Buffer {
  if (value.length !== 32) throw new RangeError(`${label} must be exactly 32 bytes`);
  return Buffer.from(value);
}

function nextPrivateId(domain: string, random: PrivateRandomSource): Buffer {
  return Buffer.from(deriveId(domain, canonicalBytes32(random.bytes(32), "private id entropy")));
}

function nextField(random: PrivateRandomSource): bigint {
  for (;;) {
    const bytes = canonicalBytes32(random.bytes(32), "private field entropy");
    bytes[0] = bytes[0]! & 0x1f;
    const value = BigInt(`0x${bytes.toString("hex")}`);
    if (value > 0n && value < BN254_SCALAR_MODULUS) return value;
  }
}

function checkedPositiveU64(value: bigint, label: string): bigint {
  if (value <= 0n || value >= U64_LIMIT) throw new RangeError(`${label} must be a positive u64`);
  return value;
}

function checkedPolicy(policy: NodePolicy): void {
  if (policy.category_mask < 0n || policy.category_mask >= U64_LIMIT
    || policy.allowed_actions_mask <= 0n || policy.allowed_actions_mask >= U64_LIMIT) {
    throw new RangeError("child policy masks must fit the P0 u64 domain");
  }
  if (!Number.isSafeInteger(policy.expiry) || policy.expiry <= 0
    || !Number.isSafeInteger(policy.remaining_delegation_depth)
    || policy.remaining_delegation_depth < 0) {
    throw new RangeError("child policy ledger bounds must be positive canonical integers");
  }
}

function budgetContextHash(input: {
  readonly networkId: Uint8Array;
  readonly treasuryController: string;
  readonly sessionId: Uint8Array;
  readonly note: Pick<BudgetNoteOpening, "nodeId" | "owner" | "asset" | "policyHash">;
  readonly noteId: Uint8Array;
}): bigint {
  return poseidon2HashFields(
    [
      1n,
      ...bytes32ToLimbs(input.networkId),
      ...addressFields(addressFromStrKey(input.treasuryController)),
      ...bytes32ToLimbs(input.sessionId),
      ...bytes32ToLimbs(Buffer.from(input.note.nodeId, "hex")),
      ...addressFields(addressFromStrKey(input.note.owner)),
      ...addressFields(addressFromStrKey(input.note.asset)),
      BigInt(input.note.policyHash),
      ...bytes32ToLimbs(input.noteId),
    ],
    POSEIDON_DOMAINS.contextInit,
    POSEIDON_DOMAINS.contextFold,
  );
}

function assertPublicSignals(actual: readonly bigint[], expected: readonly bigint[]): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new PrivateBudgetDelegationStateError(
      "local proof public signals do not match the prepared private delegation",
    );
  }
}

function confirmationMatches(actual: ChainConfirmation | undefined, expected: ChainConfirmation): boolean {
  return actual?.transactionHash === expected.transactionHash && actual.ledgerSequence === expected.ledgerSequence;
}

/** Builds and reconciles one hidden BudgetNote -> child BudgetNote + optional remainder transition. */
export class PrivateBudgetDelegationProofPlanner {
  readonly #store: EncryptedPrivacyStateStore;
  readonly #proofWorker: LocalGroth16ProofWorker;
  readonly #artifacts: Groth16ProvingArtifacts;
  readonly #random: PrivateRandomSource;

  constructor(input: {
    readonly store: EncryptedPrivacyStateStore;
    readonly proofWorker: LocalGroth16ProofWorker;
    readonly artifacts: Groth16ProvingArtifacts;
    readonly random: PrivateRandomSource;
  }) {
    this.#store = input.store;
    this.#proofWorker = input.proofWorker;
    this.#artifacts = input.artifacts;
    this.#random = input.random;
  }

  async prepare(request: PrivateBudgetDelegationProofRequest): Promise<PreparedPrivateBudgetDelegationProof> {
    const sessionId = canonicalBytes32(request.sessionId, "session id");
    const sourceNoteId = canonicalBytes32(request.sourceBudgetNoteId, "source budget note id");
    const networkId = canonicalBytes32(request.networkId, "network id");
    const delegatedAmount = checkedPositiveU64(request.delegatedAmountAtomic, "delegated amount");
    checkedPolicy(request.childPolicy);
    if (!StrKey.isValidContract(request.treasuryController)) {
      throw new TypeError("treasury controller must be a canonical C-address");
    }
    if (!StrKey.isValidContract(request.childOwner)) {
      throw new TypeError("private delegation child owner must be a canonical contract address");
    }
    if (!StrKey.isValidEd25519PublicKey(request.sourceAgent) && !StrKey.isValidContract(request.sourceAgent)) {
      throw new TypeError("private delegation source agent must be a canonical Stellar address");
    }
    if (!Number.isSafeInteger(request.createdAtUnixMs) || request.createdAtUnixMs < 0) {
      throw new RangeError("creation time must be non-negative integer milliseconds");
    }

    const operationId = nextPrivateId("PHLOEM_PRIVATE_DELEGATION_OPERATION_V1", this.#random);
    const childNodeId = nextPrivateId("PHLOEM_BUDGET_NODE_ID_V1", this.#random);
    const childNoteId = nextPrivateId("PHLOEM_BUDGET_NOTE_ID_V1", this.#random);
    const remainderNoteId = nextPrivateId("PHLOEM_BUDGET_NOTE_ID_V1", this.#random);
    const childBlinding = nextField(this.#random);
    const remainderBlinding = nextField(this.#random);
    let staged = false;

    try {
      const prepared = await this.#store.transaction((state) => {
        const source = state.budgetNotes.find((item) => item.noteId === toHex(sourceNoteId));
        if (!source || source.status !== "ACTIVE") {
          throw new PrivateBudgetDelegationStateError("source budget note is not active in private state");
        }
        if (source.sessionId !== toHex(sessionId) || source.owner !== request.sourceAgent) {
          throw new PrivateBudgetDelegationStateError(
            "source budget opening does not belong to the requested session and agent",
          );
        }
        if (state.reservations.some((item) => item.sourceBudgetNoteId === source.noteId && item.status === "PREPARED")) {
          throw new PrivateBudgetDelegationStateError("source budget note already has a prepared reservation");
        }
        const sourceAmount = BigInt(source.amountAtomic);
        if (delegatedAmount > sourceAmount) {
          throw new PrivateBudgetDelegationStateError("delegated amount exceeds the source budget opening");
        }
        const sourceContextHash = budgetContextHash({
          networkId,
          treasuryController: request.treasuryController,
          sessionId,
          note: source,
          noteId: sourceNoteId,
        });
        if (sourceContextHash.toString() !== source.contextHash) {
          throw new PrivateBudgetDelegationStateError("source budget context does not match its private opening");
        }

        const childTemplate = {
          sessionId: toHex(sessionId),
          nodeId: toHex(childNodeId),
          owner: request.childOwner,
          asset: source.asset,
          policyHash: source.policyHash,
        };
        const childContextHash = budgetContextHash({
          networkId,
          treasuryController: request.treasuryController,
          sessionId,
          note: childTemplate,
          noteId: childNoteId,
        });
        const childBudgetNote: BudgetNoteOpening = {
          noteId: toHex(childNoteId),
          ...childTemplate,
          contextHash: childContextHash.toString(),
          commitment: poseidon2Hash3(
            childContextHash,
            delegatedAmount,
            childBlinding,
            POSEIDON_DOMAINS.budgetNote,
          ).toString(),
          amountAtomic: delegatedAmount.toString(),
          blinding: childBlinding.toString(),
          status: "ACTIVE",
        };

        const remainderAmount = sourceAmount - delegatedAmount;
        let remainderBudgetNote: BudgetNoteOpening | undefined;
        if (remainderAmount > 0n) {
          const remainderContextHash = budgetContextHash({
            networkId,
            treasuryController: request.treasuryController,
            sessionId,
            note: source,
            noteId: remainderNoteId,
          });
          remainderBudgetNote = {
            noteId: toHex(remainderNoteId),
            sessionId: source.sessionId,
            nodeId: source.nodeId,
            owner: source.owner,
            asset: source.asset,
            policyHash: source.policyHash,
            contextHash: remainderContextHash.toString(),
            commitment: poseidon2Hash3(
              remainderContextHash,
              remainderAmount,
              remainderBlinding,
              POSEIDON_DOMAINS.budgetNote,
            ).toString(),
            amountAtomic: remainderAmount.toString(),
            blinding: remainderBlinding.toString(),
            status: "ACTIVE",
          };
        }

        const identifiers = [
          toHex(operationId),
          toHex(childNodeId),
          childBudgetNote.noteId,
          ...(remainderBudgetNote ? [remainderBudgetNote.noteId] : []),
        ];
        if (new Set(identifiers).size !== identifiers.length) {
          throw new PrivateBudgetDelegationStateError("generated private delegation identifiers collide");
        }
        const occupied = new Set([
          ...state.budgetNotes.map((item) => item.noteId),
          ...state.reservations.map((item) => item.reservationId),
          ...state.privateBudgetDelegations.flatMap((item) => [
            item.operationId,
            item.childBudgetNote.nodeId,
            item.childBudgetNote.noteId,
            ...(item.remainderBudgetNote ? [item.remainderBudgetNote.noteId] : []),
          ]),
        ]);
        if (identifiers.some((identifier) => occupied.has(identifier))) {
          throw new PrivateBudgetDelegationStateError("generated private delegation identifier is already in use");
        }

        source.status = "SPEND_PENDING";
        source.pendingOperationId = toHex(operationId);
        state.privateBudgetDelegations.push({
          operationId: toHex(operationId),
          sessionId: toHex(sessionId),
          sourceBudgetNoteId: source.noteId,
          childBudgetNote,
          remainderBudgetNote,
          status: "PREPARED",
          createdAtUnixMs: request.createdAtUnixMs,
        });
        return {
          source: structuredClone(source),
          sourceContextHash,
          childBudgetNote,
          remainderBudgetNote,
        };
      });
      staged = true;

      const expectedPublic = [
        prepared.sourceContextHash,
        BigInt(prepared.source.commitment),
        BigInt(prepared.childBudgetNote.contextHash),
        BigInt(prepared.childBudgetNote.commitment),
        BUDGET_NOTE_OUTPUT_KIND,
        prepared.remainderBudgetNote ? BigInt(prepared.remainderBudgetNote.contextHash) : 0n,
        prepared.remainderBudgetNote ? BigInt(prepared.remainderBudgetNote.commitment) : 0n,
        prepared.remainderBudgetNote ? BUDGET_NOTE_OUTPUT_KIND : NO_OUTPUT_KIND,
      ];
      const result = await this.#proofWorker.prove({
        inputContextHash: expectedPublic[0]!.toString(),
        inputCommitment: expectedPublic[1]!.toString(),
        output1ContextHash: expectedPublic[2]!.toString(),
        output1Commitment: expectedPublic[3]!.toString(),
        output1Kind: expectedPublic[4]!.toString(),
        output2ContextHash: expectedPublic[5]!.toString(),
        output2Commitment: expectedPublic[6]!.toString(),
        output2Kind: expectedPublic[7]!.toString(),
        inputAmount: prepared.source.amountAtomic,
        inputBlinding: prepared.source.blinding,
        output1Amount: prepared.childBudgetNote.amountAtomic,
        output1Blinding: prepared.childBudgetNote.blinding,
        output2Amount: prepared.remainderBudgetNote?.amountAtomic ?? "0",
        output2Blinding: prepared.remainderBudgetNote?.blinding ?? "0",
      }, this.#artifacts);
      assertPublicSignals(result.publicSignals, expectedPublic);

      return {
        operationId,
        sessionId,
        sourceNoteId,
        delegation: {
          child_node_id: childNodeId,
          child_note_id: childNoteId,
          child_owner: request.childOwner,
          child_policy: request.childPolicy,
          child_commitment: BigInt(prepared.childBudgetNote.commitment),
          remainder_note_id: prepared.remainderBudgetNote
            ? Buffer.from(prepared.remainderBudgetNote.noteId, "hex")
            : undefined,
          remainder_commitment: prepared.remainderBudgetNote
            ? BigInt(prepared.remainderBudgetNote.commitment)
            : undefined,
        },
        proof: result.proof,
        publicSignals: result.publicSignals,
      };
    } catch (error: unknown) {
      if (staged) await this.abort(operationId).catch(() => undefined);
      throw error;
    }
  }

  async confirm(input: {
    readonly operationId: Uint8Array;
    readonly transactionHash: Uint8Array;
    readonly ledgerSequence: number;
  }): Promise<void> {
    const operationId = toHex(canonicalBytes32(input.operationId, "operation id"));
    const confirmation: ChainConfirmation = {
      transactionHash: toHex(canonicalBytes32(input.transactionHash, "transaction hash")),
      ledgerSequence: input.ledgerSequence,
    };
    if (!Number.isSafeInteger(input.ledgerSequence) || input.ledgerSequence <= 0) {
      throw new RangeError("confirmation ledger must be a positive integer");
    }

    await this.#store.transaction((state) => {
      const prepared = state.privateBudgetDelegations.find((item) => item.operationId === operationId);
      if (!prepared) throw new PrivateBudgetDelegationStateError("private delegation operation is unavailable");
      if (prepared.status === "CONFIRMED") {
        if (confirmationMatches(prepared.confirmation, confirmation)) return;
        throw new PrivateBudgetDelegationStateError("private delegation already has a different confirmation");
      }
      const source = state.budgetNotes.find((item) => item.noteId === prepared.sourceBudgetNoteId);
      if (!source || source.status !== "SPEND_PENDING" || source.pendingOperationId !== operationId) {
        throw new PrivateBudgetDelegationStateError("prepared delegation no longer holds its source opening");
      }
      const outputs = [prepared.childBudgetNote, ...(prepared.remainderBudgetNote ? [prepared.remainderBudgetNote] : [])];
      if (outputs.some((output) => state.budgetNotes.some((item) => item.noteId === output.noteId))) {
        throw new PrivateBudgetDelegationStateError("prepared delegation output already exists in private state");
      }
      source.status = "SPENT";
      delete source.pendingOperationId;
      state.budgetNotes.push(...outputs);
      prepared.status = "CONFIRMED";
      prepared.confirmation = confirmation;
    });
  }

  async abort(operationIdInput: Uint8Array): Promise<void> {
    const operationId = toHex(canonicalBytes32(operationIdInput, "operation id"));
    await this.#store.transaction((state) => {
      const index = state.privateBudgetDelegations.findIndex((item) => item.operationId === operationId);
      const prepared = state.privateBudgetDelegations[index];
      if (!prepared || prepared.status !== "PREPARED") {
        throw new PrivateBudgetDelegationStateError("only a prepared private delegation can be aborted");
      }
      const source = state.budgetNotes.find((item) => item.noteId === prepared.sourceBudgetNoteId);
      if (!source || source.status !== "SPEND_PENDING" || source.pendingOperationId !== operationId) {
        throw new PrivateBudgetDelegationStateError("prepared delegation no longer holds its source opening");
      }
      source.status = "ACTIVE";
      delete source.pendingOperationId;
      state.privateBudgetDelegations.splice(index, 1);
    });
  }
}
