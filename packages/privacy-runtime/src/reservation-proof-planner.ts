import {
  POSEIDON_DOMAINS,
  addressFields,
  addressFromStrKey,
  bytes32ToLimbs,
  deriveId,
  poseidon2Hash3,
  poseidon2HashFields,
  toHex,
} from "@phloem/protocol-types";
import type { Groth16Proof, PrivateReservationInput } from "@phloem/treasury-controller-client";

import type { Groth16ProvingArtifacts, LocalGroth16ProofWorker } from "./local-proof-worker.js";
import type { EncryptedPrivacyStateStore } from "./privacy-state-store.js";
import type { BudgetNoteOpening, PreparedRemainderOpening } from "./state.js";
import {
  PrivateReservationStateError,
  PrivateVoucherIssuer,
  type PrivateRandomSource,
} from "./voucher-issuer.js";

const BUDGET_NOTE_OUTPUT_KIND = 1n;
const PRIVATE_RESERVATION_OUTPUT_KIND = 2n;

export interface PrivateReservationProofRequest {
  readonly sessionId: Uint8Array;
  readonly sourceBudgetNoteId: Uint8Array;
  readonly sourceAgent: string;
  readonly networkId: Uint8Array;
  readonly treasuryController: string;
  readonly approvedProviderRoot: bigint;
  readonly categoryId: number;
  readonly amountAtomic: bigint;
  readonly offerReferenceHash: Uint8Array;
  readonly providerSppPublicKey: bigint;
  readonly claimDeadlineLedger: number;
  readonly createdAtUnixMs: number;
}

export interface PreparedPrivateReservationProof {
  readonly input: PrivateReservationInput;
  readonly proof: Groth16Proof;
  readonly publicSignals: readonly bigint[];
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
    if (value > 0n) return value;
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
    throw new PrivateReservationStateError("local proof public signals do not match the prepared reservation");
  }
}

/** Builds one hidden BudgetNote -> reservation + optional remainder proof. */
export class PrivateReservationProofPlanner {
  readonly #store: EncryptedPrivacyStateStore;
  readonly #issuer: PrivateVoucherIssuer;
  readonly #proofWorker: LocalGroth16ProofWorker;
  readonly #artifacts: Groth16ProvingArtifacts;
  readonly #random: PrivateRandomSource;

  constructor(input: {
    readonly store: EncryptedPrivacyStateStore;
    readonly issuer: PrivateVoucherIssuer;
    readonly proofWorker: LocalGroth16ProofWorker;
    readonly artifacts: Groth16ProvingArtifacts;
    readonly random: PrivateRandomSource;
  }) {
    this.#store = input.store;
    this.#issuer = input.issuer;
    this.#proofWorker = input.proofWorker;
    this.#artifacts = input.artifacts;
    this.#random = input.random;
  }

