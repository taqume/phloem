import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";

import {
  BN254_SCALAR_MODULUS,
  POSEIDON_DOMAINS,
  fieldToBytes,
  poseidon2Hash2,
  poseidon2Hash3,
  toHex,
} from "@phloem/protocol-types/encoding";

import type { EncryptedPrivacyStateStore } from "./privacy-state-store.js";
import type { SppTreasuryNoteOpening } from "./state.js";
import type { PrivateRandomSource } from "./voucher-issuer.js";

const SPP_NOTE_PUBLIC_KEY_DOMAIN = 3n;
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const secureRandom: PrivateRandomSource = { bytes: (length) => randomBytes(length) };

export interface TreasuryPrivacyPublicArtifacts {
  readonly sessionId: Buffer;
  /** SPP BN254 note-ownership public component. It is not the on-chain Phloem commitment. */
  readonly notePublicKey: bigint;
  /** X25519 key used by SPP to encrypt outputs owned by this treasury session. */
  readonly encryptionPublicKey: Buffer;
  /** Session/audit-scoped Phloem commitment to notePublicKey. */
  readonly commitment: bigint;
}

export interface TreasurySppKeyCommitmentOpening {
  readonly publicKey: bigint;
  readonly blinding: bigint;
  readonly commitment: bigint;
}

export interface TreasurySppNoteOwnership {
  readonly notePrivateKeyLe: Buffer;
  readonly notePublicKeyLe: Buffer;
  readonly encryptionPrivateKey: Buffer;
  readonly encryptionPublicKey: Buffer;
  readonly membershipBlindingLe: Buffer;
}

export interface TreasurySppSpendContext extends TreasurySppNoteOwnership {
  readonly notes: readonly SppTreasuryNoteOpening[];
}

export interface TreasurySppRefundOpening {
  readonly amountAtomic: bigint;
  readonly blinding: bigint;
  readonly commitment: bigint;
}

export class TreasuryPrivacyKeyStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TreasuryPrivacyKeyStateError";
  }
}

function bytes32(value: Uint8Array, label: string): Buffer {
  if (value.length !== 32) throw new RangeError(`${label} must be exactly 32 bytes`);
  return Buffer.from(value);
}

function checkedField(value: bigint, label: string): bigint {
  if (value < 0n || value >= BN254_SCALAR_MODULUS) throw new RangeError(`${label} must be a canonical BN254 field`);
  return value;
}

function checkedPositiveU64(value: bigint, label: string): bigint {
  if (value <= 0n || value >= (1n << 64n)) throw new RangeError(`${label} must be a positive u64`);
  return value;
}

function fieldFromLittleEndian(bytes: Uint8Array): bigint {
  return BigInt(`0x${Buffer.from(bytes).reverse().toString("hex")}`);
}

function fieldToLittleEndian(value: bigint): Buffer {
  return Buffer.from(fieldToBytes(checkedField(value, "field"))).reverse();
}

function randomField(random: PrivateRandomSource): bigint {
  for (;;) {
    const value = bytes32(random.bytes(32), "private field entropy");
    value[31] = value[31]! & 0x1f;
    const field = fieldFromLittleEndian(value);
    value.fill(0);
    if (field > 0n) return field;
  }
}

export function deriveSppNotePublicKey(notePrivateKeyLe: Uint8Array): bigint {
  const privateKey = fieldFromLittleEndian(bytes32(notePrivateKeyLe, "SPP note private key"));
  checkedField(privateKey, "SPP note private key");
  if (privateKey === 0n) throw new RangeError("SPP note private key must be non-zero");
  return poseidon2Hash2(privateKey, 0n, SPP_NOTE_PUBLIC_KEY_DOMAIN);
}

