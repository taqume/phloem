import { randomBytes } from "node:crypto";

import {
  BN254_SCALAR_MODULUS,
  POSEIDON_DOMAINS,
  addressFromStrKey,
  bytes32ToLimbs,
  bytesToBigInt,
  encodePrivateVoucher,
  encodeUsageEvidence,
  poseidon2Hash2,
  poseidon2Hash3,
  poseidon2HashFields,
  sha256,
  toHex,
  type PrivateVoucherPayload,
  type UsageEvidence,
  type UsageEvidencePayload,
  usageEvidenceSchema,
} from "@phloem/protocol-types";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

import type { EncryptedPrivacyStateStore } from "./privacy-state-store.js";
import type { PrivacyState, ReservationOpening, VoucherOpening } from "./state.js";

export interface PrivateRandomSource {
  bytes(length: number): Uint8Array;
}

const secureRandom: PrivateRandomSource = {
  bytes: (length) => randomBytes(length),
};

export interface PrepareReservationOpeningInput {
  readonly reservationId: Uint8Array;
  readonly sessionId: Uint8Array;
  readonly sourceBudgetNoteId: Uint8Array;
  readonly sourceBudgetContextHash: bigint;
  readonly approvedProviderRoot: bigint;
  readonly categoryId: number;
  readonly networkId: Uint8Array;
  readonly treasuryController: string;
  readonly amountAtomic: bigint;
  readonly offerReferenceHash: Uint8Array;
  readonly providerSppPublicKey: bigint;
  readonly claimDeadlineLedger: number;
  readonly createdAtUnixMs: number;
}

export interface PreparedReservationPublicArtifacts {
  readonly reservationId: Buffer;
  readonly reservationContextHash: bigint;
  readonly amountCommitment: bigint;
  readonly offerCommitment: bigint;
  readonly providerCommitment: bigint;
  readonly voucherSignerPublicKey: Buffer;
}

export interface IssuedPrivateVoucher {
  readonly voucher: PrivateVoucherPayload;
  readonly signature: Buffer;
}

export interface AcceptedEvidenceVoucher extends IssuedPrivateVoucher {
  readonly evidenceHash: Buffer;
  readonly usageRoot: bigint;
}

export interface ControlledUsageEvidencePolicy {
  readonly providerIdentity: string;
  readonly serviceIdHash: Uint8Array;
  readonly categoryId: number;
}

export class PrivateReservationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateReservationStateError";
  }
}

function bytes32(value: Uint8Array, label: string): Buffer {
  if (value.length !== 32) throw new RangeError(`${label} must be exactly 32 bytes`);
  return Buffer.from(value);
}

function checkedU64(value: bigint, label: string): bigint {
  if (value <= 0n || value >= (1n << 64n)) throw new RangeError(`${label} must be a positive u64`);
  return value;
}

function checkedField(value: bigint, label: string): bigint {
  if (value < 0n || value >= BN254_SCALAR_MODULUS) throw new RangeError(`${label} must be a canonical BN254 field`);
  return value;
}

function randomField(random: PrivateRandomSource): bigint {
  for (;;) {
    const candidate = bytesToBigInt(bytes32(random.bytes(32), "random field"));
    if (candidate > 0n && candidate < BN254_SCALAR_MODULUS) return candidate;
  }
}

function publicArtifacts(opening: ReservationOpening): PreparedReservationPublicArtifacts {
  return {
    reservationId: Buffer.from(opening.reservationId, "hex"),
    reservationContextHash: BigInt(opening.reservationContextHash),
    amountCommitment: BigInt(opening.amountCommitment),
    offerCommitment: BigInt(opening.offerCommitment),
    providerCommitment: BigInt(opening.providerCommitment),
    voucherSignerPublicKey: Buffer.from(opening.voucherSignerPublicKeyHex, "hex"),
  };
}

function usageEvidencePayload(evidence: UsageEvidence): UsageEvidencePayload {
  return {
    protocolVersion: evidence.protocolVersion,
    evidenceVersion: evidence.evidenceVersion,
    networkId: Buffer.from(evidence.networkId, "hex"),
    treasuryController: addressFromStrKey(evidence.treasuryController),
    sessionId: Buffer.from(evidence.sessionId, "hex"),
    reservationId: Buffer.from(evidence.reservationId, "hex"),
    providerIdentity: addressFromStrKey(evidence.providerIdentity),
    serviceIdHash: Buffer.from(evidence.serviceIdHash, "hex"),
    categoryId: evidence.categoryId,
    requestId: Buffer.from(evidence.requestId, "hex"),
    requestHash: Buffer.from(evidence.requestHash, "hex"),
    responseHash: Buffer.from(evidence.responseHash, "hex"),
    usageUnits: BigInt(evidence.usageUnits),
    offerCommitment: BigInt(evidence.offerCommitment),
    providerSequence: BigInt(evidence.providerSequence),
    issuedAtLedger: evidence.issuedAtLedger,
    validUntilLedger: evidence.validUntilLedger,
    evidenceNonce: Buffer.from(evidence.evidenceNonce, "hex"),
  };
}

