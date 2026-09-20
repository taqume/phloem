import { execFileSync } from "node:child_process";

import {
  Address,
  Keypair,
  Transaction,
  TransactionBuilder,
  checkAuthEntryReadiness,
  rpc,
} from "@stellar/stellar-sdk";

import type { StellarSubmitter, SubmissionReceipt, TransactionSourceSigner } from "./ports.js";

export interface CommandRunner {
  run(command: string, args: readonly string[], input?: string): Promise<string>;
}

export interface SubmissionRpc {
  sendTransaction(transaction: Transaction): Promise<Awaited<ReturnType<rpc.Server["sendTransaction"]>>>;
  pollTransaction(hash: string, options?: { readonly attempts?: number }): Promise<Awaited<ReturnType<rpc.Server["pollTransaction"]>>>;
}

class LocalCommandRunner implements CommandRunner {
  async run(command: string, args: readonly string[], input?: string): Promise<string> {
    return execFileSync(command, [...args], {
      encoding: "utf8",
      input,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    }).trim();
  }
}

function parseControllerTransaction(
  transactionXdr: string,
  networkPassphrase: string,
  sourcePublicKey: string,
  treasuryControllerId: string,
): Transaction {
  const parsed = TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
  if (!(parsed instanceof Transaction)) throw new Error("gateway submission requires a classic transaction envelope");
  if (parsed.source !== sourcePublicKey) throw new Error("gateway transaction source differs from the pinned fee payer");
  if (parsed.operations.length !== 1) throw new Error("gateway transaction must contain exactly one operation");
  const operation = parsed.operations[0];
  if (!operation || operation.type !== "invokeHostFunction" || operation.func.type !== "hostFunctionTypeInvokeContract") {
    throw new Error("gateway transaction must contain one invokeContract operation");
  }
  if (Address.fromScAddress(operation.func.invokeContract.contractAddress).toString() !== treasuryControllerId) {
    throw new Error("gateway transaction targets a non-canonical controller");
  }
  for (const entry of operation.auth ?? []) {
    if (!checkAuthEntryReadiness(entry, 0).unsignedBy.length) continue;
    throw new Error("gateway transaction still contains unsigned non-source authorization");
  }
  return parsed;
}

export interface StellarCliSourceSignerOptions {
  readonly identityAlias: string;
  readonly networkName: string;
  readonly networkPassphrase: string;
  readonly sourcePublicKey: string;
  readonly treasuryControllerId: string;
  readonly command?: CommandRunner;
}

/** Signs only the transaction envelope with a pinned local Stellar CLI secure-store identity. */
export class StellarCliSourceSigner implements TransactionSourceSigner {
  readonly #options: StellarCliSourceSignerOptions;
  readonly #command: CommandRunner;

  constructor(options: StellarCliSourceSignerOptions) {
    this.#options = options;
    this.#command = options.command ?? new LocalCommandRunner();
  }

  async sign(unsignedTransactionXdr: string): Promise<string> {
    const unsigned = parseControllerTransaction(
      unsignedTransactionXdr,
      this.#options.networkPassphrase,
      this.#options.sourcePublicKey,
      this.#options.treasuryControllerId,
    );
    if (unsigned.signatures.length !== 0) throw new Error("source signer received an envelope that was already signed");
    const configuredPublicKey = await this.#command.run("stellar", [
      "keys", "public-key", this.#options.identityAlias,
    ]);
    if (configuredPublicKey !== this.#options.sourcePublicKey) {
      throw new Error("Stellar CLI secure-store identity differs from the pinned fee payer");
    }
    const signedXdr = await this.#command.run("stellar", [
      "tx", "sign", "--quiet",
      "--sign-with-key", this.#options.identityAlias,
      "--network", this.#options.networkName,
    ], `${unsignedTransactionXdr}\n`);
    if (!signedXdr) throw new Error("Stellar CLI returned no signed transaction");
    const signed = parseControllerTransaction(
      signedXdr,
      this.#options.networkPassphrase,
      this.#options.sourcePublicKey,
      this.#options.treasuryControllerId,
    );
    if (signed.signatures.length !== 1) throw new Error("fee payer must add exactly one envelope signature");
    const signature = signed.signatures[0];
    if (!signature || !Keypair.fromPublicKey(this.#options.sourcePublicKey).verify(signed.hash(), signature.signature)) {
      throw new Error("fee-payer envelope signature could not be verified");
    }
    return signedXdr;
  }
}

export interface RpcStellarSubmitterOptions {
  readonly server: SubmissionRpc;
  readonly networkPassphrase: string;
  readonly sourcePublicKey: string;
  readonly treasuryControllerId: string;
  readonly pollAttempts?: number;
}

export class RpcStellarSubmitter implements StellarSubmitter {
  readonly #options: RpcStellarSubmitterOptions;

  constructor(options: RpcStellarSubmitterOptions) {
    this.#options = options;
  }

  async submit(signedTransactionXdr: string): Promise<SubmissionReceipt> {
    const transaction = parseControllerTransaction(
      signedTransactionXdr,
      this.#options.networkPassphrase,
      this.#options.sourcePublicKey,
      this.#options.treasuryControllerId,
    );
    if (transaction.signatures.length !== 1) throw new Error("submitted transaction needs one fee-payer signature");
    const signature = transaction.signatures[0];
    if (!signature || !Keypair.fromPublicKey(this.#options.sourcePublicKey).verify(transaction.hash(), signature.signature)) {
      throw new Error("submitted transaction carries an invalid fee-payer signature");
    }
    const submitted = await this.#options.server.sendTransaction(transaction);
    if (submitted.status === "ERROR") throw new Error("Stellar RPC rejected the gateway transaction");
    if (submitted.status === "TRY_AGAIN_LATER") throw new Error("Stellar RPC asked the gateway to retry later");
    const final = await this.#options.server.pollTransaction(submitted.hash, {
      attempts: this.#options.pollAttempts ?? 60,
    });
    if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`gateway transaction ended with ${final.status}`);
    }
    return Object.freeze({
      transactionHash: submitted.hash,
      ledgerSequence: final.ledger,
      status: "SUCCESS" as const,
    });
  }
}
