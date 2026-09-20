import {
  BN254_SCALAR_MODULUS,
  POSEIDON_DOMAINS,
  addressFields,
  addressFromStrKey,
  auditContextHash,
  bytes32ToLimbs,
  bytesToBigInt,
  poseidon2Hash3,
  poseidon2HashFields,
  toHex,
} from "@phloem/protocol-types";
import { StrKey } from "@stellar/stellar-sdk";
import type {
  Groth16Proof,
  PrivateRootBackingInput,
  SppExtData,
  SppProof,
} from "@phloem/treasury-controller-client";

import type { Groth16ProvingArtifacts, LocalGroth16ProofWorker } from "./local-proof-worker.js";
import type { EncryptedPrivacyStateStore } from "./privacy-state-store.js";
import type { TreasuryPrivacyKeyManager } from "./treasury-privacy-key.js";
import type { PrivateRandomSource } from "./voucher-issuer.js";

export interface PreparedSppPrivateDeposit {
  readonly operationId: Buffer;
  readonly proof: SppProof;
  readonly extData: SppExtData;
  readonly fundingOutputBlinding: bigint;
}

/** Pinned upstream SPP deposit boundary. It receives public ownership components only. */
export interface SppPrivateDepositPlanner {
  prepare(input: {
    readonly sessionId: Buffer;
    readonly fundingSource: string;
    readonly amountAtomic: bigint;
    readonly treasurySppPublicKey: bigint;
    readonly treasuryEncryptionPublicKey: Buffer;
    readonly sppPool: string;
  }): Promise<PreparedSppPrivateDeposit>;
  abort(operationId: Buffer): Promise<void>;
  confirm(
    operationId: Buffer,
    transactionHash: Buffer,
    ledgerSequence: number,
    expectedFundingCommitment: bigint,
  ): Promise<{ readonly fundingLeafIndex: number }>;
}

export interface PreparePrivateSessionActivationRequest {
  readonly sessionId: Uint8Array;
  readonly company: string;
  readonly networkId: Uint8Array;
  readonly treasuryController: string;
  readonly asset: string;
  readonly policyHash: bigint;
  readonly rootNodeId: Uint8Array;
  readonly rootNoteId: Uint8Array;
  readonly fundingAmountAtomic: bigint;
  readonly createdAtUnixMs: number;
}

export interface PreparedPrivateSessionActivation {
  readonly operationId: Buffer;
  readonly input: PrivateRootBackingInput;
  readonly backingProof: Groth16Proof;
  readonly publicSignals: readonly bigint[];
}

export class PrivateSessionActivationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateSessionActivationStateError";
  }
}

function bytes32(value: Uint8Array, label: string): Buffer {
  if (value.length !== 32) throw new RangeError(`${label} must be exactly 32 bytes`);
  return Buffer.from(value);
}

function checkedField(value: bigint, label: string): bigint {
  if (value < 0n || value >= BN254_SCALAR_MODULUS) {
    throw new RangeError(`${label} must be a canonical BN254 field`);
  }
  return value;
}

function checkedPositiveU64(value: bigint, label: string): bigint {
  if (value <= 0n || value >= (1n << 64n)) throw new RangeError(`${label} must be a positive u64`);
  return value;
}

function randomField(random: PrivateRandomSource): bigint {
  for (;;) {
    const value = bytesToBigInt(bytes32(random.bytes(32), "private field entropy"));
    if (value > 0n && value < BN254_SCALAR_MODULUS) return value;
  }
}

function assertPublicSignals(actual: readonly bigint[], expected: readonly bigint[]): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new PrivateSessionActivationStateError("root-backing proof public signals do not match the prepared activation");
  }
}

export class PrivateSessionActivationPlanner {
  readonly #store: EncryptedPrivacyStateStore;
  readonly #treasuryKeys: TreasuryPrivacyKeyManager;
  readonly #proofWorker: LocalGroth16ProofWorker;
  readonly #rootBackingArtifacts: Groth16ProvingArtifacts;
  readonly #spp: SppPrivateDepositPlanner;
  readonly #sppPool: string;
  readonly #random: PrivateRandomSource;

  constructor(input: {
    readonly store: EncryptedPrivacyStateStore;
    readonly treasuryKeys: TreasuryPrivacyKeyManager;
    readonly proofWorker: LocalGroth16ProofWorker;
    readonly rootBackingArtifacts: Groth16ProvingArtifacts;
    readonly spp: SppPrivateDepositPlanner;
    readonly sppPool: string;
    readonly random: PrivateRandomSource;
  }) {
    if (!StrKey.isValidContract(input.sppPool)) throw new TypeError("SPP pool must be a canonical C-address");
    this.#store = input.store;
    this.#treasuryKeys = input.treasuryKeys;
    this.#proofWorker = input.proofWorker;
    this.#rootBackingArtifacts = input.rootBackingArtifacts;
    this.#spp = input.spp;
    this.#sppPool = input.sppPool;
    this.#random = input.random;
  }

