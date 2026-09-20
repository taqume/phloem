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
import type {
  PrivateSettlementInput,
  SppExtData,
  SppProof,
} from "@phloem/treasury-controller-client";

import type { Groth16ProvingArtifacts, LocalGroth16ProofWorker } from "./local-proof-worker.js";
import type { EncryptedPrivacyStateStore } from "./privacy-state-store.js";
import type { SppRuntimeBinding } from "./spp-runtime-binding.js";
import type { BudgetNoteOpening, PreparedRemainderOpening } from "./state.js";
import type {
  TreasuryPrivacyKeyManager,
  TreasurySppKeyCommitmentOpening,
} from "./treasury-privacy-key.js";
import { PrivateReservationStateError, type PrivateRandomSource } from "./voucher-issuer.js";

export interface ControlledProviderPrivatePolicy {
  readonly providerIdentity: string;
  readonly providerSppPublicKey: bigint;
  /** Trusted P0 delivery key; the note commitment remains bound to providerSppPublicKey. */
  readonly providerSppEncryptionPublicKey: Uint8Array;
  readonly serviceIdHash: Uint8Array;
  readonly categoryId: number;
  readonly allowedSettlementModes: 2;
}

export type TreasurySppKeyOpening = TreasurySppKeyCommitmentOpening;

export interface PreparedSppPrivateTransfer {
  readonly operationId: Buffer;
  readonly proof: SppProof;
  readonly extData: SppExtData;
  readonly providerOutputBlinding: bigint;
  readonly refundOutputBlinding: bigint;
}

export interface SppPrivateTransferPlanner {
  prepare(input: {
    readonly reservationId: Buffer;
    readonly sessionId: Buffer;
    readonly claimAmountAtomic: bigint;
    readonly refundAmountAtomic: bigint;
    readonly providerSppPublicKey: bigint;
    readonly providerSppEncryptionPublicKey: Buffer;
    readonly treasurySppPublicKey: bigint;
    readonly sppPool: string;
  }): Promise<PreparedSppPrivateTransfer>;
  abort(operationId: Buffer): Promise<void>;
  confirm(
    operationId: Buffer,
    transactionHash: Buffer,
    ledgerSequence: number,
    expectedProviderOutputCommitment: bigint,
    expectedSecondOutputCommitment: bigint,
    hasTreasuryRefund: boolean,
  ): Promise<void>;
}

export interface PreparePrivateSettlementRequest {
  readonly reservationId: Uint8Array;
  readonly provider: ControlledProviderPrivatePolicy;
}

export interface PreparedPrivateSettlementCall {
  readonly operationId: Buffer;
  readonly input: PrivateSettlementInput;
  readonly publicSignals: readonly bigint[];
}

function bytes32(value: Uint8Array, label: string): Buffer {
  if (value.length !== 32) throw new RangeError(`${label} must be exactly 32 bytes`);
  return Buffer.from(value);
}

function randomField(random: PrivateRandomSource): bigint {
  for (;;) {
    const value = bytes32(random.bytes(32), "private field entropy");
    value[0] = value[0]! & 0x1f;
    const field = BigInt(`0x${value.toString("hex")}`);
    if (field > 0n) return field;
  }
}

function randomId(domain: string, random: PrivateRandomSource): Buffer {
  return Buffer.from(deriveId(domain, bytes32(random.bytes(32), "private id entropy")));
}

function budgetContextHash(input: {
  readonly reservation: { readonly networkIdHex: string; readonly treasuryController: string; readonly sessionId: string };
  readonly source: Pick<BudgetNoteOpening, "nodeId" | "owner" | "asset" | "policyHash">;
  readonly noteId: Buffer;
}): bigint {
  return poseidon2HashFields([
    1n,
    ...bytes32ToLimbs(Buffer.from(input.reservation.networkIdHex, "hex")),
    ...addressFields(addressFromStrKey(input.reservation.treasuryController)),
    ...bytes32ToLimbs(Buffer.from(input.reservation.sessionId, "hex")),
    ...bytes32ToLimbs(Buffer.from(input.source.nodeId, "hex")),
    ...addressFields(addressFromStrKey(input.source.owner)),
    ...addressFields(addressFromStrKey(input.source.asset)),
    BigInt(input.source.policyHash),
    ...bytes32ToLimbs(input.noteId),
  ], POSEIDON_DOMAINS.contextInit, POSEIDON_DOMAINS.contextFold);
}