export function p0UsageEvidenceRoot(evidence: UsageEvidence): Readonly<{
  evidenceHash: Buffer;
  usageRoot: bigint;
}> {
  const evidenceHash = Buffer.from(sha256(encodeUsageEvidence(usageEvidencePayload(evidence))));
  const [hi, lo] = bytes32ToLimbs(evidenceHash);
  return Object.freeze({
    evidenceHash,
    usageRoot: poseidon2Hash2(hi, lo, POSEIDON_DOMAINS.merkleLeaf),
  });
}

function issueVoucherInState(
  state: PrivacyState,
  random: PrivateRandomSource,
  input: {
    readonly reservationId: Buffer;
    readonly sequence: bigint;
    readonly cumulativeAmountAtomic: bigint;
    readonly usageRoot: bigint;
    readonly expiryLedger: number;
  },
): IssuedPrivateVoucher {
  const id = toHex(input.reservationId);
  const opening = state.reservations.find((item) => item.reservationId === id);
  if (!opening || opening.status !== "OPEN") {
    throw new PrivateReservationStateError("voucher requires an open reservation");
  }
  if (input.cumulativeAmountAtomic > BigInt(opening.amountAtomic)) {
    throw new PrivateReservationStateError("cumulative voucher amount exceeds reservation authority");
  }
  if (input.expiryLedger <= 0 || input.expiryLedger > opening.claimDeadlineLedger) {
    throw new PrivateReservationStateError("voucher expiry exceeds the reservation claim deadline");
  }
  if (opening.latestVoucher) {
    if (input.sequence <= BigInt(opening.latestVoucher.sequence)) {
      throw new PrivateReservationStateError("voucher sequence must increase monotonically");
    }
    if (input.cumulativeAmountAtomic < BigInt(opening.latestVoucher.cumulativeAmountAtomic)) {
      throw new PrivateReservationStateError("cumulative voucher amount cannot decrease");
    }
  }

  const amountBlinding = randomField(random);
  const voucherContextHash = poseidon2HashFields(
    [
      BigInt(opening.reservationContextHash),
      BigInt(opening.offerCommitment),
      ...bytes32ToLimbs(Buffer.from(opening.voucherSignerPublicKeyHex, "hex")),
      input.usageRoot,
    ],
    POSEIDON_DOMAINS.contextInit,
    POSEIDON_DOMAINS.contextFold,
  );
  const cumulativeAmountCommitment = poseidon2Hash3(
    voucherContextHash,
    input.cumulativeAmountAtomic,
    amountBlinding,
    POSEIDON_DOMAINS.voucherAmount,
  );
  const voucher: PrivateVoucherPayload = {
    protocolVersion: 1,
    voucherVersion: 1,
    networkId: Buffer.from(opening.networkIdHex, "hex"),
    treasuryController: addressFromStrKey(opening.treasuryController),
    sessionId: Buffer.from(opening.sessionId, "hex"),
    reservationId: input.reservationId,
    sequence: input.sequence,
    cumulativeAmountCommitment,
    usageRoot: input.usageRoot,
    offerCommitment: BigInt(opening.offerCommitment),
    expiryLedger: input.expiryLedger,
  };
  const seed = Buffer.from(opening.voucherSignerSeedHex, "hex");
  let signature: Buffer;
  try {
    signature = Buffer.from(Keypair.fromRawEd25519Seed(seed).sign(encodePrivateVoucher(voucher)));
  } finally {
    seed.fill(0);
  }
  const voucherOpening: VoucherOpening = {
    sequence: input.sequence.toString(),
    cumulativeAmountAtomic: input.cumulativeAmountAtomic.toString(),
    amountBlinding: amountBlinding.toString(),
    cumulativeAmountCommitment: cumulativeAmountCommitment.toString(),
    usageRoot: input.usageRoot.toString(),
    expiryLedger: input.expiryLedger,
    signatureHex: toHex(signature),
  };
  opening.latestVoucher = voucherOpening;
  return { voucher, signature };
}

