import type {
  PreparedSppPrivateDeposit,
  SppPrivateDepositPlanner,
} from "./private-session-activation.js";
import type {
  TreasuryPrivacyKeyManager,
  TreasurySppNoteOwnership,
} from "./treasury-privacy-key.js";

export interface SppDepositRuntimeBridgeInput extends TreasurySppNoteOwnership {
  readonly sessionId: Buffer;
  readonly fundingSource: string;
  readonly amountAtomic: bigint;
  readonly treasurySppPublicKey: bigint;
  readonly treasuryEncryptionPublicKey: Buffer;
  readonly poolContractId: string;
}

/**
 * Native pinned-SPP boundary. Secret ownership bytes are borrowed for one
 * prepare call and must never be persisted, logged, cached, or retained.
 */
export interface SppDepositRuntimeBridge {
  prepare(input: SppDepositRuntimeBridgeInput): Promise<PreparedSppPrivateDeposit>;
  abort(operationId: Buffer): Promise<void>;
  confirm(
    operationId: Buffer,
    transactionHash: Buffer,
    ledgerSequence: number,
    expectedFundingCommitment: bigint,
  ): Promise<{ readonly fundingLeafIndex: number }>;
}

export class EncryptedSppPrivateDepositPlanner implements SppPrivateDepositPlanner {
  readonly #treasuryKeys: TreasuryPrivacyKeyManager;
  readonly #bridge: SppDepositRuntimeBridge;

  constructor(input: {
    readonly treasuryKeys: TreasuryPrivacyKeyManager;
    readonly bridge: SppDepositRuntimeBridge;
  }) {
    this.#treasuryKeys = input.treasuryKeys;
    this.#bridge = input.bridge;
  }

  async prepare(input: {
    readonly sessionId: Buffer;
    readonly fundingSource: string;
    readonly amountAtomic: bigint;
    readonly treasurySppPublicKey: bigint;
    readonly treasuryEncryptionPublicKey: Buffer;
    readonly sppPool: string;
  }): Promise<PreparedSppPrivateDeposit> {
    return this.#treasuryKeys.withSppNoteOwnership(input.sessionId, async (ownership) => {
      if (!ownership.encryptionPublicKey.equals(input.treasuryEncryptionPublicKey)) {
        throw new Error("SPP deposit encryption key differs from encrypted treasury ownership");
      }
      return this.#bridge.prepare({
        sessionId: input.sessionId,
        fundingSource: input.fundingSource,
        amountAtomic: input.amountAtomic,
        treasurySppPublicKey: input.treasurySppPublicKey,
        treasuryEncryptionPublicKey: input.treasuryEncryptionPublicKey,
        poolContractId: input.sppPool,
        notePrivateKeyLe: ownership.notePrivateKeyLe,
        notePublicKeyLe: ownership.notePublicKeyLe,
        encryptionPrivateKey: ownership.encryptionPrivateKey,
        encryptionPublicKey: ownership.encryptionPublicKey,
        membershipBlindingLe: ownership.membershipBlindingLe,
      });
    });
  }

  async abort(operationId: Buffer): Promise<void> {
    await this.#bridge.abort(operationId);
  }

  async confirm(
    operationId: Buffer,
    transactionHash: Buffer,
    ledgerSequence: number,
    expectedFundingCommitment: bigint,
  ): Promise<{ readonly fundingLeafIndex: number }> {
    return this.#bridge.confirm(
      operationId,
      transactionHash,
      ledgerSequence,
      expectedFundingCommitment,
    );
  }
}
