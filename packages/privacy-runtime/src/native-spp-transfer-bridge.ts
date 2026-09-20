import { BN254_SCALAR_MODULUS, toHex } from "@phloem/protocol-types";
import { StrKey, rpc } from "@stellar/stellar-sdk";

import {
  PINNED_SPP_NETWORK,
  PINNED_SPP_POOL,
  PINNED_SPP_SOURCE_REVISION,
  StellarSppDepositConfirmationSource,
  findSppCommitmentLeafIndex,
  type SppDepositBridgeProcess,
  type SppDepositConfirmationSource,
} from "./native-spp-deposit-bridge.js";
import type {
  PreparedSppRuntimeTransfer,
  SppRuntimeBridge,
  SppRuntimeBridgePrepareInput,
} from "./spp-private-transfer-adapter.js";

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

function falseValue(value: unknown, label: string): void {
  if (value !== false) throw new Error(`${label} must remain false`);
}

function hexBytes(value: unknown, length: number, label: string): Buffer {
  const encoded = stringValue(value, label);
  if (!/^(?:[0-9a-f]{2})+$/iu.test(encoded)) throw new TypeError(`${label} must be hex`);
  const bytes = Buffer.from(encoded, "hex");
  if (bytes.length !== length) throw new RangeError(`${label} must be exactly ${length} bytes`);
  return bytes;
}

function variableHexBytes(value: unknown, label: string): Buffer {
  const encoded = stringValue(value, label);
  if (!/^(?:[0-9a-f]{2})+$/iu.test(encoded)) throw new TypeError(`${label} must be hex`);
  const bytes = Buffer.from(encoded, "hex");
  if (bytes.length === 0) throw new RangeError(`${label} must not be empty`);
  return bytes;
}