/** Reservation-specific key and cumulative voucher logic inside PrivacyRuntime. */
export class PrivateVoucherIssuer {
  readonly #store: EncryptedPrivacyStateStore;
  readonly #random: PrivateRandomSource;

  constructor(store: EncryptedPrivacyStateStore, random: PrivateRandomSource = secureRandom) {
    this.#store = store;
    this.#random = random;
  }

  async prepareReservation(input: PrepareReservationOpeningInput): Promise<PreparedReservationPublicArtifacts> {
    const reservationId = bytes32(input.reservationId, "reservation id");
    const sessionId = bytes32(input.sessionId, "session id");
    const sourceBudgetNoteId = bytes32(input.sourceBudgetNoteId, "source budget note id");
    const networkId = bytes32(input.networkId, "network id");
    const offerReferenceHash = bytes32(input.offerReferenceHash, "offer reference hash");
    const amountAtomic = checkedU64(input.amountAtomic, "reservation amount");
    checkedField(input.sourceBudgetContextHash, "source budget context hash");
    checkedField(input.approvedProviderRoot, "approved provider root");
    checkedField(input.providerSppPublicKey, "provider SPP public key");
    if (!StrKey.isValidContract(input.treasuryController)) {
      throw new TypeError("treasury controller must be a canonical C-address");
    }
    if (!Number.isSafeInteger(input.createdAtUnixMs) || input.createdAtUnixMs < 0) {
      throw new RangeError("creation time must be non-negative integer milliseconds");
    }
    if (!Number.isSafeInteger(input.claimDeadlineLedger) || input.claimDeadlineLedger <= 0) {
      throw new RangeError("claim deadline must be a positive ledger sequence");
    }
    if (!Number.isSafeInteger(input.categoryId) || input.categoryId < 0 || input.categoryId >= 64) {
      throw new RangeError("category id must fit the P0 policy mask");
    }

    const reservationContextHash = poseidon2HashFields(
      [input.sourceBudgetContextHash, ...bytes32ToLimbs(reservationId), input.approvedProviderRoot],
      POSEIDON_DOMAINS.contextInit,
      POSEIDON_DOMAINS.contextFold,
    );
    const amountBlinding = randomField(this.#random);
    const offerBlinding = randomField(this.#random);
    const providerBlinding = randomField(this.#random);
    const voucherSignerSeed = bytes32(this.#random.bytes(32), "voucher signer seed");
    const voucherSigner = Keypair.fromRawEd25519Seed(voucherSignerSeed);
    const voucherSignerPublicKey = voucherSigner.rawPublicKey();
    const amountCommitment = poseidon2Hash3(
      reservationContextHash,
      amountAtomic,
      amountBlinding,
      POSEIDON_DOMAINS.reservation,
    );
    const offerCommitment = poseidon2HashFields(
      [reservationContextHash, ...bytes32ToLimbs(offerReferenceHash), offerBlinding],
      POSEIDON_DOMAINS.offerInit,
      POSEIDON_DOMAINS.offerFold,
    );
    const providerCommitment = poseidon2Hash3(
      reservationContextHash,
      input.providerSppPublicKey,
      providerBlinding,
      POSEIDON_DOMAINS.providerInit,
    );
    const opening: ReservationOpening = {
      reservationId: toHex(reservationId),
      sessionId: toHex(sessionId),
      sourceBudgetNoteId: toHex(sourceBudgetNoteId),
      categoryId: input.categoryId,
      networkIdHex: toHex(networkId),
      treasuryController: input.treasuryController,
      reservationContextHash: reservationContextHash.toString(),
      approvedProviderRoot: input.approvedProviderRoot.toString(),
      amountAtomic: amountAtomic.toString(),
      amountBlinding: amountBlinding.toString(),
      amountCommitment: amountCommitment.toString(),
      offerReferenceHash: toHex(offerReferenceHash),
      offerBlinding: offerBlinding.toString(),
      offerCommitment: offerCommitment.toString(),
      providerSppPublicKey: input.providerSppPublicKey.toString(),
      providerBlinding: providerBlinding.toString(),
      providerCommitment: providerCommitment.toString(),
      voucherSignerSeedHex: toHex(voucherSignerSeed),
      voucherSignerPublicKeyHex: toHex(voucherSignerPublicKey),
      claimDeadlineLedger: input.claimDeadlineLedger,
      status: "PREPARED",
      createdAtUnixMs: input.createdAtUnixMs,
    };

    try {
      return await this.#store.transaction((state) => {
        const source = state.budgetNotes.find((item) => item.noteId === opening.sourceBudgetNoteId);
        if (!source || source.status !== "ACTIVE") {
          throw new PrivateReservationStateError("reservation source budget note is not active in private state");
        }
        if (source.sessionId !== opening.sessionId
          || source.contextHash !== input.sourceBudgetContextHash.toString()
          || BigInt(source.amountAtomic) < amountAtomic) {
          throw new PrivateReservationStateError("reservation source opening does not match the requested authority");
        }
        if (state.reservations.some((item) => item.reservationId === opening.reservationId)) {
          throw new PrivateReservationStateError("reservation id is already present in private state");
        }
        if (state.budgetNotes.some((item) => item.noteId === opening.reservationId)) {
          throw new PrivateReservationStateError("reservation id collides with an existing budget note");
        }
        if (state.reservations.some((item) => item.voucherSignerPublicKeyHex === opening.voucherSignerPublicKeyHex)) {
          throw new PrivateReservationStateError("voucher signer public key is already bound to another reservation");
        }
        if (state.reservations.some((item) => item.sourceBudgetNoteId === opening.sourceBudgetNoteId && item.status === "PREPARED")) {
          throw new PrivateReservationStateError("source budget note already has a prepared reservation");
        }
        source.status = "SPEND_PENDING";
        source.pendingOperationId = opening.reservationId;
        state.reservations.push(opening);
        return publicArtifacts(opening);
      });
    } finally {
      voucherSignerSeed.fill(0);
    }
  }

  async confirmReservationOpen(input: {
    readonly reservationId: Uint8Array;
    readonly transactionHash: Uint8Array;
    readonly ledgerSequence: number;
  }): Promise<void> {
    const id = toHex(bytes32(input.reservationId, "reservation id"));
    const transactionHash = toHex(bytes32(input.transactionHash, "transaction hash"));
    if (!Number.isSafeInteger(input.ledgerSequence) || input.ledgerSequence <= 0) {
      throw new RangeError("confirmation ledger must be a positive integer");
    }
    await this.#store.transaction((state) => {
      const opening = state.reservations.find((item) => item.reservationId === id);
      if (!opening || opening.status !== "PREPARED") {
        throw new PrivateReservationStateError("only a prepared reservation can become open");
      }
      const source = state.budgetNotes.find((item) => item.noteId === opening.sourceBudgetNoteId);
      if (!source || source.status !== "SPEND_PENDING" || source.pendingOperationId !== opening.reservationId) {
        throw new PrivateReservationStateError("prepared reservation no longer holds its source opening");
      }
      source.status = "SPENT";
      delete source.pendingOperationId;
      if (opening.preparedRemainder) {
        const remainder = opening.preparedRemainder;
        if (state.budgetNotes.some((item) => item.noteId === remainder.noteId)) {
          throw new PrivateReservationStateError("prepared remainder id is already present in private state");
        }
        state.budgetNotes.push({
          noteId: remainder.noteId,
          sessionId: opening.sessionId,
          nodeId: source.nodeId,
          owner: source.owner,
          asset: source.asset,
          policyHash: source.policyHash,
          contextHash: remainder.contextHash,
          commitment: remainder.commitment,
          amountAtomic: remainder.amountAtomic,
          blinding: remainder.blinding,
          status: "ACTIVE",
        });
      }
      opening.status = "OPEN";
      opening.openConfirmation = { transactionHash, ledgerSequence: input.ledgerSequence };
    });
  }

