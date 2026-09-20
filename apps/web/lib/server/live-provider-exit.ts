import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  NativeSppDepositProcess,
  NativeSppProviderWithdrawBridge,
  deriveSppNotePublicKey,
  deriveX25519PublicKey,
} from "@phloem/privacy-runtime";
import {
  BN254_SCALAR_MODULUS,
  fieldToBytes,
  toHex,
} from "@phloem/protocol-types";
import { Client } from "@phloem/treasury-controller-client";
import {
  Address,
  StrKey,
  Transaction,
  TransactionBuilder,
  checkAuthEntryReadiness,
  inspectAuthEntry,
} from "@stellar/stellar-sdk";

import { PHLOEM_NETWORK } from "../network";
import { openEncryptedAgentIdentityVault } from "./live-agent-runtime";

const PROVIDER_EXIT_FEE_CEILING_STROOPS = 100_000_000n;

function repositoryRoot(): string {
  const cwd = process.cwd();
  return basename(cwd) === "web" && basename(dirname(cwd)) === "apps"
    ? resolve(cwd, "../..")
    : cwd;
}

function canonicalBytes32(value: unknown, label: string): Buffer {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be 32-byte lowercase hexadecimal`);
  }
  return Buffer.from(value, "hex");
}

function secretBytes32(name: string): Buffer {
  const value = process.env[name];
  if (!value || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${name} must be configured as 32-byte lowercase hexadecimal`);
  }
  return Buffer.from(value, "hex");
}

function littleEndianField(value: Uint8Array, label: string): bigint {
  const parsed = BigInt(`0x${Buffer.from(value).reverse().toString("hex")}`);
  if (parsed <= 0n || parsed >= BN254_SCALAR_MODULUS) {
    throw new RangeError(`${label} must be a non-zero canonical BN254 field`);
  }
  return parsed;
}

async function nativeBridgeBinary(root: string): Promise<string> {
  const path = process.env.PHLOEM_SPP_TRANSFER_BRIDGE_BIN
    || join(root, "tools/spp-runtime-probe/target/release/spp-transfer-bridge");
  const metadata = await lstat(path).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new Error("pinned native SPP provider withdrawal bridge is missing; build the release binary first");
  }
  return path;
}

function controller(): Client {
  return new Client({
    contractId: PHLOEM_NETWORK.treasuryControllerId,
    networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
    rpcUrl: PHLOEM_NETWORK.rpcUrl,
    publicKey: PHLOEM_NETWORK.executionFeePayerPublicKey,
  });
}

function providerSettlementAccount(): string {
  const account = process.env.PROVIDER_SETTLEMENT_PUBLIC_KEY;
  if (!account || !StrKey.isValidEd25519PublicKey(account)) {
    throw new Error("PROVIDER_SETTLEMENT_PUBLIC_KEY must be configured as a canonical Testnet G-address");
  }
  if (account === PHLOEM_NETWORK.companyFundingPublicKey
    || account === PHLOEM_NETWORK.executionFeePayerPublicKey
    || account === PHLOEM_NETWORK.assetIssuer) {
    throw new Error("provider settlement account must be distinct from company, relayer, and issuer accounts");
  }
  return account;
}

function assertProviderExitEnvelope(transactionXdr: string): Transaction {
  const parsed = TransactionBuilder.fromXDR(transactionXdr, PHLOEM_NETWORK.networkPassphrase);
  if (!(parsed instanceof Transaction)
    || parsed.source !== PHLOEM_NETWORK.executionFeePayerPublicKey
    || parsed.operations.length !== 1
    || parsed.signatures.length !== 0) {
    throw new Error("provider SPP exit has an unexpected source, envelope type, or operation count");
  }
  const operation = parsed.operations[0];
  if (!operation
    || operation.type !== "invokeHostFunction"
    || operation.func.type !== "hostFunctionTypeInvokeContract"
    || Address.fromScAddress(operation.func.invokeContract.contractAddress).toString() !== PHLOEM_NETWORK.sppPoolId
    || operation.func.invokeContract.functionName.toString() !== "transact") {
    throw new Error("provider SPP exit does not target the pinned pool transact function");
  }
  for (const entry of operation.auth ?? []) inspectAuthEntry(entry);
  if ((operation.auth ?? []).some((entry) => checkAuthEntryReadiness(entry, 0).unsignedBy.length > 0)) {
    throw new Error("provider SPP exit contains unsigned non-source authorization");
  }
  if (BigInt(parsed.fee) > PROVIDER_EXIT_FEE_CEILING_STROOPS) {
    throw new Error("provider SPP exit fee exceeds the P0 safety ceiling");
  }
  return parsed;
}

