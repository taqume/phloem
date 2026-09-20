import { spawn } from "node:child_process";

import {
  BN254_SCALAR_MODULUS,
  toHex,
} from "@phloem/protocol-types";
import { StrKey, humanizeEvents, rpc } from "@stellar/stellar-sdk";

import type {
  SppDepositRuntimeBridge,
  SppDepositRuntimeBridgeInput,
} from "./spp-private-deposit-adapter.js";
import type { PreparedSppPrivateDeposit } from "./private-session-activation.js";

export const PINNED_SPP_POOL = "CC57FDSWPIHALXW2XWVSKEA7FA72Z37Y7AP5ASRY6V3CXAZCWQAOSLB4";
export const PINNED_SPP_SOURCE_REVISION = "5f3a5d41f452069caf8d0e1654675bca55cb94d3";
export const PINNED_SPP_NETWORK = "testnet";
export const PINNED_SPP_RPC_URL = "https://soroban-testnet.stellar.org";

const MAX_BRIDGE_STDOUT_BYTES = 256 * 1024;
const MAX_BRIDGE_STDERR_BYTES = 64 * 1024;

export interface SppDepositBridgeProcess {
  /** The implementation must consume the request before resolving. */
  run(request: Buffer): Promise<Buffer>;
}

export interface ConfirmedSppContractEvent {
  readonly contractId?: string;
  readonly type: string;
  readonly topics: readonly unknown[];
  readonly data: unknown;
}

export interface SppDepositConfirmationSource {
  load(transactionHashHex: string): Promise<{
    readonly status: string;
    readonly ledger?: number;
    readonly events: readonly ConfirmedSppContractEvent[];
  }>;
}

export class NativeSppDepositProcess implements SppDepositBridgeProcess {
  readonly #binaryPath: string;
  readonly #workingDirectory: string;

  constructor(input: { readonly binaryPath: string; readonly workingDirectory: string }) {
    this.#binaryPath = input.binaryPath;
    this.#workingDirectory = input.workingDirectory;
  }

  async run(request: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#binaryPath, [], {
        cwd: this.#workingDirectory,
        env: {
          NODE_ENV: process.env.NODE_ENV,
          PATH: process.env.PATH ?? "",
        },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let rejected = false;
      const wipeStdout = (): void => {
        for (const chunk of stdout) chunk.fill(0);
        stdout.length = 0;
      };
      const rejectSanitized = (message: string): void => {
        if (rejected) return;
        rejected = true;
        child.kill();
        wipeStdout();
        reject(new Error(message));
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_BRIDGE_STDOUT_BYTES) {
          rejectSanitized("native SPP deposit bridge exceeded its output limit");
          return;
        }
        stdout.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_BRIDGE_STDERR_BYTES) {
          rejectSanitized("native SPP deposit bridge exceeded its diagnostic limit");
        }
      });
      child.once("error", () => rejectSanitized("native SPP deposit bridge could not start"));
      child.once("close", (code) => {
        if (rejected) return;
        if (code !== 0) {
          rejectSanitized("native SPP deposit bridge rejected the request");
          return;
        }
        const output = Buffer.concat(stdout);
        wipeStdout();
        resolve(output);
      });
      child.stdin.once("error", () => rejectSanitized("native SPP deposit bridge input failed"));
      child.stdin.end(request);
    });
  }
}

export class StellarSppDepositConfirmationSource implements SppDepositConfirmationSource {
  readonly #server: rpc.Server;

  constructor(rpcUrl = PINNED_SPP_RPC_URL) {
    this.#server = new rpc.Server(rpcUrl);
  }

