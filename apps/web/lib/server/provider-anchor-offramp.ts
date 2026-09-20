import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Keypair,
  Memo,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  type Memo as StellarMemo,
} from "@stellar/stellar-sdk";

import type {
  AnchorQuote,
  AnchorTransaction,
  AnchorWithdrawal,
  DegradedProviderOfframpReceipt,
  ProviderOfframpCapability,
} from "../anchor-types";
import { normalizeUsdcAmount } from "../anchor-types";
import { PHLOEM_NETWORK } from "../network";
import { AnchorRequestError } from "./anchor";

const DESTINATION_ASSET = "iso4217:TRY" as const;
const FUNDING_METHOD = "bank_account" as const;
const MAX_CLASSIC_FEE_STROOPS = 100_000n;
const TRANSACTION_TIMEOUT_SECONDS = 300;

interface Sep6Capability {
  authentication_required?: boolean;
  enabled?: boolean;
  funding_methods?: string[];
  max_amount?: number;
  min_amount?: number;
}

export interface Sep6Info {
  "withdraw-exchange"?: Record<string, Sep6Capability>;
}

interface Sep38Asset {
  asset?: string;
  buy_delivery_methods?: Array<{ name?: string }>;
}

export interface Sep38Info {
  assets?: Sep38Asset[];
}

export interface ProviderWithdrawalPaymentPreview {
  amount: string;
  assetCode: string;
  assetIssuer: string;
  destination: string;
  feeStroops: string;
  memo: { type: string; value: string | null };
  networkPassphrase: string;
  source: string;
  transactionHash: string;
  transactionXdr: string;
}

export interface CanonicalProviderExitEvidence {
  amount: string;
  amountAtomic: string;
  providerAccount: string;
  transactionHash: string;
}

function repositoryRoot(): string {
  const cwd = process.cwd();
  return basename(cwd) === "web" && basename(dirname(cwd)) === "apps"
    ? resolve(cwd, "../..")
    : cwd;
}

export async function loadCanonicalProviderExitEvidence(): Promise<CanonicalProviderExitEvidence> {
  const manifest = JSON.parse(await readFile(resolve(repositoryRoot(), "deployments/testnet.json"), "utf8")) as {
    p0RuntimeEvidence?: {
      providerSppExit?: {
        asset?: { amount?: unknown; amountAtomic?: unknown; code?: unknown; issuer?: unknown };
        hash?: unknown;
        providerSettlementAccount?: unknown;
      };
      status?: unknown;
    };
  };
  const exit = manifest.p0RuntimeEvidence?.providerSppExit;
  const providerAccount = providerSettlementAccount();
  if (manifest.p0RuntimeEvidence?.status !== "provider-spp-exit-confirmed"
    || exit?.providerSettlementAccount !== providerAccount
    || typeof exit.hash !== "string"
    || !/^[0-9a-f]{64}$/u.test(exit.hash)
    || exit.asset?.code !== PHLOEM_NETWORK.assetCode
    || exit.asset.issuer !== PHLOEM_NETWORK.assetIssuer
    || typeof exit.asset.amount !== "string"
    || typeof exit.asset.amountAtomic !== "string"
    || normalizeUsdcAmount(exit.asset.amount) !== exit.asset.amount
    || usdcAmountToAtomic(exit.asset.amount).toString() !== exit.asset.amountAtomic) {
    throw new Error("Canonical Testnet provider SPP exit evidence is incomplete or inconsistent.");
  }
  return Object.freeze({
    amount: exit.asset.amount,
    amountAtomic: exit.asset.amountAtomic,
    providerAccount,
    transactionHash: exit.hash,
  });
}

export function providerSettlementAccount(): string {
  const account = process.env.PROVIDER_SETTLEMENT_PUBLIC_KEY;
  if (!account || !StrKey.isValidEd25519PublicKey(account)) {
    throw new Error("PROVIDER_SETTLEMENT_PUBLIC_KEY must be configured as a canonical Testnet G-address.");
  }
  if (account === PHLOEM_NETWORK.companyFundingPublicKey
    || account === PHLOEM_NETWORK.executionFeePayerPublicKey
    || account === PHLOEM_NETWORK.assetIssuer) {
    throw new Error("Provider settlement account must be distinct from company, relayer, and issuer accounts.");
  }
  return account;
}