/** Recovers the exact settled provider output and simulates a full public USDC exit without submission. */
export async function simulateLiveProviderSppExit(input: {
  readonly sessionId: unknown;
  readonly reservationId: unknown;
}) {
  const sessionId = canonicalBytes32(input.sessionId, "session id");
  const reservationId = canonicalBytes32(input.reservationId, "reservation id");
  const root = repositoryRoot();
  const { store } = await openEncryptedAgentIdentityVault();
  let notePrivateKeyLe: Buffer | undefined;
  let encryptionPrivateKey: Buffer | undefined;
  let membershipBlindingLe: Buffer | undefined;
  try {
    const [paymentRead, manifest, binaryPath] = await Promise.all([
      controller().get_private_payment_record({ reservation_id: reservationId }),
      readFile(join(root, "deployments/testnet.json"), "utf8").then((value) => JSON.parse(value) as {
        spp?: { contracts?: { pool?: unknown } };
      }),
      nativeBridgeBinary(root),
    ]);
    notePrivateKeyLe = secretBytes32("PROVIDER_SPP_NOTE_PRIVATE_KEY_LE_HEX");
    encryptionPrivateKey = secretBytes32("PROVIDER_SPP_ENCRYPTION_PRIVATE_KEY_HEX");
    membershipBlindingLe = secretBytes32("PROVIDER_SPP_MEMBERSHIP_BLINDING_LE_HEX");
    if (manifest.spp?.contracts?.pool !== PHLOEM_NETWORK.sppPoolId) {
      throw new Error("canonical deployment manifest differs from the configured SPP pool");
    }
    const snapshot = await store.readSnapshot();
    const reservation = snapshot.reservations.find((item) => item.reservationId === toHex(reservationId));
    const payment = paymentRead.result;
    if (!reservation
      || reservation.sessionId !== toHex(sessionId)
      || reservation.status !== "SETTLED"
      || !reservation.settlementConfirmation
      || !payment
      || payment.status.tag !== "Settled"
      || toHex(payment.session_id) !== toHex(sessionId)) {
      throw new Error("provider exit requires one reconciled settled PRIVATE payment");
    }
    const providerPublicKey = deriveSppNotePublicKey(notePrivateKeyLe);
    const notePublicKeyLe = Buffer.from(fieldToBytes(providerPublicKey)).reverse();
    const encryptionPublicKey = deriveX25519PublicKey(encryptionPrivateKey);
    littleEndianField(membershipBlindingLe, "provider SPP membership blinding");
    const recipient = providerSettlementAccount();
    const bridge = new NativeSppProviderWithdrawBridge({
      process: new NativeSppDepositProcess({ binaryPath, workingDirectory: root }),
      simulationSource: PHLOEM_NETWORK.executionFeePayerPublicKey,
    });
    const prepared = await bridge.prepare({
      sessionId,
      reservationId,
      settlementTransactionHash: Buffer.from(reservation.settlementConfirmation.transactionHash, "hex"),
      settlementLedger: reservation.settlementConfirmation.ledgerSequence,
      expectedProviderOutputCommitment: payment.provider_spp_output_commitment,
      withdrawalRecipient: recipient,
      notePrivateKeyLe,
      notePublicKeyLe,
      encryptionPrivateKey,
      encryptionPublicKey,
      membershipBlindingLe,
    });
    const transaction = assertProviderExitEnvelope(prepared.unsignedTransactionXdr);
    return Object.freeze({
      sessionId: toHex(sessionId),
      reservationId: toHex(reservationId),
      settlementTransactionHash: reservation.settlementConfirmation.transactionHash,
      providerSettlementAccount: recipient,
      assetMovement: Object.freeze({
        asset: "Circle Testnet USDC",
        amountAtomic: prepared.withdrawalAmountAtomic.toString(),
        direction: "SPP_POOL_TO_PROVIDER" as const,
      }),
      unsignedTransactionXdr: prepared.unsignedTransactionXdr,
      transactionHash: toHex(transaction.hash()),
      maximumFeeStroops: transaction.fee,
      resource: prepared.resource,
      safety: Object.freeze({
        signed: false as const,
        submitted: false as const,
        source: PHLOEM_NETWORK.executionFeePayerPublicKey,
        providerNoteRecoveredFromExactSettlementEvent: true as const,
        upstreamSqliteUsed: false as const,
      }),
    });
  } finally {
    notePrivateKeyLe?.fill(0);
    encryptionPrivateKey?.fill(0);
    membershipBlindingLe?.fill(0);
    store.close();
  }
}
