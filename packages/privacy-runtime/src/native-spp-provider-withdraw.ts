import {
  BN254_SCALAR_MODULUS,
  toHex,
} from "@phloem/protocol-types";
import { StrKey } from "@stellar/stellar-sdk";

import {
  PINNED_SPP_NETWORK,
  PINNED_SPP_POOL,
  PINNED_SPP_SOURCE_REVISION,
  type SppDepositBridgeProcess,
} from "./native-spp-deposit-bridge.js";

export interface PreparedSppProviderWithdraw {
  readonly operationId: Buffer;
  readonly inputNoteId: Buffer;
  readonly unsignedTransactionXdr: string;
  readonly withdrawalAmountAtomic: bigint;
  readonly publicAmountField: bigint;
  readonly inputNullifiers: readonly bigint[];
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

function canonicalHex(value: unknown, bytes: number, label: string): Buffer {
  const encoded = stringValue(value, label);
  if (!/^(?:[0-9a-f]{2})+$/u.test(encoded)) throw new TypeError(`${label} must be lowercase hexadecimal`);
  const decoded = Buffer.from(encoded, "hex");
  if (decoded.length !== bytes) throw new RangeError(`${label} must be exactly ${bytes} bytes`);
  return decoded;
}

function field(value: unknown, label: string): bigint {
  const encoded = stringValue(value, label);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(encoded)) throw new TypeError(`${label} must be canonical decimal`);
  const parsed = BigInt(encoded);
  if (parsed >= BN254_SCALAR_MODULUS) throw new RangeError(`${label} must be a canonical BN254 field`);
  return parsed;
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function resource(value: unknown): PreparedSppProviderWithdraw["resource"] {
  const input = record(value, "provider withdrawal resources");
  return Object.freeze({
    authEntries: safeInteger(input.authEntries, "auth entries"),
    diskReadBytes: safeInteger(input.diskReadBytes, "disk read bytes"),
    envelopeBytes: safeInteger(input.envelopeBytes, "envelope bytes"),
    footprintReadOnlyEntries: safeInteger(input.footprintReadOnlyEntries, "read-only entries"),
    footprintReadWriteEntries: safeInteger(input.footprintReadWriteEntries, "read-write entries"),
    instructions: safeInteger(input.instructions, "instructions"),
    latestLedger: safeInteger(input.latestLedger, "latest ledger"),
    resourceFeeStroops: stringValue(input.resourceFeeStroops, "resource fee"),
    totalFeeStroops: stringValue(input.totalFeeStroops, "total fee"),
    writeBytes: safeInteger(input.writeBytes, "write bytes"),
  });
}

function parseResponse(
  output: Buffer,
  expectedRecipient: string,
): PreparedSppProviderWithdraw {
  let decoded: unknown;
  try {
    decoded = JSON.parse(output.toString("utf8"));
  } catch {
    throw new Error("native SPP provider withdrawal bridge returned malformed output");
  } finally {
    output.fill(0);
  }
  const root = record(decoded, "provider withdrawal response");
  if (root.schemaVersion !== 1
    || root.sourceRevision !== PINNED_SPP_SOURCE_REVISION
    || root.network !== PINNED_SPP_NETWORK) {
    throw new Error("native SPP provider withdrawal bridge differs from the pinned runtime");
  }
  if (root.assetMovement !== true || root.signed !== false || root.submitted !== false) {
    throw new Error("native SPP provider withdrawal bridge returned an unsafe execution state");
  }
  const safety = record(root.safety, "bridge safety");
  if (safety.storage !== "ephemeral-memory-no-sqlite") {
    throw new Error("native SPP provider withdrawal bridge used unauthorized persistence");
  }
  if (safety.fullPublicExit !== true) {
    throw new Error("native SPP provider withdrawal bridge did not prove a full public exit");
  }
  const inputNoteIds = root.inputNoteIdsHex;
  if (!Array.isArray(inputNoteIds) || inputNoteIds.length !== 1) {
    throw new Error("provider withdrawal must consume exactly one recovered provider note");
  }
  const proof = record(root.proof, "provider withdrawal proof");
  const nullifiers = proof.inputNullifiers;
  if (!Array.isArray(nullifiers) || nullifiers.length !== 2) {
    throw new Error("provider withdrawal proof must carry two canonical nullifier slots");
  }
  field(proof.outputCommitment0, "provider withdrawal fixed output zero");
  field(proof.outputCommitment1, "provider withdrawal fixed output one");
  const extData = record(root.extData, "provider withdrawal external data");
  if (extData.recipient !== expectedRecipient) {
    throw new Error("provider withdrawal external recipient differs");
  }
  for (const [label, value] of [
    ["encrypted output zero", extData.encryptedOutput0Hex],
    ["encrypted output one", extData.encryptedOutput1Hex],
  ] as const) {
    const encoded = stringValue(value, label);
    if (!/^(?:[0-9a-f]{2})*$/u.test(encoded)) {
      throw new Error(`provider withdrawal ${label} is not canonical hexadecimal`);
    }
  }
  const externalAmount = BigInt(stringValue(extData.extAmount, "provider withdrawal external amount"));
  if (externalAmount >= 0n || externalAmount <= -(1n << 64n)) {
    throw new RangeError("provider withdrawal external amount must be a negative u64");
  }
  const withdrawalAmountAtomic = -externalAmount;
  const publicAmountField = field(proof.publicAmount, "provider withdrawal public amount");
  if (publicAmountField !== BN254_SCALAR_MODULUS - withdrawalAmountAtomic) {
    throw new Error("provider withdrawal public amount does not encode its negative external amount");
  }
  const transactionXdr = stringValue(root.unsignedTransactionXdr, "unsigned provider withdrawal transaction");
  if (transactionXdr.length === 0) throw new Error("provider withdrawal transaction is empty");
  return Object.freeze({
    operationId: canonicalHex(root.operationIdHex, 32, "operation id"),
    inputNoteId: canonicalHex(inputNoteIds[0], 32, "provider input note id"),
    unsignedTransactionXdr: transactionXdr,
    withdrawalAmountAtomic,
    publicAmountField,
    inputNullifiers: Object.freeze(nullifiers.map((value, index) => field(value, `input nullifier ${index}`))),
    resource: resource(root.resource),
  });
}

/** Recovers one provider output from its exact settlement event and prepares a full public SPP exit. */
export class NativeSppProviderWithdrawBridge {
  readonly #process: SppDepositBridgeProcess;
  readonly #simulationSource: string;