export function parseUsdcAmount(value: unknown): string {
  if (typeof value !== "string") throw new AnchorRequestError("USDC amount is required.", 400);
  try {
    return normalizeUsdcAmount(value);
  } catch (reason) {
    throw new AnchorRequestError(reason instanceof Error ? reason.message : "Invalid USDC amount.", 400);
  }
}

export function usdcAmountToAtomic(value: string): bigint {
  const normalized = normalizeUsdcAmount(value);
  const [whole, fraction] = normalized.split(".");
  return BigInt(whole!) * 10_000_000n + BigInt(fraction!);
}

export function validateProviderOfframpCapability(input: {
  providerAccount: string;
  sep6: Sep6Info;
  sep38: Sep38Info;
}): ProviderOfframpCapability {
  const stellarAsset = `stellar:${PHLOEM_NETWORK.assetCode}:${PHLOEM_NETWORK.assetIssuer}`;
  const withdrawal = input.sep6["withdraw-exchange"]?.[PHLOEM_NETWORK.assetCode];
  const tryAsset = input.sep38.assets?.find((asset) => asset.asset === DESTINATION_ASSET);
  const hasStellarAsset = input.sep38.assets?.some((asset) => asset.asset === stellarAsset);
  const hasBankDelivery = tryAsset?.buy_delivery_methods?.some((method) => method.name === FUNDING_METHOD);

  if (!withdrawal?.enabled
    || withdrawal.authentication_required !== true
    || !withdrawal.funding_methods?.includes(FUNDING_METHOD)) {
    throw new AnchorRequestError(
      "Anchor does not currently advertise authenticated USDC withdraw-exchange via bank_account.",
      503,
    );
  }
  if (!hasStellarAsset || !hasBankDelivery) {
    throw new AnchorRequestError("Anchor does not currently advertise the USDC to TRY/bank_account quote path.", 503);
  }

  return Object.freeze({
    anchorDomain: PHLOEM_NETWORK.anchorHomeDomain,
    asset: stellarAsset,
    destinationAsset: DESTINATION_ASSET,
    fundingMethod: FUNDING_METHOD,
    providerAccount: input.providerAccount,
    sep38FirmQuote: true,
    withdrawalExchange: true,
  });
}

export function validateProviderOfframpQuote(quote: AnchorQuote, expectedAmount: string): AnchorQuote {
  const stellarAsset = `stellar:${PHLOEM_NETWORK.assetCode}:${PHLOEM_NETWORK.assetIssuer}`;
  if (!quote.id
    || quote.sell_asset !== stellarAsset
    || quote.buy_asset !== DESTINATION_ASSET
    || normalizeUsdcAmount(quote.sell_amount) !== normalizeUsdcAmount(expectedAmount)
    || !quote.buy_amount
    || !quote.expires_at
    || Number.isNaN(Date.parse(quote.expires_at))) {
    throw new AnchorRequestError("Anchor returned an invalid or mismatched USDC to TRY quote.", 502);
  }
  return quote;
}

export function validateProviderWithdrawal(withdrawal: AnchorWithdrawal): AnchorWithdrawal {
  if (!withdrawal.id || withdrawal.id.length > 256 || !StrKey.isValidEd25519PublicKey(withdrawal.account_id)) {
    throw new AnchorRequestError("Anchor returned incomplete withdrawal instructions.", 502);
  }
  if (withdrawal.memo_type && !["id", "text", "hash", "none"].includes(withdrawal.memo_type)) {
    throw new AnchorRequestError("Anchor returned an unsupported withdrawal memo type.", 502);
  }
  return withdrawal;
}

function withdrawalMemo(transaction: AnchorTransaction): StellarMemo {
  const type = transaction.withdraw_memo_type ?? "none";
  const value = transaction.withdraw_memo ?? "";
  if (type === "none") return Memo.none();
  if (type === "id") {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
      throw new AnchorRequestError("Anchor returned a non-canonical id memo.", 502);
    }
    return Memo.id(value);
  }
  if (type === "text") return Memo.text(value);
  if (type === "hash") {
    const bytes = /^[0-9a-fA-F]{64}$/u.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
    if (bytes.length !== 32) throw new AnchorRequestError("Anchor returned an invalid hash memo.", 502);
    return Memo.hash(bytes);
  }
  throw new AnchorRequestError("Anchor returned an unsupported withdrawal memo type.", 502);
}