  async prepare(request: PrivateReservationProofRequest): Promise<PreparedPrivateReservationProof> {
    const sessionId = canonicalBytes32(request.sessionId, "session id");
    const sourceNoteId = canonicalBytes32(request.sourceBudgetNoteId, "source budget note id");
    const snapshot = await this.#store.readSnapshot();
    const source = snapshot.budgetNotes.find((item) => item.noteId === toHex(sourceNoteId));
    if (!source || source.status !== "ACTIVE") {
      throw new PrivateReservationStateError("source budget note is not active in private state");
    }
    if (source.sessionId !== toHex(sessionId) || source.owner !== request.sourceAgent) {
      throw new PrivateReservationStateError("source budget opening does not belong to the requested session and agent");
    }
    const sourceAmount = BigInt(source.amountAtomic);
    if (request.amountAtomic <= 0n || request.amountAtomic > sourceAmount) {
      throw new PrivateReservationStateError("reservation amount exceeds the source budget opening");
    }
    const sourceContextHash = budgetContextHash({
      networkId: request.networkId,
      treasuryController: request.treasuryController,
      sessionId,
      note: source,
      noteId: sourceNoteId,
    });
    if (sourceContextHash.toString() !== source.contextHash) {
      throw new PrivateReservationStateError("source budget context does not match its private opening");
    }

    const reservationId = nextPrivateId("PHLOEM_RESERVATION_ID_V1", this.#random);
    let prepared = false;
    try {
      const publicArtifacts = await this.#issuer.prepareReservation({
        reservationId,
        sessionId,
        sourceBudgetNoteId: sourceNoteId,
        sourceBudgetContextHash: sourceContextHash,
        approvedProviderRoot: request.approvedProviderRoot,
        categoryId: request.categoryId,
        networkId: request.networkId,
        treasuryController: request.treasuryController,
        amountAtomic: request.amountAtomic,
        offerReferenceHash: request.offerReferenceHash,
        providerSppPublicKey: request.providerSppPublicKey,
        claimDeadlineLedger: request.claimDeadlineLedger,
        createdAtUnixMs: request.createdAtUnixMs,
      });
      prepared = true;

      const remainderAmount = sourceAmount - request.amountAtomic;
      let remainder: PreparedRemainderOpening | undefined;
      if (remainderAmount > 0n) {
        const noteId = nextPrivateId("PHLOEM_BUDGET_NOTE_ID_V1", this.#random);
        const contextHash = budgetContextHash({
          networkId: request.networkId,
          treasuryController: request.treasuryController,
          sessionId,
          note: source,
          noteId,
        });
        const blinding = nextField(this.#random);
        remainder = {
          noteId: toHex(noteId),
          contextHash: contextHash.toString(),
          amountAtomic: remainderAmount.toString(),
          blinding: blinding.toString(),
          commitment: poseidon2Hash3(contextHash, remainderAmount, blinding, POSEIDON_DOMAINS.budgetNote).toString(),
        };
        await this.#store.transaction((state) => {
          const opening = state.reservations.find((item) => item.reservationId === toHex(reservationId));
          if (!opening || opening.status !== "PREPARED") {
            throw new PrivateReservationStateError("prepared reservation disappeared before proof generation");
          }
          if (state.budgetNotes.some((item) => item.noteId === remainder!.noteId)
            || state.reservations.some((item) => item.reservationId === remainder!.noteId)) {
            throw new PrivateReservationStateError("prepared remainder id collides with private state");
          }
          opening.preparedRemainder = remainder;
        });
      }

      const state = await this.#store.readSnapshot();
      const opening = state.reservations.find((item) => item.reservationId === toHex(reservationId));
      if (!opening) throw new PrivateReservationStateError("prepared reservation opening is unavailable");
      const expectedPublic = [
        sourceContextHash,
        BigInt(source.commitment),
        publicArtifacts.reservationContextHash,
        publicArtifacts.amountCommitment,
        PRIVATE_RESERVATION_OUTPUT_KIND,
        remainder ? BigInt(remainder.contextHash) : 0n,
        remainder ? BigInt(remainder.commitment) : 0n,
        remainder ? BUDGET_NOTE_OUTPUT_KIND : 0n,
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
        inputAmount: source.amountAtomic,
        inputBlinding: source.blinding,
        output1Amount: request.amountAtomic.toString(),
        output1Blinding: opening.amountBlinding,
        output2Amount: remainder?.amountAtomic ?? "0",
        output2Blinding: remainder?.blinding ?? "0",
      }, this.#artifacts);
      assertPublicSignals(result.publicSignals, expectedPublic);
      return {
        input: {
          reservation_id: reservationId,
          session_id: sessionId,
          source_budget_note_id: sourceNoteId,
          category_id: request.categoryId,
          offer_commitment: publicArtifacts.offerCommitment,
          voucher_signer_public_key: publicArtifacts.voucherSignerPublicKey,
          amount_commitment: publicArtifacts.amountCommitment,
          provider_commitment: publicArtifacts.providerCommitment,
          claim_deadline_ledger: request.claimDeadlineLedger,
          remainder_budget_note_id: remainder ? Buffer.from(remainder.noteId, "hex") : undefined,
          remainder_commitment: remainder ? BigInt(remainder.commitment) : undefined,
        },
        proof: result.proof,
        publicSignals: result.publicSignals,
      };
    } catch (error: unknown) {
      if (prepared) await this.#issuer.discardPreparedReservation(reservationId).catch(() => undefined);
      throw error;
    }
  }

  async confirm(input: {
    readonly operationId: Uint8Array;
    readonly transactionHash: Uint8Array;
    readonly ledgerSequence: number;
  }): Promise<void> {
    await this.#issuer.confirmReservationOpen({
      reservationId: input.operationId,
      transactionHash: input.transactionHash,
      ledgerSequence: input.ledgerSequence,
    });
  }

  async abort(operationId: Uint8Array): Promise<void> {
    await this.#issuer.discardPreparedReservation(operationId);
  }
}