  constructor(input: { readonly process: SppDepositBridgeProcess; readonly simulationSource: string }) {
    if (!StrKey.isValidEd25519PublicKey(input.simulationSource)) {
      throw new TypeError("provider withdrawal simulation source must be a canonical G-address");
    }
    this.#process = input.process;
    this.#simulationSource = input.simulationSource;
  }

  async prepare(input: {
    readonly sessionId: Uint8Array;
    readonly reservationId: Uint8Array;
    readonly settlementTransactionHash: Uint8Array;
    readonly settlementLedger: number;
    readonly expectedProviderOutputCommitment: bigint;
    readonly withdrawalRecipient: string;
    readonly notePrivateKeyLe: Uint8Array;
    readonly notePublicKeyLe: Uint8Array;
    readonly encryptionPrivateKey: Uint8Array;
    readonly encryptionPublicKey: Uint8Array;
    readonly membershipBlindingLe: Uint8Array;
  }): Promise<PreparedSppProviderWithdraw> {
    if (!StrKey.isValidEd25519PublicKey(input.withdrawalRecipient)) {
      throw new TypeError("provider withdrawal recipient must be a canonical G-address");
    }
    for (const [label, value] of [
      ["session id", input.sessionId],
      ["reservation id", input.reservationId],
      ["settlement transaction hash", input.settlementTransactionHash],
      ["note private key", input.notePrivateKeyLe],
      ["note public key", input.notePublicKeyLe],
      ["encryption private key", input.encryptionPrivateKey],
      ["encryption public key", input.encryptionPublicKey],
      ["membership blinding", input.membershipBlindingLe],
    ] as const) {
      if (value.length !== 32) throw new RangeError(`${label} must be exactly 32 bytes`);
    }
    if (!Number.isSafeInteger(input.settlementLedger) || input.settlementLedger <= 0) {
      throw new RangeError("settlement ledger must be a positive integer");
    }
    if (input.expectedProviderOutputCommitment <= 0n
      || input.expectedProviderOutputCommitment >= BN254_SCALAR_MODULUS) {
      throw new RangeError("provider output commitment must be a non-zero canonical field");
    }
    const request = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      command: "prepare_provider_withdraw",
      reservationIdHex: toHex(input.reservationId),
      sessionIdHex: toHex(input.sessionId),
      fundingSource: this.#simulationSource,
      poolContractId: PINNED_SPP_POOL,
      notePrivateKeyLeHex: toHex(input.notePrivateKeyLe),
      notePublicKeyLeHex: toHex(input.notePublicKeyLe),
      encryptionPrivateKeyHex: toHex(input.encryptionPrivateKey),
      encryptionPublicKeyHex: toHex(input.encryptionPublicKey),
      membershipBlindingLeHex: toHex(input.membershipBlindingLe),
      settlementTransactionHashHex: toHex(input.settlementTransactionHash),
      settlementLedger: input.settlementLedger,
      expectedProviderOutputCommitment: `0x${input.expectedProviderOutputCommitment.toString(16).padStart(64, "0")}`,
      withdrawalRecipient: input.withdrawalRecipient,
    }), "utf8");
    let output: Buffer;
    try {
      output = await this.#process.run(request);
    } finally {
      request.fill(0);
    }
    return parseResponse(output, input.withdrawalRecipient);
  }
}
