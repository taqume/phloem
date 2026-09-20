import {
  BN254_SCALAR_MODULUS,
  finalAuditQueryStatementHash,
} from "@phloem/protocol-types";
import type { Groth16Proof } from "@phloem/treasury-controller-client";

import type { Groth16ProvingArtifacts, LocalGroth16ProofWorker } from "./local-proof-worker.js";
import type { EncryptedPrivacyStateStore } from "./privacy-state-store.js";

const TOTAL_SPEND_LEQ_TEMPLATE_ID = "TOTAL_SPEND_LEQ";
const TOTAL_SPEND_LEQ_TEMPLATE_VERSION = 1;
const PUBLIC_INPUT_COUNT = 7;

export interface FinalAuditQueryStatement {
  readonly sessionId: Uint8Array;
  /** Exact vector returned by TreasuryController.get_total_spend_leq_inputs. */
  readonly publicInputs: readonly bigint[];
}

export interface AuditProofBundle {
  readonly templateId: typeof TOTAL_SPEND_LEQ_TEMPLATE_ID;
  readonly templateVersion: typeof TOTAL_SPEND_LEQ_TEMPLATE_VERSION;
  readonly sessionId: Buffer;
  readonly snapshotHash: Buffer;
  readonly thresholdAtomic: bigint;
  readonly auditVersion: number;
  readonly proof: Groth16Proof;
  readonly publicSignals: readonly bigint[];
}

export class AuditQueryStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditQueryStateError";
  }
}

function bytes32(value: Uint8Array, label: string): Buffer {
  if (value.length !== 32) throw new RangeError(`${label} must be exactly 32 bytes`);
  return Buffer.from(value);
}

function field(value: bigint, label: string): bigint {
  if (value < 0n || value >= BN254_SCALAR_MODULUS) {
    throw new AuditQueryStateError(`${label} is not a canonical BN254 field`);
  }
  return value;
}

function u64(value: bigint, label: string): bigint {
  if (value < 0n || value >= 1n << 64n) throw new RangeError(`${label} is not a u64`);
  return value;
}

function u128Bytes(value: bigint, label: string): Buffer {
  if (value < 0n || value >= 1n << 128n) throw new AuditQueryStateError(`${label} is not a u128 limb`);
  return Buffer.from(value.toString(16).padStart(32, "0"), "hex");
}

function sameSignals(actual: readonly bigint[], expected: readonly bigint[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export class FinalAuditQueryPlanner {
  readonly #store: EncryptedPrivacyStateStore;
  readonly #proofWorker: LocalGroth16ProofWorker;
  readonly #artifacts: Groth16ProvingArtifacts;

  constructor(input: {
    readonly store: EncryptedPrivacyStateStore;
    readonly proofWorker: LocalGroth16ProofWorker;
    readonly artifacts: Groth16ProvingArtifacts;
  }) {
    if (input.artifacts.publicInputCount !== PUBLIC_INPUT_COUNT) {
      throw new RangeError(`TOTAL_SPEND_LEQ requires exactly ${PUBLIC_INPUT_COUNT} public inputs`);
    }
    this.#store = input.store;
    this.#proofWorker = input.proofWorker;
    this.#artifacts = input.artifacts;
  }

  async proveTotalSpendLeq(statement: FinalAuditQueryStatement): Promise<AuditProofBundle> {
    const sessionId = bytes32(statement.sessionId, "session id");
    if (statement.publicInputs.length !== PUBLIC_INPUT_COUNT) {
      throw new AuditQueryStateError("controller returned an invalid AuditQL public-input count");
    }
    const publicInputs = statement.publicInputs.map((value, index) => field(value, `public input ${index}`));
    const [auditContext, snapshotHigh, snapshotLow, commitment, threshold, auditVersionField, statementHash] =
      publicInputs as [bigint, bigint, bigint, bigint, bigint, bigint, bigint];
    const thresholdAtomic = u64(threshold, "threshold");
    if (auditVersionField <= 0n || auditVersionField > 0xffff_ffffn) {
      throw new AuditQueryStateError("controller returned an invalid audit version");
    }
    const auditVersion = Number(auditVersionField);
    const snapshotHash = Buffer.concat([
      u128Bytes(snapshotHigh, "snapshot high limb"),
      u128Bytes(snapshotLow, "snapshot low limb"),
    ]);

    const state = await this.#store.readSnapshot();
    const audit = state.auditAccumulators.find((item) => item.sessionId === sessionId.toString("hex"));
    if (!audit) throw new AuditQueryStateError("private audit opening is unavailable for the final session");
    if (auditContext !== BigInt(audit.auditContextHash)
      || commitment !== BigInt(audit.commitment)
      || auditVersion !== audit.auditVersion) {
      throw new AuditQueryStateError("controller final audit state does not match the encrypted opening");
    }
    const expectedStatementHash = finalAuditQueryStatementHash(
      auditContext,
      snapshotHash,
      commitment,
      auditVersion,
    );
    if (statementHash !== expectedStatementHash) {
      throw new AuditQueryStateError("controller final snapshot statement is not canonical");
    }
    const totalSpendAtomic = u64(BigInt(audit.totalSpendAtomic), "private total spend");
    if (totalSpendAtomic > thresholdAtomic) {
      throw new AuditQueryStateError("TOTAL_SPEND_LEQ predicate is false for the requested threshold");
    }

    const result = await this.#proofWorker.prove({
      auditContextHash: auditContext.toString(),
      snapshotHigh: snapshotHigh.toString(),
      snapshotLow: snapshotLow.toString(),
      totalSpendCommitment: commitment.toString(),
      thresholdAtomic: thresholdAtomic.toString(),
      auditVersion: auditVersion.toString(),
      statementHash: statementHash.toString(),
      totalSpendAtomic: totalSpendAtomic.toString(),
      totalSpendBlinding: audit.blinding,
    }, this.#artifacts);
    if (!sameSignals(result.publicSignals, publicInputs)) {
      throw new AuditQueryStateError("AuditQL proof signals differ from the canonical controller statement");
    }

    return {
      templateId: TOTAL_SPEND_LEQ_TEMPLATE_ID,
      templateVersion: TOTAL_SPEND_LEQ_TEMPLATE_VERSION,
      sessionId,
      snapshotHash,
      thresholdAtomic,
      auditVersion,
      proof: result.proof,
      publicSignals: result.publicSignals,
    };
  }
}