  async discardPreparedReservation(reservationId: Uint8Array): Promise<void> {
    const id = toHex(bytes32(reservationId, "reservation id"));
    await this.#store.transaction((state) => {
      const index = state.reservations.findIndex((item) => item.reservationId === id);
      if (index < 0 || state.reservations[index]!.status !== "PREPARED") {
        throw new PrivateReservationStateError("only a prepared reservation can be discarded");
      }
      const source = state.budgetNotes.find((item) => item.noteId === state.reservations[index]!.sourceBudgetNoteId);
      if (!source || source.status !== "SPEND_PENDING" || source.pendingOperationId !== id) {
        throw new PrivateReservationStateError("prepared reservation no longer holds its source opening");
      }
      source.status = "ACTIVE";
      delete source.pendingOperationId;
      state.reservations.splice(index, 1);
    });
  }

  async issueVoucher(input: {
    readonly reservationId: Uint8Array;
    readonly sequence: bigint;
    readonly cumulativeAmountAtomic: bigint;
    readonly usageRoot: bigint;
    readonly expiryLedger: number;
  }): Promise<IssuedPrivateVoucher> {
    const reservationId = bytes32(input.reservationId, "reservation id");
    const amount = checkedU64(input.cumulativeAmountAtomic, "cumulative voucher amount");
    checkedField(input.usageRoot, "usage root");
    if (input.sequence <= 0n || input.sequence >= (1n << 64n)) throw new RangeError("voucher sequence must be a positive u64");

    return this.#store.transaction((state) => issueVoucherInState(state, this.#random, {
      reservationId,
      sequence: input.sequence,
      cumulativeAmountAtomic: amount,
      usageRoot: input.usageRoot,
      expiryLedger: input.expiryLedger,
    }));
  }

  /** Atomically accepts one controlled-provider evidence leaf and issues its reservation voucher. */
  async acceptP0UsageEvidence(input: {
    readonly signedUsageEvidence: unknown;
    readonly policy: ControlledUsageEvidencePolicy;
    readonly currentLedger: number;
    readonly acceptedAtUnixMs: number;
  }): Promise<AcceptedEvidenceVoucher> {
    const evidence = usageEvidenceSchema.parse(input.signedUsageEvidence);
    const serviceIdHash = bytes32(input.policy.serviceIdHash, "service id hash");
    if (!Number.isSafeInteger(input.currentLedger) || input.currentLedger <= 0) {
      throw new RangeError("current ledger must be a positive integer");
    }
    if (!Number.isSafeInteger(input.acceptedAtUnixMs) || input.acceptedAtUnixMs < 0) {
      throw new RangeError("evidence acceptance time must be non-negative integer milliseconds");
    }
    const signingBytes = encodeUsageEvidence(usageEvidencePayload(evidence));
    if (!Keypair.fromPublicKey(evidence.providerIdentity).verify(
      signingBytes,
      Buffer.from(evidence.providerSignature, "hex"),
    )) {
      throw new PrivateReservationStateError("controlled provider UsageEvidence signature is invalid");
    }
    const { evidenceHash, usageRoot } = p0UsageEvidenceRoot(evidence);

    return this.#store.transaction((state) => {
      const opening = state.reservations.find((item) => item.reservationId === evidence.reservationId);
      if (!opening || opening.status !== "OPEN") {
        throw new PrivateReservationStateError("usage evidence requires an open reservation");
      }
      if (evidence.sessionId !== opening.sessionId
        || evidence.networkId !== opening.networkIdHex
        || evidence.treasuryController !== opening.treasuryController
        || evidence.offerCommitment !== opening.offerCommitment
        || evidence.providerIdentity !== input.policy.providerIdentity
        || evidence.serviceIdHash !== toHex(serviceIdHash)
        || evidence.categoryId !== input.policy.categoryId) {
        throw new PrivateReservationStateError("usage evidence differs from its reservation or controlled provider");
      }
      if (evidence.usageUnits !== "1" || evidence.providerSequence !== "1") {
        throw new PrivateReservationStateError("P0 requires exactly one usage unit at provider sequence one");
      }
      if (evidence.issuedAtLedger > input.currentLedger || evidence.validUntilLedger <= input.currentLedger) {
        throw new PrivateReservationStateError("usage evidence is not live at the current ledger");
      }
      if (state.usageEvidence.some((item) => (
        item.evidenceHash === toHex(evidenceHash)
        || (item.evidence.reservationId === evidence.reservationId
          && item.evidence.providerSequence === evidence.providerSequence)
      ))) {
        throw new PrivateReservationStateError("usage evidence replay is not allowed");
      }
      state.usageEvidence.push({
        evidenceHash: toHex(evidenceHash),
        usageRoot: usageRoot.toString(),
        acceptedAtUnixMs: input.acceptedAtUnixMs,
        evidence,
      });
      const issued = issueVoucherInState(state, this.#random, {
        reservationId: Buffer.from(opening.reservationId, "hex"),
        sequence: 1n,
        cumulativeAmountAtomic: BigInt(opening.amountAtomic),
        usageRoot,
        expiryLedger: Math.min(evidence.validUntilLedger, opening.claimDeadlineLedger),
      });
      return { ...issued, evidenceHash, usageRoot };
    });
  }
}