export function deriveX25519PublicKey(privateKey: Uint8Array): Buffer {
  const rawPrivateKey = bytes32(privateKey, "X25519 private key");
  try {
    const privateKeyObject = createPrivateKey({
      key: Buffer.concat([X25519_PKCS8_PREFIX, rawPrivateKey]),
      format: "der",
      type: "pkcs8",
    });
    const encoded = Buffer.from(createPublicKey(privateKeyObject).export({ format: "der", type: "spki" }));
    if (!encoded.subarray(0, X25519_SPKI_PREFIX.length).equals(X25519_SPKI_PREFIX)
      || encoded.length !== X25519_SPKI_PREFIX.length + 32) {
      throw new TreasuryPrivacyKeyStateError("unexpected X25519 public-key encoding");
    }
    return Buffer.from(encoded.subarray(X25519_SPKI_PREFIX.length));
  } finally {
    rawPrivateKey.fill(0);
  }
}

/** Owns SPP treasury key material and note openings exclusively in the encrypted Phloem store. */
export class TreasuryPrivacyKeyManager {
  readonly #store: EncryptedPrivacyStateStore;
  readonly #random: PrivateRandomSource;

  constructor(store: EncryptedPrivacyStateStore, random: PrivateRandomSource = secureRandom) {
    this.#store = store;
    this.#random = random;
  }