  async load(transactionHashHex: string): Promise<{
    readonly status: string;
    readonly ledger?: number;
    readonly events: readonly ConfirmedSppContractEvent[];
  }> {
    const transaction = await this.#server.getTransaction(transactionHashHex);
    if (transaction.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
      return { status: transaction.status, events: [] };
    }
    return {
      status: transaction.status,
      ledger: transaction.ledger,
      events: humanizeEvents(transaction.events.contractEventsXdr.flat()),
    };
  }
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

function falseValue(value: unknown, label: string): void {
  if (value !== false) throw new Error(`${label} must remain false`);
}

function hexBytes(value: unknown, length: number, label: string): Buffer {
  const encoded = stringValue(value, label);
  if (!/^(?:[0-9a-f]{2})+$/iu.test(encoded)) throw new TypeError(`${label} must be lowercase or uppercase hex`);
  const bytes = Buffer.from(encoded, "hex");
  if (bytes.length !== length) throw new RangeError(`${label} must be exactly ${length} bytes`);
  return bytes;
}

function variableHexBytes(value: unknown, label: string): Buffer {
  const encoded = stringValue(value, label);
  if (!/^(?:[0-9a-f]{2})+$/iu.test(encoded)) throw new TypeError(`${label} must be lowercase or uppercase hex`);
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

function parseBridgeResponse(output: Buffer): PreparedSppPrivateDeposit {
  let decoded: unknown;
  try {
    decoded = JSON.parse(output.toString("utf8"));
  } catch {
    throw new Error("native SPP deposit bridge returned malformed output");
  } finally {
    output.fill(0);
  }
  const root = record(decoded, "bridge response");
  if (root.schemaVersion !== 1) throw new Error("native SPP deposit bridge schema differs from version 1");
  if (root.sourceRevision !== PINNED_SPP_SOURCE_REVISION) throw new Error("native SPP source revision differs from the pin");
  if (root.network !== PINNED_SPP_NETWORK) throw new Error("native SPP bridge returned the wrong network");
  falseValue(root.assetMovement, "asset movement");
  falseValue(root.signed, "signed state");
  falseValue(root.submitted, "submitted state");
  const safety = record(root.safety, "bridge safety");
  if (safety.storage !== "ephemeral-memory-no-sqlite") {
    throw new Error("native SPP bridge used an unauthorized storage mode");
  }
  const proof = record(root.proof, "SPP proof");
  const inputNullifiers = proof.inputNullifiers;
  if (!Array.isArray(inputNullifiers) || inputNullifiers.length !== 2) {
    throw new Error("SPP deposit proof must have two input nullifiers");
  }
  const extData = record(root.extData, "SPP ext data");
  return {
    operationId: hexBytes(root.operationIdHex, 32, "operation id"),
    proof: {
      asp_membership_root: field(proof.aspMembershipRoot, "ASP membership root"),
      asp_non_membership_root: field(proof.aspNonMembershipRoot, "ASP non-membership root"),
      ext_data_hash: hexBytes(proof.extDataHashHex, 32, "ext data hash"),
      input_nullifiers: inputNullifiers.map((item, index) => field(item, `input nullifier ${index}`)),
      output_commitment0: field(proof.outputCommitment0, "funding output commitment"),
      output_commitment1: field(proof.outputCommitment1, "change output commitment"),
      proof: {
        a: hexBytes(proof.aHex, 64, "Groth16 proof A"),
        b: hexBytes(proof.bHex, 128, "Groth16 proof B"),
        c: hexBytes(proof.cHex, 64, "Groth16 proof C"),
      },
      public_amount: field(proof.publicAmount, "public amount"),
      root: field(proof.root, "pool root"),
    },
    extData: {
      encrypted_output0: variableHexBytes(extData.encryptedOutput0Hex, "encrypted funding output"),
      encrypted_output1: variableHexBytes(extData.encryptedOutput1Hex, "encrypted change output"),
      ext_amount: BigInt(stringValue(extData.extAmount, "external amount")),
      recipient: stringValue(extData.recipient, "external recipient"),
    },
    fundingOutputBlinding: field(root.fundingOutputBlinding, "funding output blinding"),
  };
}

export function findSppCommitmentLeafIndex(
  events: readonly ConfirmedSppContractEvent[],
  poolContractId: string,
  expectedCommitment: bigint,
): number {
  const matches = events.filter((event) => {
    if (event.type !== "contract" || event.contractId !== poolContractId) return false;
    const [name, commitment] = event.topics;
    return (name === "new_commitment_event" || name === "NewCommitmentEvent")
      && typeof commitment === "bigint"
      && commitment === expectedCommitment;
  });
  if (matches.length !== 1) {
    throw new Error("confirmed SPP transaction does not contain exactly one expected commitment event");
  }
  const data = record(matches[0]?.data, "SPP commitment event data");
  if (!Number.isSafeInteger(data.index) || (data.index as number) < 0 || (data.index as number) > 0xffff_ffff) {
    throw new Error("confirmed SPP commitment event has an invalid leaf index");
  }
  return data.index as number;
}

export const findSppFundingLeafIndex = findSppCommitmentLeafIndex;

export class NativeSppDepositRuntimeBridge implements SppDepositRuntimeBridge {
  readonly #process: SppDepositBridgeProcess;
  readonly #confirmationSource: SppDepositConfirmationSource;

  constructor(input: {
    readonly process: SppDepositBridgeProcess;
    readonly confirmationSource?: SppDepositConfirmationSource;
  }) {
    this.#process = input.process;
    this.#confirmationSource = input.confirmationSource ?? new StellarSppDepositConfirmationSource();
  }

  async prepare(input: SppDepositRuntimeBridgeInput): Promise<PreparedSppPrivateDeposit> {
    if (input.poolContractId !== PINNED_SPP_POOL) throw new Error("SPP deposit must use the pinned pool");
    if (!StrKey.isValidEd25519PublicKey(input.fundingSource)) {
      throw new TypeError("SPP deposit funding source must be a canonical G-address");
    }
    if (input.sessionId.length !== 32 || input.notePrivateKeyLe.length !== 32
      || input.notePublicKeyLe.length !== 32 || input.encryptionPrivateKey.length !== 32
      || input.encryptionPublicKey.length !== 32 || input.membershipBlindingLe.length !== 32) {
      throw new RangeError("SPP deposit identifiers and key material must be exactly 32 bytes");
    }
    if (input.amountAtomic <= 0n || input.amountAtomic >= (1n << 64n)) {
      throw new RangeError("SPP deposit amount must be a positive u64");
    }
    const request = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      command: "prepare_deposit",
      sessionIdHex: toHex(input.sessionId),
      fundingSource: input.fundingSource,
      amountAtomic: input.amountAtomic.toString(),
      poolContractId: input.poolContractId,
      notePrivateKeyLeHex: toHex(input.notePrivateKeyLe),
      notePublicKeyLeHex: toHex(input.notePublicKeyLe),
      encryptionPrivateKeyHex: toHex(input.encryptionPrivateKey),
      encryptionPublicKeyHex: toHex(input.encryptionPublicKey),
      membershipBlindingLeHex: toHex(input.membershipBlindingLe),
    }), "utf8");
    let output: Buffer;
    try {
      output = await this.#process.run(request);
    } finally {
      request.fill(0);
    }
    const prepared = parseBridgeResponse(output);
    if (prepared.proof.public_amount !== input.amountAtomic
      || prepared.extData.ext_amount !== input.amountAtomic
      || prepared.extData.recipient !== input.poolContractId) {
      throw new Error("native SPP deposit does not match its requested amount or pool");
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
    expectedFundingCommitment: bigint,
  ): Promise<{ readonly fundingLeafIndex: number }> {
    if (operationId.length !== 32 || transactionHash.length !== 32) {
      throw new RangeError("SPP operation and transaction hashes must be exactly 32 bytes");
    }
    if (!Number.isSafeInteger(ledgerSequence) || ledgerSequence <= 0) {
      throw new RangeError("SPP confirmation ledger must be a positive integer");
    }
    field(expectedFundingCommitment.toString(), "expected funding commitment");
    const transaction = await this.#confirmationSource.load(toHex(transactionHash));
    if (transaction.status !== rpc.Api.GetTransactionStatus.SUCCESS || transaction.ledger !== ledgerSequence) {
      throw new Error("SPP deposit transaction is not successful at the expected ledger");
    }
    return {
      fundingLeafIndex: findSppCommitmentLeafIndex(
        transaction.events,
        PINNED_SPP_POOL,
        expectedFundingCommitment,
      ),
    };
  }
}