function field(value: unknown, label: string): bigint {
  const parsed = BigInt(stringValue(value, label));
  if (parsed < 0n || parsed >= BN254_SCALAR_MODULUS) {
    throw new RangeError(`${label} must be a canonical BN254 field`);
  }
  return parsed;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function fieldLeHex(value: bigint, label: string): string {
  if (value < 0n || value >= BN254_SCALAR_MODULUS) {
    throw new RangeError(`${label} must be a canonical BN254 field`);
  }
  return Buffer.from(value.toString(16).padStart(64, "0"), "hex").reverse().toString("hex");
}

function parseBridgeResponse(output: Buffer): PreparedSppRuntimeTransfer {
  let decoded: unknown;
  try {
    decoded = JSON.parse(output.toString("utf8"));
  } catch {
    throw new Error("native SPP transfer bridge returned malformed output");
  } finally {
    output.fill(0);
  }
  const root = record(decoded, "transfer bridge response");
  if (root.schemaVersion !== 1) throw new Error("native SPP transfer bridge schema differs from version 1");
  if (root.sourceRevision !== PINNED_SPP_SOURCE_REVISION) throw new Error("native SPP source revision differs from the pin");
  if (root.network !== PINNED_SPP_NETWORK) throw new Error("native SPP transfer bridge returned the wrong network");
  falseValue(root.assetMovement, "asset movement");
  falseValue(root.signed, "signed state");
  falseValue(root.submitted, "submitted state");
  const safety = record(root.safety, "transfer bridge safety");
  if (safety.storage !== "ephemeral-memory-no-sqlite") {
    throw new Error("native SPP transfer bridge used an unauthorized storage mode");
  }
  const proof = record(root.proof, "SPP proof");
  const inputNullifiers = proof.inputNullifiers;
  if (!Array.isArray(inputNullifiers) || inputNullifiers.length !== 2) {
    throw new Error("SPP transfer proof must have two input nullifiers");
  }
  const inputNoteIds = root.inputNoteIdsHex;
  if (!Array.isArray(inputNoteIds) || inputNoteIds.length < 1 || inputNoteIds.length > 2) {
    throw new Error("SPP transfer must select one or two input notes");
  }
  const extData = record(root.extData, "SPP ext data");
  const resource = record(root.resource, "SPP transfer resource");
  const unsignedTransactionXdr = stringValue(root.unsignedTransactionXdr, "unsigned SPP transaction XDR");
  if (Buffer.from(unsignedTransactionXdr, "base64").length === 0) {
    throw new Error("unsigned SPP transaction XDR is empty");
  }
  return {
    operationId: hexBytes(root.operationIdHex, 32, "operation id"),
    inputNoteIds: inputNoteIds.map((item, index) => hexBytes(item, 32, `input note id ${index}`)),
    proof: {
      asp_membership_root: field(proof.aspMembershipRoot, "ASP membership root"),
      asp_non_membership_root: field(proof.aspNonMembershipRoot, "ASP non-membership root"),
      ext_data_hash: hexBytes(proof.extDataHashHex, 32, "ext data hash"),
      input_nullifiers: inputNullifiers.map((item, index) => field(item, `input nullifier ${index}`)),
      output_commitment0: field(proof.outputCommitment0, "provider output commitment"),
      output_commitment1: field(proof.outputCommitment1, "second output commitment"),
      proof: {
        a: hexBytes(proof.aHex, 64, "Groth16 proof A"),
        b: hexBytes(proof.bHex, 128, "Groth16 proof B"),
        c: hexBytes(proof.cHex, 64, "Groth16 proof C"),
      },
      public_amount: field(proof.publicAmount, "public amount"),
      root: field(proof.root, "pool root"),
    },
    extData: {
      encrypted_output0: variableHexBytes(extData.encryptedOutput0Hex, "encrypted provider output"),
      encrypted_output1: variableHexBytes(extData.encryptedOutput1Hex, "encrypted second output"),
      ext_amount: BigInt(stringValue(extData.extAmount, "external amount")),
      recipient: stringValue(extData.recipient, "external recipient"),
    },
    providerOutputBlinding: field(root.providerOutputBlinding, "provider output blinding"),
    refundOutputBlinding: field(root.refundOutputBlinding, "refund output blinding"),
    unsignedTransactionXdr,
    resource: {
      authEntries: nonNegativeInteger(resource.authEntries, "SPP auth entries"),
      diskReadBytes: nonNegativeInteger(resource.diskReadBytes, "SPP disk read bytes"),
      envelopeBytes: nonNegativeInteger(resource.envelopeBytes, "SPP envelope bytes"),
      footprintReadOnlyEntries: nonNegativeInteger(
        resource.footprintReadOnlyEntries,
        "SPP read-only footprint entries",
      ),
      footprintReadWriteEntries: nonNegativeInteger(
        resource.footprintReadWriteEntries,
        "SPP read-write footprint entries",
      ),
      instructions: nonNegativeInteger(resource.instructions, "SPP instructions"),
      latestLedger: nonNegativeInteger(resource.latestLedger, "SPP latest ledger"),
      resourceFeeStroops: stringValue(resource.resourceFeeStroops, "SPP resource fee"),
      totalFeeStroops: stringValue(resource.totalFeeStroops, "SPP total fee"),
      writeBytes: nonNegativeInteger(resource.writeBytes, "SPP write bytes"),
    },
  };
}

export class NativeSppTransferRuntimeBridge implements SppRuntimeBridge {
  readonly #process: SppDepositBridgeProcess;
  readonly #confirmationSource: SppDepositConfirmationSource;
  readonly #simulationSource: string;

  constructor(input: {
    readonly process: SppDepositBridgeProcess;
    readonly simulationSource: string;
    readonly confirmationSource?: SppDepositConfirmationSource;
  }) {
    if (!StrKey.isValidEd25519PublicKey(input.simulationSource)) {
      throw new TypeError("SPP transfer simulation source must be a canonical G-address");
    }
    this.#process = input.process;
    this.#simulationSource = input.simulationSource;
    this.#confirmationSource = input.confirmationSource ?? new StellarSppDepositConfirmationSource();
  }

  async prepare(input: SppRuntimeBridgePrepareInput): Promise<PreparedSppRuntimeTransfer> {
    if (input.poolContractId !== PINNED_SPP_POOL) throw new Error("SPP transfer must use the pinned pool");
    if (input.reservationId.length !== 32 || input.sessionId.length !== 32
      || input.providerSppEncryptionPublicKey.length !== 32 || input.notePrivateKeyLe.length !== 32
      || input.notePublicKeyLe.length !== 32 || input.encryptionPrivateKey.length !== 32
      || input.encryptionPublicKey.length !== 32 || input.membershipBlindingLe.length !== 32) {
      throw new RangeError("SPP transfer identifiers and key material must be exactly 32 bytes");
    }
    if (input.claimAmountAtomic <= 0n || input.refundAmountAtomic < 0n
      || input.claimAmountAtomic + input.refundAmountAtomic >= (1n << 64n)) {
      throw new RangeError("SPP transfer amounts must form a positive u64 reservation");
    }
    if (input.availableNotes.length === 0) throw new Error("SPP transfer requires active treasury notes");
    const request = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      command: "prepare_transfer",
      reservationIdHex: toHex(input.reservationId),
      sessionIdHex: toHex(input.sessionId),
      fundingSource: this.#simulationSource,
      claimAmountAtomic: input.claimAmountAtomic.toString(),
      refundAmountAtomic: input.refundAmountAtomic.toString(),
      poolContractId: input.poolContractId,
      providerNotePublicKeyLeHex: fieldLeHex(input.providerSppPublicKey, "provider SPP public key"),
      providerEncryptionPublicKeyHex: toHex(input.providerSppEncryptionPublicKey),
      notePrivateKeyLeHex: toHex(input.notePrivateKeyLe),
      notePublicKeyLeHex: toHex(input.notePublicKeyLe),
      encryptionPrivateKeyHex: toHex(input.encryptionPrivateKey),
      encryptionPublicKeyHex: toHex(input.encryptionPublicKey),
      membershipBlindingLeHex: toHex(input.membershipBlindingLe),
      availableNotes: input.availableNotes.map((note) => {
        if (note.status !== "ACTIVE" || note.leafIndex === undefined) {
          throw new Error("SPP transfer received a non-active treasury note");
        }
        return {
          noteIdHex: note.noteId,
          commitmentLeHex: fieldLeHex(BigInt(note.commitment), "treasury note commitment"),
          amountAtomic: note.amountAtomic,
          blindingLeHex: fieldLeHex(BigInt(note.blinding), "treasury note blinding"),
          leafIndex: note.leafIndex,
        };
      }),
    }), "utf8");
    let output: Buffer;
    try {
      output = await this.#process.run(request);
    } finally {
      request.fill(0);
    }
    const prepared = parseBridgeResponse(output);
    if (prepared.proof.public_amount !== 0n || prepared.extData.ext_amount !== 0n
      || prepared.extData.recipient !== input.poolContractId) {
      throw new Error("native SPP transfer is not a zero-public-amount pinned-pool call");
    }
    const availableIds = new Set(input.availableNotes.map((note) => note.noteId));
    if (prepared.inputNoteIds.some((noteId) => !availableIds.has(toHex(noteId)))) {
      throw new Error("native SPP transfer selected an unauthorized treasury note");
    }
    return prepared;
  }

  async abort(operationId: Buffer): Promise<void> {
    if (operationId.length !== 32) throw new RangeError("SPP operation id must be exactly 32 bytes");
  }

  async confirm(
    operationId: Buffer,
    transactionHash: Buffer,
    ledgerSequence: number,
    expectedProviderOutputCommitment: bigint,
    expectedSecondOutputCommitment: bigint,
    hasTreasuryRefund: boolean,
  ): Promise<{ readonly providerLeafIndex: number; readonly refundLeafIndex?: number }> {
    if (operationId.length !== 32 || transactionHash.length !== 32) {
      throw new RangeError("SPP operation and transaction hashes must be exactly 32 bytes");
    }
    if (!Number.isSafeInteger(ledgerSequence) || ledgerSequence <= 0) {
      throw new RangeError("SPP confirmation ledger must be a positive integer");
    }
    field(expectedProviderOutputCommitment.toString(), "expected provider commitment");
    field(expectedSecondOutputCommitment.toString(), "expected second commitment");
    const transaction = await this.#confirmationSource.load(toHex(transactionHash));
    if (transaction.status !== rpc.Api.GetTransactionStatus.SUCCESS || transaction.ledger !== ledgerSequence) {
      throw new Error("SPP transfer transaction is not successful at the expected ledger");
    }
    const providerLeafIndex = findSppCommitmentLeafIndex(
      transaction.events,
      PINNED_SPP_POOL,
      expectedProviderOutputCommitment,
    );
    const secondLeafIndex = findSppCommitmentLeafIndex(
      transaction.events,
      PINNED_SPP_POOL,
      expectedSecondOutputCommitment,
    );
    if (providerLeafIndex === secondLeafIndex) {
      throw new Error("SPP transfer outputs resolved to the same leaf index");
    }
    return hasTreasuryRefund
      ? { providerLeafIndex, refundLeafIndex: secondLeafIndex }
      : { providerLeafIndex };
  }
}