  async createForSession(input: {
    readonly sessionId: Uint8Array;
    readonly auditContextHash: bigint;
    readonly createdAtUnixMs: number;
  }): Promise<TreasuryPrivacyPublicArtifacts> {
    const sessionId = bytes32(input.sessionId, "session id");
    checkedField(input.auditContextHash, "audit context hash");
    if (!Number.isSafeInteger(input.createdAtUnixMs) || input.createdAtUnixMs < 0) {
      throw new RangeError("creation time must be non-negative integer milliseconds");
    }

    const notePrivateKey = fieldToLittleEndian(randomField(this.#random));
    const encryptionPrivateKey = bytes32(this.#random.bytes(32), "X25519 private key entropy");
    try {
      const notePublicKey = deriveSppNotePublicKey(notePrivateKey);
      const encryptionPublicKey = deriveX25519PublicKey(encryptionPrivateKey);
      const membershipBlinding = randomField(this.#random);
      const commitmentBlinding = randomField(this.#random);
      const commitment = poseidon2Hash3(
        input.auditContextHash,
        notePublicKey,
        commitmentBlinding,
        POSEIDON_DOMAINS.sppTreasuryKey,
      );
      await this.#store.transaction((state) => {
        const id = toHex(sessionId);
        if (state.treasuryPrivacyKeys.some((item) => item.sessionId === id)) {
          throw new TreasuryPrivacyKeyStateError("treasury privacy key already exists for session");
        }
        const audit = state.auditAccumulators.find((item) => item.sessionId === id);
        if (audit && audit.auditContextHash !== input.auditContextHash.toString()) {
          throw new TreasuryPrivacyKeyStateError("treasury privacy key audit context does not match session state");
        }
        state.treasuryPrivacyKeys.push({
          sessionId: id,
          auditContextHash: input.auditContextHash.toString(),
          notePrivateKeyLeHex: toHex(notePrivateKey),
          notePublicKey: notePublicKey.toString(),
          encryptionPrivateKeyHex: toHex(encryptionPrivateKey),
          encryptionPublicKeyHex: toHex(encryptionPublicKey),
          membershipBlinding: membershipBlinding.toString(),
          commitmentBlinding: commitmentBlinding.toString(),
          commitment: commitment.toString(),
          createdAtUnixMs: input.createdAtUnixMs,
        });
      });
      return { sessionId, notePublicKey, encryptionPublicKey, commitment };
    } finally {
      notePrivateKey.fill(0);
      encryptionPrivateKey.fill(0);
    }
  }

  async ensureForSession(input: {
    readonly sessionId: Uint8Array;
    readonly auditContextHash: bigint;
    readonly createdAtUnixMs: number;
  }): Promise<TreasuryPrivacyPublicArtifacts> {
    const sessionId = bytes32(input.sessionId, "session id");
    const id = toHex(sessionId);
    const existing = (await this.#store.readSnapshot()).treasuryPrivacyKeys.some((item) => item.sessionId === id);
    if (!existing) {
      try {
        return await this.createForSession(input);
      } catch (error: unknown) {
        if (!(error instanceof TreasuryPrivacyKeyStateError)
          || !error.message.includes("already exists")) throw error;
      }
    }
    const opening = await this.getCommitmentOpening(sessionId, input.auditContextHash);
    let encryptionPublicKey = Buffer.alloc(0);
    await this.withSppNoteOwnership(sessionId, (ownership) => {
      encryptionPublicKey = Buffer.from(ownership.encryptionPublicKey);
    });
    return {
      sessionId,
      notePublicKey: opening.publicKey,
      encryptionPublicKey,
      commitment: opening.commitment,
    };
  }

  async getCommitmentOpening(sessionIdInput: Uint8Array, auditContextHash: bigint): Promise<TreasurySppKeyCommitmentOpening> {
    const sessionId = toHex(bytes32(sessionIdInput, "session id"));
    const state = await this.#store.readSnapshot();
    const stored = state.treasuryPrivacyKeys.find((item) => item.sessionId === sessionId);
    if (!stored || stored.auditContextHash !== checkedField(auditContextHash, "audit context hash").toString()) {
      throw new TreasuryPrivacyKeyStateError("treasury privacy key is unavailable for session audit context");
    }
    const notePrivateKey = Buffer.from(stored.notePrivateKeyLeHex, "hex");
    const encryptionPrivateKey = Buffer.from(stored.encryptionPrivateKeyHex, "hex");
    try {
      const publicKey = deriveSppNotePublicKey(notePrivateKey);
      if (publicKey.toString() !== stored.notePublicKey
        || !deriveX25519PublicKey(encryptionPrivateKey).equals(Buffer.from(stored.encryptionPublicKeyHex, "hex"))) {
        throw new TreasuryPrivacyKeyStateError("treasury privacy key public components failed integrity validation");
      }
      const blinding = BigInt(stored.commitmentBlinding);
      const commitment = poseidon2Hash3(auditContextHash, publicKey, blinding, POSEIDON_DOMAINS.sppTreasuryKey);
      if (commitment.toString() !== stored.commitment) {
        throw new TreasuryPrivacyKeyStateError("treasury privacy key commitment failed integrity validation");
      }
      return { publicKey, blinding, commitment };
    } finally {
      notePrivateKey.fill(0);
      encryptionPrivateKey.fill(0);
    }
  }

  async withSppNoteOwnership<T>(
    sessionIdInput: Uint8Array,
    callback: (ownership: TreasurySppNoteOwnership) => T | Promise<T>,
  ): Promise<T> {
    const sessionId = toHex(bytes32(sessionIdInput, "session id"));
    const stored = (await this.#store.readSnapshot()).treasuryPrivacyKeys.find((item) => item.sessionId === sessionId);
    if (!stored) throw new TreasuryPrivacyKeyStateError("treasury privacy key is unavailable for session");
    const ownership: TreasurySppNoteOwnership = {
      notePrivateKeyLe: Buffer.from(stored.notePrivateKeyLeHex, "hex"),
      notePublicKeyLe: fieldToLittleEndian(BigInt(stored.notePublicKey)),
      encryptionPrivateKey: Buffer.from(stored.encryptionPrivateKeyHex, "hex"),
      encryptionPublicKey: Buffer.from(stored.encryptionPublicKeyHex, "hex"),
      membershipBlindingLe: fieldToLittleEndian(BigInt(stored.membershipBlinding)),
    };
    try {
      return await callback(ownership);
    } finally {
      ownership.notePrivateKeyLe.fill(0);
      ownership.notePublicKeyLe.fill(0);
      ownership.encryptionPrivateKey.fill(0);
      ownership.encryptionPublicKey.fill(0);
      ownership.membershipBlindingLe.fill(0);
    }
  }

  async stageOwnedNote(input: {
    readonly sessionId: Uint8Array;
    readonly pool: string;
    readonly amountAtomic: bigint;
    readonly blinding: bigint;
    readonly commitment: bigint;
    readonly createdAtUnixMs: number;
  }): Promise<Buffer> {
    const sessionId = bytes32(input.sessionId, "session id");
    const key = await this.getCommitmentOpening(sessionId, this.#auditContextForSession(await this.#store.readSnapshot(), toHex(sessionId)));
    const amount = checkedPositiveU64(input.amountAtomic, "SPP note amount");
    const blinding = checkedField(input.blinding, "SPP note blinding");
    const commitment = checkedField(input.commitment, "SPP note commitment");
    if (poseidon2Hash3(amount, key.publicKey, blinding, POSEIDON_DOMAINS.sppNote) !== commitment) {
      throw new TreasuryPrivacyKeyStateError("SPP note opening does not match treasury ownership commitment");
    }
    const noteId = bytes32(this.#random.bytes(32), "SPP note id entropy");
    await this.#store.transaction((state) => {
      if (!state.treasuryPrivacyKeys.some((item) => item.sessionId === toHex(sessionId))) {
        throw new TreasuryPrivacyKeyStateError("treasury privacy key disappeared before note persistence");
      }
      state.sppTreasuryNotes.push({
        noteId: toHex(noteId),
        sessionId: toHex(sessionId),
        pool: input.pool,
        commitment: commitment.toString(),
        amountAtomic: amount.toString(),
        blinding: blinding.toString(),
        status: "PREPARED",
        createdAtUnixMs: input.createdAtUnixMs,
      });
    });
    return noteId;
  }

  async confirmOwnedNote(input: {
    readonly noteId: Uint8Array;
    readonly leafIndex: number;
    readonly transactionHash: Uint8Array;
    readonly ledgerSequence: number;
  }): Promise<void> {
    const noteId = toHex(bytes32(input.noteId, "SPP note id"));
    const transactionHash = toHex(bytes32(input.transactionHash, "transaction hash"));
    if (!Number.isSafeInteger(input.leafIndex) || input.leafIndex < 0) throw new RangeError("leaf index must be non-negative");
    if (!Number.isSafeInteger(input.ledgerSequence) || input.ledgerSequence <= 0) throw new RangeError("ledger must be positive");
    await this.#store.transaction((state) => {
      const note = state.sppTreasuryNotes.find((item) => item.noteId === noteId);
      if (!note || note.status !== "PREPARED") throw new TreasuryPrivacyKeyStateError("only a prepared SPP note can be confirmed");
      note.status = "ACTIVE";
      note.leafIndex = input.leafIndex;
      note.confirmation = { transactionHash, ledgerSequence: input.ledgerSequence };
    });
  }

  async withSppSpendContext<T>(
    sessionIdInput: Uint8Array,
    pool: string,
    callback: (context: TreasurySppSpendContext) => T | Promise<T>,
  ): Promise<T> {
    const sessionId = bytes32(sessionIdInput, "session id");
    const snapshot = await this.#store.readSnapshot();
    const notes = snapshot.sppTreasuryNotes.filter(
      (item) => item.sessionId === toHex(sessionId) && item.pool === pool && item.status === "ACTIVE",
    );
    return this.withSppNoteOwnership(sessionId, (ownership) => callback({ ...ownership, notes }));
  }

  async stageSpendOperation(input: {
    readonly operationId: Uint8Array;
    readonly sessionId: Uint8Array;
    readonly pool: string;
    readonly inputNoteIds: readonly Uint8Array[];
    readonly expectedInputAmountAtomic: bigint;
    readonly refund?: TreasurySppRefundOpening;
    readonly createdAtUnixMs: number;
  }): Promise<Buffer | undefined> {
    const operationId = toHex(bytes32(input.operationId, "SPP operation id"));
    const sessionId = toHex(bytes32(input.sessionId, "session id"));
    if (input.inputNoteIds.length < 1 || input.inputNoteIds.length > 2) {
      throw new TreasuryPrivacyKeyStateError("SPP spend must consume one or two treasury notes");
    }
    const inputNoteIds = input.inputNoteIds.map((noteId) => toHex(bytes32(noteId, "SPP input note id")));
    if (new Set(inputNoteIds).size !== inputNoteIds.length) {
      throw new TreasuryPrivacyKeyStateError("SPP spend input note ids must be unique");
    }
    const expectedInputAmount = checkedPositiveU64(input.expectedInputAmountAtomic, "SPP spend input amount");
    if (!Number.isSafeInteger(input.createdAtUnixMs) || input.createdAtUnixMs < 0) {
      throw new RangeError("creation time must be non-negative integer milliseconds");
    }
    let refund: { amount: bigint; blinding: bigint; commitment: bigint; noteId: Buffer } | undefined;
    if (input.refund) {
      refund = {
        amount: checkedPositiveU64(input.refund.amountAtomic, "SPP refund amount"),
        blinding: checkedField(input.refund.blinding, "SPP refund blinding"),
        commitment: checkedField(input.refund.commitment, "SPP refund commitment"),
        noteId: bytes32(this.#random.bytes(32), "SPP refund note id entropy"),
      };
    }

    await this.#store.transaction((state) => {
      if (state.sppSpendOperations.some((item) => item.operationId === operationId)) {
        throw new TreasuryPrivacyKeyStateError("SPP spend operation already exists");
      }
      const notes = inputNoteIds.map((noteId) => state.sppTreasuryNotes.find((item) => item.noteId === noteId));
      if (notes.some((note) => note === undefined
        || note.sessionId !== sessionId
        || note.pool !== input.pool
        || note.status !== "ACTIVE")) {
        throw new TreasuryPrivacyKeyStateError("SPP spend inputs must be active treasury notes in the bound session and pool");
      }
      const inputAmount = notes.reduce((sum, note) => sum + BigInt(note!.amountAtomic), 0n);
      if (inputAmount !== expectedInputAmount) {
        throw new TreasuryPrivacyKeyStateError("SPP treasury inputs do not exactly back the private reservation");
      }
      if (refund) {
        const key = state.treasuryPrivacyKeys.find((item) => item.sessionId === sessionId);
        if (!key) throw new TreasuryPrivacyKeyStateError("treasury privacy key is unavailable for SPP refund");
        const expectedCommitment = poseidon2Hash3(
          refund.amount,
          BigInt(key.notePublicKey),
          refund.blinding,
          POSEIDON_DOMAINS.sppNote,
        );
        if (expectedCommitment !== refund.commitment) {
          throw new TreasuryPrivacyKeyStateError("SPP refund note is not owned by the session treasury key");
        }
      }
      for (const note of notes) {
        note!.status = "SPEND_PENDING";
        note!.pendingOperationId = operationId;
      }
      if (refund) {
        state.sppTreasuryNotes.push({
          noteId: toHex(refund.noteId),
          sessionId,
          pool: input.pool,
          commitment: refund.commitment.toString(),
          amountAtomic: refund.amount.toString(),
          blinding: refund.blinding.toString(),
          status: "PREPARED",
          createdAtUnixMs: input.createdAtUnixMs,
        });
      }
      state.sppSpendOperations.push({
        operationId,
        sessionId,
        pool: input.pool,
        inputNoteIds,
        ...(refund ? { refundNoteId: toHex(refund.noteId) } : {}),
        status: "PREPARED",
        createdAtUnixMs: input.createdAtUnixMs,
      });
    });
    return refund?.noteId;
  }

  async abortSpendOperation(operationIdInput: Uint8Array): Promise<void> {
    const operationId = toHex(bytes32(operationIdInput, "SPP operation id"));
    await this.#store.transaction((state) => {
      const index = state.sppSpendOperations.findIndex((item) => item.operationId === operationId);
      const operation = state.sppSpendOperations[index];
      if (!operation) throw new TreasuryPrivacyKeyStateError("SPP spend operation is unavailable");
      if (operation.status !== "PREPARED") throw new TreasuryPrivacyKeyStateError("confirmed SPP spend cannot be aborted");
      for (const noteId of operation.inputNoteIds) {
        const note = state.sppTreasuryNotes.find((item) => item.noteId === noteId);
        if (!note || note.status !== "SPEND_PENDING" || note.pendingOperationId !== operationId) {
          throw new TreasuryPrivacyKeyStateError("SPP pending input state is inconsistent");
        }
        note.status = "ACTIVE";
        delete note.pendingOperationId;
      }
      if (operation.refundNoteId) {
        const refundIndex = state.sppTreasuryNotes.findIndex((item) => item.noteId === operation.refundNoteId);
        const refund = state.sppTreasuryNotes[refundIndex];
        if (!refund || refund.status !== "PREPARED") {
          throw new TreasuryPrivacyKeyStateError("SPP prepared refund state is inconsistent");
        }
        state.sppTreasuryNotes.splice(refundIndex, 1);
      }
      state.sppSpendOperations.splice(index, 1);
    });
  }