export function assertPayableProviderWithdrawal(input: {
  providerAccount: string;
  quote: AnchorQuote;
  transaction: AnchorTransaction;
}): { amount: string; destination: string; memo: StellarMemo } {
  const { quote, transaction } = input;
  const stellarAsset = `stellar:${PHLOEM_NETWORK.assetCode}:${PHLOEM_NETWORK.assetIssuer}`;
  if (transaction.kind !== "withdrawal-exchange"
    || transaction.quote_id !== quote.id
    || transaction.amount_in_asset !== stellarAsset
    || transaction.amount_out_asset !== DESTINATION_ASSET
    || !transaction.amount_in
    || normalizeUsdcAmount(transaction.amount_in) !== normalizeUsdcAmount(quote.sell_amount)
    || !transaction.withdraw_anchor_account
    || !StrKey.isValidEd25519PublicKey(transaction.withdraw_anchor_account)) {
    throw new AnchorRequestError("Anchor withdrawal state does not match the firm quote and pinned assets.", 409);
  }
  if (["completed", "error", "expired", "refunded"].includes(transaction.status)) {
    throw new AnchorRequestError(`Anchor withdrawal is not payable in status ${transaction.status}.`, 409);
  }
  if (transaction.withdraw_anchor_account === input.providerAccount) {
    throw new AnchorRequestError("Anchor withdrawal destination must differ from the provider account.", 409);
  }
  return {
    amount: normalizeUsdcAmount(transaction.amount_in),
    destination: transaction.withdraw_anchor_account,
    memo: withdrawalMemo(transaction),
  };
}

function memoPreview(memo: StellarMemo): { type: string; value: string | null } {
  const value = memo.value;
  return {
    type: memo.type,
    value: value === null || value === undefined
      ? null
      : Buffer.isBuffer(value)
        ? value.toString("hex")
        : String(value),
  };
}

export function buildProviderWithdrawalPayment(input: {
  accountSequence: string;
  providerAccount: string;
  quote: AnchorQuote;
  transaction: AnchorTransaction;
}): ProviderWithdrawalPaymentPreview {
  const payable = assertPayableProviderWithdrawal(input);
  const envelope = new TransactionBuilder(new Account(input.providerAccount, input.accountSequence), {
    fee: BASE_FEE,
    networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
  })
    .addOperation(Operation.payment({
      amount: payable.amount,
      asset: new Asset(PHLOEM_NETWORK.assetCode, PHLOEM_NETWORK.assetIssuer),
      destination: payable.destination,
    }))
    .addMemo(payable.memo)
    .setTimeout(TRANSACTION_TIMEOUT_SECONDS)
    .build();

  return Object.freeze({
    amount: payable.amount,
    assetCode: PHLOEM_NETWORK.assetCode,
    assetIssuer: PHLOEM_NETWORK.assetIssuer,
    destination: payable.destination,
    feeStroops: envelope.fee,
    memo: memoPreview(payable.memo),
    networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
    source: input.providerAccount,
    transactionHash: Buffer.from(envelope.hash()).toString("hex"),
    transactionXdr: envelope.toXDR(),
  });
}

export function assertSignedProviderWithdrawalPayment(input: {
  providerAccount: string;
  quote: AnchorQuote;
  signedTransactionXdr: string;
  transaction: AnchorTransaction;
}): Transaction {
  const payable = assertPayableProviderWithdrawal(input);
  const envelope = TransactionBuilder.fromXDR(input.signedTransactionXdr, PHLOEM_NETWORK.networkPassphrase);
  if (!(envelope instanceof Transaction)
    || envelope.source !== input.providerAccount
    || envelope.operations.length !== 1
    || envelope.signatures.length !== 1
    || BigInt(envelope.fee) > MAX_CLASSIC_FEE_STROOPS) {
    throw new AnchorRequestError("Signed withdrawal payment has an unexpected envelope shape.", 400);
  }
  const operation = envelope.operations[0];
  if (!operation
    || operation.type !== "payment"
    || operation.destination !== payable.destination
    || operation.amount !== payable.amount
    || operation.asset.code !== PHLOEM_NETWORK.assetCode
    || operation.asset.issuer !== PHLOEM_NETWORK.assetIssuer) {
    throw new AnchorRequestError("Signed withdrawal payment differs from the Anchor instructions.", 400);
  }
  const expectedMemo = memoPreview(payable.memo);
  const actualMemo = memoPreview(envelope.memo);
  if (actualMemo.type !== expectedMemo.type || actualMemo.value !== expectedMemo.value) {
    throw new AnchorRequestError("Signed withdrawal payment memo differs from the Anchor instructions.", 400);
  }
  const signature = envelope.signatures[0]!.signature.value;
  if (!Keypair.fromPublicKey(input.providerAccount).verify(envelope.hash(), signature)) {
    throw new AnchorRequestError("Withdrawal payment is not signed by the provider settlement account.", 400);
  }
  return envelope;
}