  async prepare(request: PreparePrivateSessionActivationRequest): Promise<PreparedPrivateSessionActivation> {
    const sessionId = bytes32(request.sessionId, "session id");
    const networkId = bytes32(request.networkId, "network id");
    const rootNodeId = bytes32(request.rootNodeId, "root node id");
    const rootNoteId = bytes32(request.rootNoteId, "root note id");
    const amount = checkedPositiveU64(request.fundingAmountAtomic, "funding amount");
    checkedField(request.policyHash, "policy hash");
    if (!StrKey.isValidEd25519PublicKey(request.company)) {
      throw new TypeError("P0 company funding source must be a canonical G-address");
    }
    if (!StrKey.isValidContract(request.treasuryController) || !StrKey.isValidContract(request.asset)) {
      throw new TypeError("controller and asset must be canonical C-addresses");
    }
    if (rootNodeId.equals(rootNoteId)) throw new PrivateSessionActivationStateError("root node and note ids must differ");
    if (!Number.isSafeInteger(request.createdAtUnixMs) || request.createdAtUnixMs < 0) {
      throw new RangeError("creation time must be non-negative integer milliseconds");
    }

    const auditContext = auditContextHash({
      protocolVersion: 1,
      networkId,
      treasuryController: addressFromStrKey(request.treasuryController),
      sessionId,
      asset: addressFromStrKey(request.asset),
      settlementMode: 2,
      policyHash: request.policyHash,
    });
    const treasury = await this.#treasuryKeys.ensureForSession({
      sessionId,
      auditContextHash: auditContext,
      createdAtUnixMs: request.createdAtUnixMs,
    });
    const spp = await this.#spp.prepare({
      sessionId,
      fundingSource: request.company,
      amountAtomic: amount,
      treasurySppPublicKey: treasury.notePublicKey,
      treasuryEncryptionPublicKey: treasury.encryptionPublicKey,
      sppPool: this.#sppPool,
    });
    try {
      const operationId = bytes32(spp.operationId, "SPP operation id");
      const fundingOutputBlinding = checkedField(spp.fundingOutputBlinding, "SPP funding output blinding");
      if (spp.proof.public_amount !== amount
        || spp.extData.ext_amount !== amount
        || spp.extData.recipient !== this.#sppPool) {
        throw new PrivateSessionActivationStateError("SPP deposit does not match the canonical private activation");
      }
      const expectedFundingOutput = poseidon2Hash3(
        amount,
        treasury.notePublicKey,
        fundingOutputBlinding,
        POSEIDON_DOMAINS.sppNote,
      );
      if (spp.proof.output_commitment0 !== expectedFundingOutput) {
        throw new PrivateSessionActivationStateError("SPP funding output is not owned by the session treasury key");
      }

      const rootContext = poseidon2HashFields([
        1n,
        ...bytes32ToLimbs(networkId),
        ...addressFields(addressFromStrKey(request.treasuryController)),
        ...bytes32ToLimbs(sessionId),
        ...bytes32ToLimbs(rootNodeId),
        ...addressFields(addressFromStrKey(request.company)),
        ...addressFields(addressFromStrKey(request.asset)),
        request.policyHash,
        ...bytes32ToLimbs(rootNoteId),
      ], POSEIDON_DOMAINS.contextInit, POSEIDON_DOMAINS.contextFold);
      const rootBudgetBlind = randomField(this.#random);
      const rootBudgetCommitment = poseidon2Hash3(
        rootContext,
        amount,
        rootBudgetBlind,
        POSEIDON_DOMAINS.budgetNote,
      );
      const initialAuditBlind = randomField(this.#random);
      const initialAuditCommitment = poseidon2Hash3(
        auditContext,
        0n,
        initialAuditBlind,
        POSEIDON_DOMAINS.auditTotal,
      );
      const treasuryOpening = await this.#treasuryKeys.getCommitmentOpening(sessionId, auditContext);
      const expectedPublic = [
        rootContext,
        rootBudgetCommitment,
        auditContext,
        initialAuditCommitment,
        treasury.commitment,
        expectedFundingOutput,
        amount,
      ];
      const proof = await this.#proofWorker.prove({
        rootContextHash: rootContext.toString(),
        rootBudgetCommitment: rootBudgetCommitment.toString(),
        auditContextHash: auditContext.toString(),
        initialAuditTotalCommitment: initialAuditCommitment.toString(),
        treasurySppKeyCommitment: treasury.commitment.toString(),
        sppFundingOutputCommitment: expectedFundingOutput.toString(),
        fundingAmount: amount.toString(),
        rootBudgetBlind: rootBudgetBlind.toString(),
        initialAuditBlind: initialAuditBlind.toString(),
        treasurySppPublicKey: treasury.notePublicKey.toString(),
        treasurySppKeyBlind: treasuryOpening.blinding.toString(),
        sppFundingOutputBlind: fundingOutputBlinding.toString(),
      }, this.#rootBackingArtifacts);
      assertPublicSignals(proof.publicSignals, expectedPublic);

      const sppNoteId = bytes32(this.#random.bytes(32), "SPP funding note id");
      await this.#store.transaction((state) => {
        const id = toHex(sessionId);
        if (state.privateSessionActivations.some((item) => item.sessionId === id)
          || state.budgetNotes.some((item) => item.sessionId === id)
          || state.auditAccumulators.some((item) => item.sessionId === id)
          || state.sppTreasuryNotes.some((item) => item.sessionId === id)) {
          throw new PrivateSessionActivationStateError("session already has prepared or active private backing");
        }
        if (state.budgetNotes.some((item) => item.noteId === toHex(rootNoteId))) {
          throw new PrivateSessionActivationStateError("root budget note id already exists");
        }
        state.privateSessionActivations.push({
          operationId: toHex(operationId),
          sessionId: id,
          rootBudgetNote: {
            noteId: toHex(rootNoteId),
            sessionId: id,
            nodeId: toHex(rootNodeId),
            owner: request.company,
            asset: request.asset,
            policyHash: request.policyHash.toString(),
            contextHash: rootContext.toString(),
            commitment: rootBudgetCommitment.toString(),
            amountAtomic: amount.toString(),
            blinding: rootBudgetBlind.toString(),
            status: "ACTIVE",
          },
          auditAccumulator: {
            sessionId: id,
            auditContextHash: auditContext.toString(),
            totalSpendAtomic: "0",
            blinding: initialAuditBlind.toString(),
            commitment: initialAuditCommitment.toString(),
            auditVersion: 1,
          },
          sppTreasuryNote: {
            noteId: toHex(sppNoteId),
            sessionId: id,
            pool: this.#sppPool,
            commitment: expectedFundingOutput.toString(),
            amountAtomic: amount.toString(),
            blinding: fundingOutputBlinding.toString(),
            status: "PREPARED",
            createdAtUnixMs: request.createdAtUnixMs,
          },
          createdAtUnixMs: request.createdAtUnixMs,
        });
      });

      return {
        operationId,
        input: {
          funding_amount: amount,
          initial_audit_total_commitment: initialAuditCommitment,
          root_note: { node_id: rootNodeId, note_id: rootNoteId, commitment: rootBudgetCommitment },
          spp_ext_data: spp.extData,
          spp_proof: spp.proof,
          treasury_spp_key_commitment: treasury.commitment,
        },
        backingProof: proof.proof,
        publicSignals: proof.publicSignals,
      };
    } catch (error: unknown) {
      await this.#spp.abort(spp.operationId).catch(() => undefined);
      throw error;
    }
  }

  async abort(operationIdInput: Uint8Array): Promise<void> {
    const operationId = bytes32(operationIdInput, "SPP operation id");
    await this.#spp.abort(operationId);
    await this.#store.transaction((state) => {
      const index = state.privateSessionActivations.findIndex((item) => item.operationId === toHex(operationId));
      if (index < 0) throw new PrivateSessionActivationStateError("prepared private activation was not found");
      state.privateSessionActivations.splice(index, 1);
    });
  }

  async confirm(input: {
    readonly operationId: Uint8Array;
    readonly transactionHash: Uint8Array;
    readonly ledgerSequence: number;
  }): Promise<void> {
    const operationId = bytes32(input.operationId, "SPP operation id");
    const transactionHash = bytes32(input.transactionHash, "transaction hash");
    if (!Number.isSafeInteger(input.ledgerSequence) || input.ledgerSequence <= 0) {
      throw new RangeError("confirmation ledger must be a positive integer");
    }
    const snapshot = await this.#store.readSnapshot();
    const activation = snapshot.privateSessionActivations.find((item) => item.operationId === toHex(operationId));
    if (!activation) throw new PrivateSessionActivationStateError("prepared private activation was not found");
    const expectedFundingCommitment = checkedField(
      BigInt(activation.sppTreasuryNote.commitment),
      "staged SPP funding commitment",
    );
    const result = await this.#spp.confirm(
      operationId,
      transactionHash,
      input.ledgerSequence,
      expectedFundingCommitment,
    );
    if (!Number.isSafeInteger(result.fundingLeafIndex) || result.fundingLeafIndex < 0) {
      throw new PrivateSessionActivationStateError("SPP confirmation returned an invalid funding leaf index");
    }
    await this.#store.transaction((state) => {
      const index = state.privateSessionActivations.findIndex((item) => item.operationId === toHex(operationId));
      const activation = state.privateSessionActivations[index];
      if (!activation) throw new PrivateSessionActivationStateError("prepared private activation was not found");
      if (state.budgetNotes.some((item) => item.noteId === activation.rootBudgetNote.noteId)
        || state.auditAccumulators.some((item) => item.sessionId === activation.sessionId)
        || state.sppTreasuryNotes.some((item) => item.noteId === activation.sppTreasuryNote.noteId)) {
        throw new PrivateSessionActivationStateError("confirmed activation conflicts with existing private state");
      }
      state.budgetNotes.push(activation.rootBudgetNote);
      state.auditAccumulators.push(activation.auditAccumulator);
      state.sppTreasuryNotes.push({
        ...activation.sppTreasuryNote,
        status: "ACTIVE",
        leafIndex: result.fundingLeafIndex,
        confirmation: { transactionHash: toHex(transactionHash), ledgerSequence: input.ledgerSequence },
      });
      state.privateSessionActivations.splice(index, 1);
    });
  }
}
