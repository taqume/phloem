import type { SppRuntimeBridge } from "./spp-private-transfer-adapter.js";
import type { TreasuryPrivacyKeyManager } from "./treasury-privacy-key.js";

export interface PreparedTreasurySppRebalance {
  readonly operationId: Buffer;
  readonly primaryNoteId: Buffer;
  readonly changeNoteId: Buffer;
  readonly primaryAmountAtomic: bigint;
  readonly changeAmountAtomic: bigint;
  readonly primaryOutputCommitment: bigint;
  readonly changeOutputCommitment: bigint;
  readonly unsignedTransactionXdr: string;
  readonly resource: Readonly<{
    readonly authEntries: number;
    readonly diskReadBytes: number;
    readonly envelopeBytes: number;
    readonly footprintReadOnlyEntries: number;
    readonly footprintReadWriteEntries: number;
    readonly instructions: number;
    readonly latestLedger: number;
    readonly resourceFeeStroops: string;
    readonly totalFeeStroops: string;
    readonly writeBytes: number;
  }>;
}

/** Treasury-authorized denomination maintenance; both SPP outputs remain treasury-owned. */
export class TreasurySppRebalancePlanner {
  readonly #treasuryKeys: TreasuryPrivacyKeyManager;
  readonly #bridge: SppRuntimeBridge;
  readonly #now: () => number;

  constructor(input: {
    readonly treasuryKeys: TreasuryPrivacyKeyManager;
    readonly bridge: SppRuntimeBridge;
    readonly now?: () => number;
  }) {
    this.#treasuryKeys = input.treasuryKeys;
    this.#bridge = input.bridge;
    this.#now = input.now ?? Date.now;
  }

  async prepare(input: {
    readonly sessionId: Uint8Array;
    readonly reservationId: Uint8Array;
    readonly pool: string;
    readonly primaryAmountAtomic: bigint;
  }): Promise<PreparedTreasurySppRebalance> {
    const sessionId = Buffer.from(input.sessionId);
    const reservationId = Buffer.from(input.reservationId);
    if (sessionId.length !== 32 || reservationId.length !== 32) {
      throw new RangeError("rebalance session and reservation ids must be exactly 32 bytes");
    }
    if (input.primaryAmountAtomic <= 0n || input.primaryAmountAtomic >= (1n << 64n)) {
      throw new RangeError("rebalance primary amount must be a positive u64");
    }

    return this.#treasuryKeys.withSppSpendContext(sessionId, input.pool, async (context) => {
      const candidate = context.notes
        .filter((note) => BigInt(note.amountAtomic) > input.primaryAmountAtomic)
        .toSorted((left, right) => {
          const amountOrder = BigInt(left.amountAtomic) - BigInt(right.amountAtomic);
          return amountOrder < 0n ? -1 : amountOrder > 0n ? 1 : left.noteId.localeCompare(right.noteId);
        })[0];
      if (!candidate) throw new Error("no treasury SPP note can be split for the reservation denomination");
      const inputAmount = BigInt(candidate.amountAtomic);
      const changeAmount = inputAmount - input.primaryAmountAtomic;
      const prepared = await this.#bridge.prepare({
        reservationId,
        sessionId,
        claimAmountAtomic: input.primaryAmountAtomic,
        refundAmountAtomic: changeAmount,
        providerSppPublicKey: BigInt(`0x${Buffer.from(context.notePublicKeyLe).reverse().toString("hex")}`),
        providerSppEncryptionPublicKey: context.encryptionPublicKey,
        treasurySppPublicKey: BigInt(`0x${Buffer.from(context.notePublicKeyLe).reverse().toString("hex")}`),
        poolContractId: input.pool,
        availableNotes: [candidate],
        notePrivateKeyLe: context.notePrivateKeyLe,
        notePublicKeyLe: context.notePublicKeyLe,
        encryptionPrivateKey: context.encryptionPrivateKey,
        encryptionPublicKey: context.encryptionPublicKey,
        membershipBlindingLe: context.membershipBlindingLe,
      });
      let primaryNoteId: Buffer | undefined;
      try {
        primaryNoteId = await this.#treasuryKeys.stageOwnedNote({
          sessionId,
          pool: input.pool,
          amountAtomic: input.primaryAmountAtomic,
          blinding: prepared.providerOutputBlinding,
          commitment: prepared.proof.output_commitment0,
          createdAtUnixMs: this.#now(),
        });
        const changeNoteId = await this.#treasuryKeys.stageSpendOperation({
          operationId: prepared.operationId,
          sessionId,
          pool: input.pool,
          inputNoteIds: prepared.inputNoteIds,
          expectedInputAmountAtomic: inputAmount,
          refund: {
            amountAtomic: changeAmount,
            blinding: prepared.refundOutputBlinding,
            commitment: prepared.proof.output_commitment1,
          },
          createdAtUnixMs: this.#now(),
        });
        if (!changeNoteId) throw new Error("treasury SPP rebalance did not stage its change note");
        return {
          operationId: prepared.operationId,
          primaryNoteId,
          changeNoteId,
          primaryAmountAtomic: input.primaryAmountAtomic,
          changeAmountAtomic: changeAmount,
          primaryOutputCommitment: prepared.proof.output_commitment0,
          changeOutputCommitment: prepared.proof.output_commitment1,
          unsignedTransactionXdr: prepared.unsignedTransactionXdr,
          resource: prepared.resource,
        };
      } catch (error: unknown) {
        await this.#treasuryKeys.abortSpendOperation(prepared.operationId).catch(() => undefined);
        if (primaryNoteId) {
          await this.#treasuryKeys.discardPreparedOwnedNote(primaryNoteId).catch(() => undefined);
        }
        await this.#bridge.abort(prepared.operationId).catch(() => undefined);
        throw error;
      }
    });
  }

  async abort(input: { readonly operationId: Uint8Array; readonly primaryNoteId: Uint8Array }): Promise<void> {
    const operationId = Buffer.from(input.operationId);
    await this.#bridge.abort(operationId);
    await this.#treasuryKeys.abortSpendOperation(operationId);
    await this.#treasuryKeys.discardPreparedOwnedNote(input.primaryNoteId);
  }

  async confirm(input: {
    readonly operationId: Uint8Array;
    readonly primaryNoteId: Uint8Array;
    readonly transactionHash: Uint8Array;
    readonly ledgerSequence: number;
    readonly primaryOutputCommitment: bigint;
    readonly changeOutputCommitment: bigint;
  }): Promise<void> {
    const operationId = Buffer.from(input.operationId);
    const transactionHash = Buffer.from(input.transactionHash);
    const leaves = await this.#bridge.confirm(
      operationId,
      transactionHash,
      input.ledgerSequence,
      input.primaryOutputCommitment,
      input.changeOutputCommitment,
      true,
    );
    if (leaves.refundLeafIndex === undefined) {
      throw new Error("treasury SPP rebalance confirmation is missing its change leaf");
    }
    await this.#treasuryKeys.confirmOwnedNote({
      noteId: input.primaryNoteId,
      leafIndex: leaves.providerLeafIndex,
      transactionHash,
      ledgerSequence: input.ledgerSequence,
    });
    await this.#treasuryKeys.confirmSpendOperation({
      operationId,
      transactionHash,
      ledgerSequence: input.ledgerSequence,
      refundLeafIndex: leaves.refundLeafIndex,
    });
  }
}