export function assertProviderSppExitEvidence(input: {
  envelopeXdr: string;
  transactionHash: string;
}): void {
  if (!/^[0-9a-f]{64}$/u.test(input.transactionHash)) {
    throw new AnchorRequestError("Provider SPP exit transaction hash must be 32-byte lowercase hexadecimal.", 400);
  }
  const envelope = TransactionBuilder.fromXDR(input.envelopeXdr, PHLOEM_NETWORK.networkPassphrase);
  if (!(envelope instanceof Transaction)
    || envelope.source !== PHLOEM_NETWORK.executionFeePayerPublicKey
    || envelope.operations.length !== 1
    || Buffer.from(envelope.hash()).toString("hex") !== input.transactionHash) {
    throw new AnchorRequestError("Provider SPP exit evidence has an unexpected envelope shape.", 409);
  }
  const operation = envelope.operations[0];
  if (!operation
    || operation.type !== "invokeHostFunction"
    || operation.func.type !== "hostFunctionTypeInvokeContract"
    || Address.fromScAddress(operation.func.invokeContract.contractAddress).toString() !== PHLOEM_NETWORK.sppPoolId
    || operation.func.invokeContract.functionName.toString() !== "transact") {
    throw new AnchorRequestError("Provider evidence is not the canonical SPP pool exit.", 409);
  }
}

export function createDegradedProviderOfframpReceipt(input: {
  anchorError?: string;
  anchorStatus: string | null;
  anchorTransactionId: string | null;
  amountAtomic: string;
  observedAt: string;
  providerAccount: string;
  sppExitTransactionHash: string;
}): DegradedProviderOfframpReceipt {
  if (input.anchorStatus === "completed") {
    throw new Error("A completed Anchor withdrawal cannot be represented as degraded.");
  }
  if (!/^[0-9a-f]{64}$/u.test(input.sppExitTransactionHash)) {
    throw new Error("Provider SPP exit transaction hash must be 32-byte lowercase hexadecimal.");
  }
  if (!/^[1-9][0-9]*$/u.test(input.amountAtomic)) {
    throw new Error("Provider settlement amount must be a positive atomic integer.");
  }
  if (!StrKey.isValidEd25519PublicKey(input.providerAccount)) {
    throw new Error("Provider settlement account must be a canonical G-address.");
  }

  const reachable = input.anchorStatus !== null;
  const evidence = {
    anchorObservation: {
      domain: PHLOEM_NETWORK.anchorHomeDomain,
      ...(input.anchorError ? { error: input.anchorError.slice(0, 240) } : {}),
      observedAt: input.observedAt,
      reachable,
      status: input.anchorStatus,
      transactionId: input.anchorTransactionId,
    },
    mode: "DEGRADED_DEMO" as const,
    providerSettlement: {
      account: input.providerAccount,
      amountAtomic: input.amountAtomic,
      asset: "Circle Testnet USDC" as const,
      sppExitTransactionHash: input.sppExitTransactionHash,
    },
    reason: reachable
      ? "OFFICIAL_ANCHOR_SETTLEMENT_STALLED" as const
      : "OFFICIAL_ANCHOR_UNREACHABLE" as const,
    schema: "phloem.degraded-provider-offramp/v1" as const,
    scope: {
      anchorAttested: false as const,
      fiatLeg: "LOCAL_FIAT_SIMULATED_ONLY" as const,
      protocolStateMutation: "NONE" as const,
      stellarAssetMovement: "NONE" as const,
    },
  };
  const digest = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
  return {
    ...evidence,
    evidenceDigest: `sha256:${digest}`,
    receiptId: `degraded_offramp_${digest.slice(0, 24)}`,
  };
}