  async confirmSpendOperation(input: {
    readonly operationId: Uint8Array;
    readonly transactionHash: Uint8Array;
    readonly ledgerSequence: number;
    readonly refundLeafIndex?: number;
  }): Promise<void> {
    const operationId = toHex(bytes32(input.operationId, "SPP operation id"));
    const transactionHash = toHex(bytes32(input.transactionHash, "transaction hash"));
    if (!Number.isSafeInteger(input.ledgerSequence) || input.ledgerSequence <= 0) {
      throw new RangeError("ledger must be positive");
    }
    if (input.refundLeafIndex !== undefined
      && (!Number.isSafeInteger(input.refundLeafIndex) || input.refundLeafIndex < 0)) {
      throw new RangeError("refund leaf index must be non-negative");
    }
    await this.#store.transaction((state) => {
      const operation = state.sppSpendOperations.find((item) => item.operationId === operationId);
      if (!operation) throw new TreasuryPrivacyKeyStateError("SPP spend operation is unavailable");
      if (operation.status === "CONFIRMED") {
        if (operation.confirmation?.transactionHash !== transactionHash
          || operation.confirmation.ledgerSequence !== input.ledgerSequence) {
          throw new TreasuryPrivacyKeyStateError("SPP spend confirmation conflicts with persisted state");
        }
        return;
      }
      for (const noteId of operation.inputNoteIds) {
        const note = state.sppTreasuryNotes.find((item) => item.noteId === noteId);
        if (!note || note.status !== "SPEND_PENDING" || note.pendingOperationId !== operationId) {
          throw new TreasuryPrivacyKeyStateError("SPP pending input state is inconsistent");
        }
        note.status = "SPENT";
        delete note.pendingOperationId;
      }
      if (operation.refundNoteId) {
        if (input.refundLeafIndex === undefined) {
          throw new TreasuryPrivacyKeyStateError("SPP refund confirmation requires its on-chain leaf index");
        }
        const refund = state.sppTreasuryNotes.find((item) => item.noteId === operation.refundNoteId);
        if (!refund || refund.status !== "PREPARED") {
          throw new TreasuryPrivacyKeyStateError("SPP prepared refund state is inconsistent");
        }
        refund.status = "ACTIVE";
        refund.leafIndex = input.refundLeafIndex;
        refund.confirmation = { transactionHash, ledgerSequence: input.ledgerSequence };
      } else if (input.refundLeafIndex !== undefined) {
        throw new TreasuryPrivacyKeyStateError("SPP confirmation returned an unexpected treasury refund leaf");
      }
      operation.status = "CONFIRMED";
      operation.confirmation = { transactionHash, ledgerSequence: input.ledgerSequence };
    });
  }

  #auditContextForSession(state: Awaited<ReturnType<EncryptedPrivacyStateStore["readSnapshot"]>>, sessionId: string): bigint {
    const key = state.treasuryPrivacyKeys.find((item) => item.sessionId === sessionId);
    if (!key) throw new TreasuryPrivacyKeyStateError("treasury privacy key is unavailable for session");
    return BigInt(key.auditContextHash);
  }
}
