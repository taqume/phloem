import type {
  PreparedSppPrivateTransfer,
  SppPrivateTransferPlanner,
} from "./private-settlement-planner.js";
import type { SppTreasuryNoteOpening } from "./state.js";
import type {
  TreasuryPrivacyKeyManager,
  TreasurySppNoteOwnership,
} from "./treasury-privacy-key.js";

export interface SppRuntimeBridgePrepareInput extends TreasurySppNoteOwnership {
  readonly reservationId: Buffer;
  readonly sessionId: Buffer;
  readonly claimAmountAtomic: bigint;
  readonly refundAmountAtomic: bigint;
  readonly providerSppPublicKey: bigint;
  readonly providerSppEncryptionPublicKey: Buffer;
  readonly treasurySppPublicKey: bigint;
  readonly poolContractId: string;
  readonly availableNotes: readonly SppTreasuryNoteOpening[];
}

export interface PreparedSppRuntimeTransfer extends PreparedSppPrivateTransfer {
  /** Exact encrypted-store note ids selected by the upstream planner. */
  readonly inputNoteIds: readonly Buffer[];
}

/**
 * Boundary around the pinned upstream SPP SDK. Implementations receive secrets
 * only for the duration of prepare() and must not write them to upstream
 * SQLite, logs, telemetry, or an unencrypted cache.
 */
export interface SppRuntimeBridge {
  prepare(input: SppRuntimeBridgePrepareInput): Promise<PreparedSppRuntimeTransfer>;
  abort(operationId: Buffer): Promise<void>;
  confirm(
    operationId: Buffer,
    transactionHash: Buffer,
    ledgerSequence: number,
    expectedProviderOutputCommitment: bigint,
    expectedSecondOutputCommitment: bigint,
    hasTreasuryRefund: boolean,
  ): Promise<{ readonly refundLeafIndex?: number }>;
}

export class EncryptedSppPrivateTransferPlanner implements SppPrivateTransferPlanner {
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
    readonly reservationId: Buffer;
    readonly sessionId: Buffer;
    readonly claimAmountAtomic: bigint;
    readonly refundAmountAtomic: bigint;
    readonly providerSppPublicKey: bigint;
    readonly providerSppEncryptionPublicKey: Buffer;
    readonly treasurySppPublicKey: bigint;
    readonly sppPool: string;
  }): Promise<PreparedSppPrivateTransfer> {
    const expectedInputAmount = input.claimAmountAtomic + input.refundAmountAtomic;
    return this.#treasuryKeys.withSppSpendContext(input.sessionId, input.sppPool, async (context) => {
      if (context.notes.length === 0) throw new Error("no active treasury SPP notes back this private reservation");
      const prepared = await this.#bridge.prepare({
        reservationId: input.reservationId,
        sessionId: input.sessionId,
        claimAmountAtomic: input.claimAmountAtomic,
        refundAmountAtomic: input.refundAmountAtomic,
        providerSppPublicKey: input.providerSppPublicKey,
        providerSppEncryptionPublicKey: input.providerSppEncryptionPublicKey,
        treasurySppPublicKey: input.treasurySppPublicKey,
        poolContractId: input.sppPool,
        availableNotes: context.notes,
        notePrivateKeyLe: context.notePrivateKeyLe,
        notePublicKeyLe: context.notePublicKeyLe,
        encryptionPrivateKey: context.encryptionPrivateKey,
        encryptionPublicKey: context.encryptionPublicKey,
        membershipBlindingLe: context.membershipBlindingLe,
      });
      try {
        await this.#treasuryKeys.stageSpendOperation({
          operationId: prepared.operationId,
          sessionId: input.sessionId,
          pool: input.sppPool,
          inputNoteIds: prepared.inputNoteIds,
          expectedInputAmountAtomic: expectedInputAmount,
          ...(input.refundAmountAtomic > 0n ? {
            refund: {
              amountAtomic: input.refundAmountAtomic,
              blinding: prepared.refundOutputBlinding,
              commitment: prepared.proof.output_commitment1,
            },
          } : {}),
          createdAtUnixMs: this.#now(),
        });
      } catch (error: unknown) {
        await this.#bridge.abort(prepared.operationId).catch(() => undefined);
        throw error;
      }
      return {
        operationId: prepared.operationId,
        proof: prepared.proof,
        extData: prepared.extData,
        providerOutputBlinding: prepared.providerOutputBlinding,
        refundOutputBlinding: prepared.refundOutputBlinding,
      };
    });
  }

  async abort(operationId: Buffer): Promise<void> {
    await this.#bridge.abort(operationId);
    await this.#treasuryKeys.abortSpendOperation(operationId);
  }

  async confirm(
    operationId: Buffer,
    transactionHash: Buffer,
    ledgerSequence: number,
    expectedProviderOutputCommitment: bigint,
    expectedSecondOutputCommitment: bigint,
    hasTreasuryRefund: boolean,
  ): Promise<void> {
    const result = await this.#bridge.confirm(
      operationId,
      transactionHash,
      ledgerSequence,
      expectedProviderOutputCommitment,
      expectedSecondOutputCommitment,
      hasTreasuryRefund,
    );
    await this.#treasuryKeys.confirmSpendOperation({
      operationId,
      transactionHash,
      ledgerSequence,
      ...(result.refundLeafIndex === undefined ? {} : { refundLeafIndex: result.refundLeafIndex }),
    });
  }
}