function assertSignals(actual: readonly bigint[], expected: readonly bigint[]): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new PrivateReservationStateError("binding proof public signals do not match the prepared settlement");
  }
}

export class PrivateSettlementPlanner {
  readonly #store: EncryptedPrivacyStateStore;
  readonly #proofWorker: LocalGroth16ProofWorker;
  readonly #bindingArtifacts: Groth16ProvingArtifacts;
  readonly #spp: SppPrivateTransferPlanner;
  readonly #sppDeployment: SppRuntimeBinding;
  readonly #treasuryKeys: TreasuryPrivacyKeyManager;
  readonly #random: PrivateRandomSource;

  constructor(input: {
    readonly store: EncryptedPrivacyStateStore;
    readonly proofWorker: LocalGroth16ProofWorker;
    readonly bindingArtifacts: Groth16ProvingArtifacts;
    readonly spp: SppPrivateTransferPlanner;
    readonly sppDeployment: SppRuntimeBinding;
    readonly treasuryKeys: TreasuryPrivacyKeyManager;
    readonly random: PrivateRandomSource;
  }) {
    this.#store = input.store;
    this.#proofWorker = input.proofWorker;
    this.#bindingArtifacts = input.bindingArtifacts;
    this.#spp = input.spp;
    this.#sppDeployment = input.sppDeployment;
    this.#treasuryKeys = input.treasuryKeys;
    this.#random = input.random;
  }

  async prepare(request: PreparePrivateSettlementRequest): Promise<PreparedPrivateSettlementCall> {
    const reservationId = bytes32(request.reservationId, "reservation id");
    const snapshot = await this.#store.readSnapshot();
    const reservation = snapshot.reservations.find((item) => item.reservationId === toHex(reservationId));
    if (!reservation || reservation.status !== "OPEN" || !reservation.latestVoucher) {
      throw new PrivateReservationStateError("settlement requires an open reservation with a voucher");
    }
    const source = snapshot.budgetNotes.find((item) => item.noteId === reservation.sourceBudgetNoteId);
    const audit = snapshot.auditAccumulators.find((item) => item.sessionId === reservation.sessionId);
    if (!source || !audit) throw new PrivateReservationStateError("private settlement openings are incomplete");
    const treasurySppKey = await this.#treasuryKeys.getCommitmentOpening(
      Buffer.from(reservation.sessionId, "hex"),
      BigInt(audit.auditContextHash),
    );
    if (request.provider.categoryId !== reservation.categoryId
      || request.provider.providerSppPublicKey.toString() !== reservation.providerSppPublicKey) {
      throw new PrivateReservationStateError("controlled provider does not match the reservation opening");
    }
    const providerSppEncryptionPublicKey = bytes32(
      request.provider.providerSppEncryptionPublicKey,
      "provider SPP encryption public key",
    );
    const providerFields = [
      1n,
      ...addressFields(addressFromStrKey(request.provider.providerIdentity)),
      request.provider.providerSppPublicKey,
      ...bytes32ToLimbs(bytes32(request.provider.serviceIdHash, "service id hash")),
      BigInt(request.provider.categoryId),
      BigInt(request.provider.allowedSettlementModes),
    ];
    const providerLeaf = poseidon2HashFields(providerFields, POSEIDON_DOMAINS.providerInit, POSEIDON_DOMAINS.providerFold);
    if (providerLeaf.toString() !== reservation.approvedProviderRoot) {
      throw new PrivateReservationStateError("controlled provider leaf is not the approved P0 root");
    }
    const treasuryCommitment = poseidon2Hash3(
      BigInt(audit.auditContextHash),
      treasurySppKey.publicKey,
      treasurySppKey.blinding,
      POSEIDON_DOMAINS.sppTreasuryKey,
    );
    if (treasuryCommitment !== treasurySppKey.commitment) {
      throw new PrivateReservationStateError("treasury SPP key opening does not match its session commitment");
    }

    const voucher = reservation.latestVoucher;
    const claimAmount = BigInt(voucher.cumulativeAmountAtomic);
    const refundAmount = BigInt(reservation.amountAtomic) - claimAmount;
    const spp = await this.#spp.prepare({
      reservationId,
      sessionId: Buffer.from(reservation.sessionId, "hex"),
      claimAmountAtomic: claimAmount,
      refundAmountAtomic: refundAmount,
      providerSppPublicKey: request.provider.providerSppPublicKey,
      providerSppEncryptionPublicKey,
      treasurySppPublicKey: treasurySppKey.publicKey,
      sppPool: this.#sppDeployment.poolContractId,
    });
    try {
      if (spp.proof.public_amount !== 0n
        || spp.extData.ext_amount !== 0n
        || spp.extData.recipient !== this.#sppDeployment.poolContractId) {
        throw new PrivateReservationStateError("SPP transfer is not the canonical zero-public-amount pool call");
      }
      const expectedProviderOutput = poseidon2Hash3(
        claimAmount,
        request.provider.providerSppPublicKey,
        spp.providerOutputBlinding,
        POSEIDON_DOMAINS.sppNote,
      );
      const refundOwner = refundAmount > 0n ? treasurySppKey.publicKey : request.provider.providerSppPublicKey;
      const expectedSppRefund = poseidon2Hash3(refundAmount, refundOwner, spp.refundOutputBlinding, POSEIDON_DOMAINS.sppNote);
      if (spp.proof.output_commitment0 !== expectedProviderOutput || spp.proof.output_commitment1 !== expectedSppRefund) {
        throw new PrivateReservationStateError("SPP proof outputs do not match the binding openings");
      }

      let refund: PreparedRemainderOpening | undefined;
      if (refundAmount > 0n) {
        const noteId = randomId("PHLOEM_BUDGET_NOTE_ID_V1", this.#random);
        const contextHash = budgetContextHash({ reservation, source, noteId });
        const blinding = randomField(this.#random);
        refund = {
          noteId: toHex(noteId),
          contextHash: contextHash.toString(),
          amountAtomic: refundAmount.toString(),
          blinding: blinding.toString(),
          commitment: poseidon2Hash3(contextHash, refundAmount, blinding, POSEIDON_DOMAINS.budgetNote).toString(),
        };
      }
      const nextAuditTotal = BigInt(audit.totalSpendAtomic) + claimAmount;
      const nextAuditBlind = randomField(this.#random);
      if (nextAuditBlind.toString() === audit.blinding) throw new PrivateReservationStateError("audit blinding did not rotate");
      const nextAuditCommitment = poseidon2Hash3(
        BigInt(audit.auditContextHash),
        nextAuditTotal,
        nextAuditBlind,
        POSEIDON_DOMAINS.auditTotal,
      );
      const voucherContextHash = poseidon2HashFields([
        BigInt(reservation.reservationContextHash),
        BigInt(reservation.offerCommitment),
        ...bytes32ToLimbs(Buffer.from(reservation.voucherSignerPublicKeyHex, "hex")),
        BigInt(voucher.usageRoot),
      ], POSEIDON_DOMAINS.contextInit, POSEIDON_DOMAINS.contextFold);
      const expectedPublic = [
        BigInt(reservation.reservationContextHash),
        BigInt(reservation.amountCommitment),
        voucherContextHash,
        BigInt(voucher.cumulativeAmountCommitment),
        BigInt(reservation.providerCommitment),
        spp.proof.output_commitment0,
        treasurySppKey.commitment,
        spp.proof.output_commitment1,
        refund ? BigInt(refund.contextHash) : 0n,
        refund ? BigInt(refund.commitment) : 0n,
        providerLeaf,
        BigInt(audit.auditContextHash),
        BigInt(audit.commitment),
        nextAuditCommitment,
        BigInt(voucher.usageRoot),
        BigInt(reservation.offerCommitment),
      ];
      const binding = await this.#proofWorker.prove({
        reservationContextHash: expectedPublic[0]!.toString(),
        reservationCommitment: expectedPublic[1]!.toString(),
        voucherContextHash: expectedPublic[2]!.toString(),
        voucherAmountCommitment: expectedPublic[3]!.toString(),
        providerCommitment: expectedPublic[4]!.toString(),
        providerSppOutputCommitment: expectedPublic[5]!.toString(),
        treasurySppKeyCommitment: expectedPublic[6]!.toString(),
        sppRefundOutputCommitment: expectedPublic[7]!.toString(),
        refundContextHash: expectedPublic[8]!.toString(),
        refundBudgetCommitment: expectedPublic[9]!.toString(),
        approvedProviderRoot: expectedPublic[10]!.toString(),
        auditContextHash: expectedPublic[11]!.toString(),
        oldAuditTotalCommitment: expectedPublic[12]!.toString(),
        newAuditTotalCommitment: expectedPublic[13]!.toString(),
        usageRoot: expectedPublic[14]!.toString(),
        offerCommitment: expectedPublic[15]!.toString(),
        reservationAmount: reservation.amountAtomic,
        reservationBlind: reservation.amountBlinding,
        voucherSignerPublicKeyFields: bytes32ToLimbs(Buffer.from(reservation.voucherSignerPublicKeyHex, "hex")).map(String),
        claimAmount: claimAmount.toString(),
        voucherAmountBlind: voucher.amountBlinding,
        providerLeafFields: providerFields.map(String),
        providerBlind: reservation.providerBlinding,
        sppProviderOutputBlind: spp.providerOutputBlinding.toString(),
        treasurySppPublicKey: treasurySppKey.publicKey.toString(),
        treasurySppKeyBlind: treasurySppKey.blinding.toString(),
        sppRefundOutputBlind: spp.refundOutputBlinding.toString(),
        refundAmount: refundAmount.toString(),
        refundBlind: refund?.blinding ?? "0",
        oldAuditTotal: audit.totalSpendAtomic,
        oldAuditBlind: audit.blinding,
        newAuditTotal: nextAuditTotal.toString(),
        newAuditBlind: nextAuditBlind.toString(),
      }, this.#bindingArtifacts);
      assertSignals(binding.publicSignals, expectedPublic);

      await this.#store.transaction((state) => {
        const current = state.reservations.find((item) => item.reservationId === reservation.reservationId);
        if (!current || current.status !== "OPEN") throw new PrivateReservationStateError("reservation changed during settlement preparation");
        current.status = "SETTLEMENT_PENDING";
        current.preparedSettlement = {
          operationId: toHex(spp.operationId),
          voucherSequence: voucher.sequence,
          providerSppOutputCommitment: spp.proof.output_commitment0.toString(),
          sppRefundOutputCommitment: spp.proof.output_commitment1.toString(),
          ...(refund ? { refundBudgetNote: refund } : {}),
          nextAudit: {
            auditContextHash: audit.auditContextHash,
            totalSpendAtomic: nextAuditTotal.toString(),
            blinding: nextAuditBlind.toString(),
            commitment: nextAuditCommitment.toString(),
            auditVersion: audit.auditVersion + 1,
          },
        };
      });

      return {
        operationId: spp.operationId,
        input: {
          binding_proof: binding.proof,
          new_audit_total_commitment: nextAuditCommitment,
          refund_budget_note_id: refund ? Buffer.from(refund.noteId, "hex") : undefined,
          refund_budget_commitment: refund ? BigInt(refund.commitment) : undefined,
          spp_ext_data: spp.extData,
          spp_proof: spp.proof,
          voucher: {
            protocol_version: 1,
            voucher_version: 1,
            network_id: Buffer.from(reservation.networkIdHex, "hex"),
            treasury_controller: reservation.treasuryController,
            session_id: Buffer.from(reservation.sessionId, "hex"),
            reservation_id: reservationId,
            sequence: BigInt(voucher.sequence),
            cumulative_amount_commitment: BigInt(voucher.cumulativeAmountCommitment),
            usage_root: BigInt(voucher.usageRoot),
            offer_commitment: BigInt(reservation.offerCommitment),
            expiry_ledger: voucher.expiryLedger,
          },
          voucher_signature: Buffer.from(voucher.signatureHex, "hex"),
        },
        publicSignals: binding.publicSignals,
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
      const reservation = state.reservations.find(
        (item) => item.status === "SETTLEMENT_PENDING" && item.preparedSettlement?.operationId === toHex(operationId),
      );
      if (!reservation) throw new PrivateReservationStateError("pending settlement operation was not found");
      reservation.status = "OPEN";
      delete reservation.preparedSettlement;
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
    const pending = snapshot.reservations.find(
      (item) => item.status === "SETTLEMENT_PENDING" && item.preparedSettlement?.operationId === toHex(operationId),
    );
    if (!pending?.preparedSettlement) {
      throw new PrivateReservationStateError("pending settlement operation was not found");
    }
    // The SPP adapter must make confirmation idempotent: a process crash after
    // this call is reconciled by calling confirm again from the chain receipt.
    await this.#spp.confirm(
      operationId,
      transactionHash,
      input.ledgerSequence,
      BigInt(pending.preparedSettlement.providerSppOutputCommitment),
      BigInt(pending.preparedSettlement.sppRefundOutputCommitment),
      pending.preparedSettlement.refundBudgetNote !== undefined,
    );
    await this.#store.transaction((state) => {
      const reservation = state.reservations.find(
        (item) => item.status === "SETTLEMENT_PENDING" && item.preparedSettlement?.operationId === toHex(operationId),
      );
      if (!reservation?.preparedSettlement) {
        throw new PrivateReservationStateError("pending settlement operation was not found");
      }
      const prepared = reservation.preparedSettlement;
      const source = state.budgetNotes.find((item) => item.noteId === reservation.sourceBudgetNoteId);
      const audit = state.auditAccumulators.find((item) => item.sessionId === reservation.sessionId);
      if (!source || !audit
        || audit.auditContextHash !== prepared.nextAudit.auditContextHash
        || audit.auditVersion + 1 !== prepared.nextAudit.auditVersion) {
        throw new PrivateReservationStateError("private state changed before settlement confirmation");
      }
      if (prepared.refundBudgetNote) {
        const refund = prepared.refundBudgetNote;
        if (state.budgetNotes.some((item) => item.noteId === refund.noteId)
          || state.reservations.some((item) => item.reservationId === refund.noteId)) {
          throw new PrivateReservationStateError("refund budget note id collides with private state");
        }
        state.budgetNotes.push({
          noteId: refund.noteId,
          sessionId: reservation.sessionId,
          nodeId: source.nodeId,
          owner: source.owner,
          asset: source.asset,
          policyHash: source.policyHash,
          contextHash: refund.contextHash,
          commitment: refund.commitment,
          amountAtomic: refund.amountAtomic,
          blinding: refund.blinding,
          status: "ACTIVE",
        });
      }
      audit.totalSpendAtomic = prepared.nextAudit.totalSpendAtomic;
      audit.blinding = prepared.nextAudit.blinding;
      audit.commitment = prepared.nextAudit.commitment;
      audit.auditVersion = prepared.nextAudit.auditVersion;
      reservation.status = "SETTLED";
      reservation.settlementConfirmation = {
        transactionHash: toHex(transactionHash),
        ledgerSequence: input.ledgerSequence,
      };
      delete reservation.preparedSettlement;
    });
  }
}
