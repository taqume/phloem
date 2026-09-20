import { randomBytes } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  EncryptedSppPrivateTransferPlanner,
  LocalGroth16ProofWorker,
  NativeSppDepositProcess,
  NativeSppTransferRuntimeBridge,
  PrivateSettlementPlanner,
  StellarSppDepositConfirmationSource,
  TreasuryPrivacyKeyManager,
  TreasurySppRebalancePlanner,
  bindSppUsdcTestnetDeployment,
} from "@phloem/privacy-runtime";
import { RpcStellarSubmitter, StellarCliSourceSigner } from "@phloem/execution-gateway";
import { toHex } from "@phloem/protocol-types";
import { Client } from "@phloem/treasury-controller-client";
import {
  Address,
  Transaction,
  TransactionBuilder,
  checkAuthEntryReadiness,
  inspectAuthEntry,
  rpc,
} from "@stellar/stellar-sdk";

import { PHLOEM_NETWORK } from "../network";
import { openEncryptedAgentIdentityVault } from "./live-agent-runtime";
import { loadControlledProviderPrivatePublicConfig } from "./private-session";

const BINDING_PUBLIC_INPUTS = 16;
const FEE_PAYER_IDENTITY_ALIAS = "phloem-testnet-wasm-uploader";
const SPP_REBALANCE_FEE_CEILING_STROOPS = 100_000_000n;
const PRIVATE_SETTLEMENT_FEE_CEILING_STROOPS = 100_000_000n;

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

async function nativeBridgeBinary(root: string): Promise<string> {
  const path = process.env.PHLOEM_SPP_TRANSFER_BRIDGE_BIN
    || join(root, "tools/spp-runtime-probe/target/release/spp-transfer-bridge");
  const metadata = await lstat(path).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new Error("pinned native SPP transfer bridge is missing; build the release binary first");
  }
  return path;
}

function bindingArtifacts(root: string) {
  const setup = join(root, ".phloem/private-binding-setup");
  return Object.freeze({
    wasmPath: join(setup, "PrivateSettlementBindingV1_js/PrivateSettlementBindingV1.wasm"),
    zkeyPath: join(setup, "private_binding_final.zkey"),
    verificationKeyPath: join(setup, "verification_key.json"),
    publicInputCount: BINDING_PUBLIC_INPUTS,
  });
}

async function settlementPlanner() {
  const root = repositoryRoot();
  const [{ store }, canonicalManifest, sdkManifest, binaryPath] = await Promise.all([
    openEncryptedAgentIdentityVault(),
    readFile(join(root, "deployments/testnet.json"), "utf8").then((value) => JSON.parse(value) as unknown),
    readFile(join(root, "deployments/spp-usdc-testnet.sdk.json"), "utf8").then((value) => JSON.parse(value) as unknown),
    nativeBridgeBinary(root),
  ]);
  try {
    const deployment = bindSppUsdcTestnetDeployment(canonicalManifest, sdkManifest);
    if (deployment.poolContractId !== PHLOEM_NETWORK.sppPoolId) {
      throw new Error("pinned SPP deployment differs from the live Phloem network configuration");
    }
    const treasuryKeys = new TreasuryPrivacyKeyManager(store);
    const bridge = new NativeSppTransferRuntimeBridge({
      process: new NativeSppDepositProcess({ binaryPath, workingDirectory: root }),
      simulationSource: PHLOEM_NETWORK.executionFeePayerPublicKey,
      confirmationSource: new StellarSppDepositConfirmationSource(PHLOEM_NETWORK.rpcUrl),
    });
    return Object.freeze({
      store,
      planner: new PrivateSettlementPlanner({
        store,
        proofWorker: new LocalGroth16ProofWorker({
          snarkJsCli: join(root, "node_modules/snarkjs/build/cli.cjs"),
        }),
        bindingArtifacts: bindingArtifacts(root),
        spp: new EncryptedSppPrivateTransferPlanner({ treasuryKeys, bridge }),
        sppDeployment: deployment,
        treasuryKeys,
        random: { bytes: (length: number) => randomBytes(length) },
      }),
    });
  } catch (error: unknown) {
    store.close();
    throw error;
  }
}

async function rebalancePlanner() {
  const root = repositoryRoot();
  const { store } = await openEncryptedAgentIdentityVault();
  try {
    const treasuryKeys = new TreasuryPrivacyKeyManager(store);
    const bridge = new NativeSppTransferRuntimeBridge({
      process: new NativeSppDepositProcess({
        binaryPath: await nativeBridgeBinary(root),
        workingDirectory: root,
      }),
      simulationSource: PHLOEM_NETWORK.executionFeePayerPublicKey,
      confirmationSource: new StellarSppDepositConfirmationSource(PHLOEM_NETWORK.rpcUrl),
    });
    return Object.freeze({
      store,
      planner: new TreasurySppRebalancePlanner({ treasuryKeys, bridge }),
    });
  } catch (error: unknown) {
    store.close();
    throw error;
  }
}

function assertSettlementEnvelope(transaction: Transaction): void {
  if (transaction.source !== PHLOEM_NETWORK.executionFeePayerPublicKey || transaction.operations.length !== 1) {
    throw new Error("PRIVATE settlement has an unexpected source or operation count");
  }
  const operation = transaction.operations[0];
  if (!operation
    || operation.type !== "invokeHostFunction"
    || operation.func.type !== "hostFunctionTypeInvokeContract") {
    throw new Error("PRIVATE settlement is not one contract invocation");
  }
  const invocation = operation.func.invokeContract;
  if (Address.fromScAddress(invocation.contractAddress).toString() !== PHLOEM_NETWORK.treasuryControllerId
    || invocation.functionName.toString() !== "settle_private_payment") {
    throw new Error("PRIVATE settlement targets an unexpected contract function");
  }
  if ((operation.auth ?? []).length !== 0) {
    for (const entry of operation.auth ?? []) inspectAuthEntry(entry);
    throw new Error("PRIVATE settlement unexpectedly requests address authorization");
  }
}

function controller(): Client {
  return new Client({
    contractId: PHLOEM_NETWORK.treasuryControllerId,
    networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
    rpcUrl: PHLOEM_NETWORK.rpcUrl,
    publicKey: PHLOEM_NETWORK.executionFeePayerPublicKey,
  });
}

function assertSppRebalanceEnvelope(transactionXdr: string): Transaction {
  const parsed = TransactionBuilder.fromXDR(transactionXdr, PHLOEM_NETWORK.networkPassphrase);
  if (!(parsed instanceof Transaction)
    || parsed.source !== PHLOEM_NETWORK.executionFeePayerPublicKey
    || parsed.operations.length !== 1
    || parsed.signatures.length !== 0) {
    throw new Error("SPP rebalance has an unexpected source, envelope type, or operation count");
  }
  const operation = parsed.operations[0];
  if (!operation
    || operation.type !== "invokeHostFunction"
    || operation.func.type !== "hostFunctionTypeInvokeContract"
    || Address.fromScAddress(operation.func.invokeContract.contractAddress).toString() !== PHLOEM_NETWORK.sppPoolId
    || operation.func.invokeContract.functionName.toString() !== "transact") {
    throw new Error("SPP rebalance does not target the pinned pool transact function");
  }
  if ((operation.auth ?? []).some((entry) => checkAuthEntryReadiness(entry, 0).unsignedBy.length > 0)) {
    throw new Error("SPP rebalance contains unsigned non-source authorization");
  }
  if (BigInt(parsed.fee) > SPP_REBALANCE_FEE_CEILING_STROOPS) {
    throw new Error("SPP rebalance fee exceeds the P0 safety ceiling");
  }
  return parsed;
}

/** Splits one treasury-owned SPP note; both outputs remain under the same encrypted treasury key. */
export async function rebalanceLiveSppForReservation(input: {
  readonly sessionId: unknown;
  readonly reservationId: unknown;
}) {
  const sessionId = canonicalBytes32(input.sessionId, "session id");
  const reservationId = canonicalBytes32(input.reservationId, "reservation id");
  const runtime = await rebalancePlanner();
  let prepared: Awaited<ReturnType<TreasurySppRebalancePlanner["prepare"]>> | undefined;
  let submitted = false;
  try {
    const snapshot = await runtime.store.readSnapshot();
    const reservation = snapshot.reservations.find((item) => (
      item.reservationId === toHex(reservationId) && item.sessionId === toHex(sessionId)
    ));
    if (!reservation) throw new Error("rebalance requires a known private reservation denomination");
    prepared = await runtime.planner.prepare({
      sessionId,
      reservationId,
      pool: PHLOEM_NETWORK.sppPoolId,
      primaryAmountAtomic: BigInt(reservation.amountAtomic),
    });
    const transaction = assertSppRebalanceEnvelope(prepared.unsignedTransactionXdr);
    const signer = new StellarCliSourceSigner({
      identityAlias: FEE_PAYER_IDENTITY_ALIAS,
      networkName: "testnet",
      networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
      sourcePublicKey: PHLOEM_NETWORK.executionFeePayerPublicKey,
      treasuryControllerId: PHLOEM_NETWORK.sppPoolId,
    });
    const submitter = new RpcStellarSubmitter({
      server: new rpc.Server(PHLOEM_NETWORK.rpcUrl),
      networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
      sourcePublicKey: PHLOEM_NETWORK.executionFeePayerPublicKey,
      treasuryControllerId: PHLOEM_NETWORK.sppPoolId,
    });
    const signed = await signer.sign(prepared.unsignedTransactionXdr);
    const receipt = await submitter.submit(signed);
    submitted = true;
    await runtime.planner.confirm({
      operationId: prepared.operationId,
      primaryNoteId: prepared.primaryNoteId,
      transactionHash: Buffer.from(receipt.transactionHash, "hex"),
      ledgerSequence: receipt.ledgerSequence,
      primaryOutputCommitment: prepared.primaryOutputCommitment,
      changeOutputCommitment: prepared.changeOutputCommitment,
    });
    return Object.freeze({
      sessionId: toHex(sessionId),
      transactionHash: receipt.transactionHash,
      ledgerSequence: receipt.ledgerSequence,
      operationId: toHex(prepared.operationId),
      sourceTransactionHash: toHex(transaction.hash()),
      outputs: Object.freeze({
        count: 2 as const,
        bothTreasuryOwned: true as const,
        privateAmountsRedacted: true as const,
      }),
      resource: prepared.resource,
      maximumFeeStroops: transaction.fee,
    });
  } catch (error: unknown) {
    if (prepared && !submitted) {
      await runtime.planner.abort({
        operationId: prepared.operationId,
        primaryNoteId: prepared.primaryNoteId,
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    runtime.store.close();
  }
}

/** Proves and simulates the exact call, then releases all staged private state. */
export async function simulateLivePrivateSettlement(input: {
  readonly sessionId: unknown;
  readonly reservationId: unknown;
}) {
  const sessionId = canonicalBytes32(input.sessionId, "session id");
  const reservationId = canonicalBytes32(input.reservationId, "reservation id");
  const runtime = await settlementPlanner();
  let operationId: Buffer | undefined;
  try {
    const snapshot = await runtime.store.readSnapshot();
    const reservation = snapshot.reservations.find((item) => item.reservationId === toHex(reservationId));
    if (!reservation
      || reservation.sessionId !== toHex(sessionId)
      || reservation.status !== "OPEN"
      || !reservation.latestVoucher) {
      throw new Error("settlement requires the exact open vouched reservation");
    }
    const provider = loadControlledProviderPrivatePublicConfig();
    const prepared = await runtime.planner.prepare({
      reservationId,
      provider: {
        providerIdentity: provider.providerIdentity,
        providerSppPublicKey: provider.providerSppPublicKey,
        providerSppEncryptionPublicKey: provider.providerSppEncryptionPublicKey,
        serviceIdHash: provider.serviceIdHash,
        categoryId: provider.categoryId,
        allowedSettlementModes: 2,
      },
    });
    operationId = prepared.operationId;
    const assembled = await controller().settle_private_payment(
      { input: prepared.input },
      { timeoutInSeconds: 600 },
    );
    if (!assembled.built || assembled.isReadCall || assembled.needsNonInvokerSigningBy().length !== 0) {
      throw new Error("PRIVATE settlement simulation did not produce one source-submittable write");
    }
    assertSettlementEnvelope(assembled.built);
    const resources = assembled.simulationData.transactionData.resources;
    return Object.freeze({
      sessionId: toHex(sessionId),
      reservationId: toHex(reservationId),
      operationId: toHex(prepared.operationId),
      transactionHash: toHex(assembled.built.hash()),
      maximumFeeStroops: assembled.built.fee,
      resource: Object.freeze({
        envelopeBytes: Buffer.from(assembled.toXdr(), "base64").byteLength,
        instructions: resources.instructions,
        diskReadBytes: resources.diskReadBytes,
        writeBytes: resources.writeBytes,
        readOnlyEntries: resources.footprint.readOnly.length,
        readWriteEntries: resources.footprint.readWrite.length,
      }),
      privacy: Object.freeze({
        publicAmountAtomic: prepared.input.spp_proof.public_amount.toString(),
        externalAmountAtomic: prepared.input.spp_ext_data.ext_amount.toString(),
        providerOutputCommitment: prepared.input.spp_proof.output_commitment0.toString(),
        refundOutputCommitment: prepared.input.spp_proof.output_commitment1.toString(),
        usageRoot: prepared.input.voucher.usage_root.toString(),
        auditUpdateAtomic: true as const,
      }),
    });
  } finally {
    if (operationId) await runtime.planner.abort(operationId).catch(() => undefined);
    runtime.store.close();
  }
}

/** Executes the already-vouched zero-public-amount SPP payment and canonical audit update atomically. */
export async function submitLivePrivateSettlement(input: {
  readonly sessionId: unknown;
  readonly reservationId: unknown;
}) {
  const sessionId = canonicalBytes32(input.sessionId, "session id");
  const reservationId = canonicalBytes32(input.reservationId, "reservation id");
  const runtime = await settlementPlanner();
  let operationId: Buffer | undefined;
  let submitted = false;
  try {
    const snapshot = await runtime.store.readSnapshot();
    const reservation = snapshot.reservations.find((item) => item.reservationId === toHex(reservationId));
    if (!reservation
      || reservation.sessionId !== toHex(sessionId)
      || reservation.status !== "OPEN"
      || !reservation.latestVoucher) {
      throw new Error("settlement requires the exact open vouched reservation");
    }
    const provider = loadControlledProviderPrivatePublicConfig();
    const prepared = await runtime.planner.prepare({
      reservationId,
      provider: {
        providerIdentity: provider.providerIdentity,
        providerSppPublicKey: provider.providerSppPublicKey,
        providerSppEncryptionPublicKey: provider.providerSppEncryptionPublicKey,
        serviceIdHash: provider.serviceIdHash,
        categoryId: provider.categoryId,
        allowedSettlementModes: 2,
      },
    });
    operationId = prepared.operationId;
    const assembled = await controller().settle_private_payment(
      { input: prepared.input },
      { timeoutInSeconds: 600 },
    );
    if (!assembled.built || assembled.isReadCall || assembled.needsNonInvokerSigningBy().length !== 0) {
      throw new Error("PRIVATE settlement simulation did not produce one source-submittable write");
    }
    assertSettlementEnvelope(assembled.built);
    if (BigInt(assembled.built.fee) > PRIVATE_SETTLEMENT_FEE_CEILING_STROOPS) {
      throw new Error("PRIVATE settlement fee exceeds the P0 safety ceiling");
    }
    const signer = new StellarCliSourceSigner({
      identityAlias: FEE_PAYER_IDENTITY_ALIAS,
      networkName: "testnet",
      networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
      sourcePublicKey: PHLOEM_NETWORK.executionFeePayerPublicKey,
      treasuryControllerId: PHLOEM_NETWORK.treasuryControllerId,
    });
    const submitter = new RpcStellarSubmitter({
      server: new rpc.Server(PHLOEM_NETWORK.rpcUrl),
      networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
      sourcePublicKey: PHLOEM_NETWORK.executionFeePayerPublicKey,
      treasuryControllerId: PHLOEM_NETWORK.treasuryControllerId,
    });
    const signed = await signer.sign(assembled.toXdr());
    const receipt = await submitter.submit(signed);
    submitted = true;
    await runtime.planner.confirm({
      operationId: prepared.operationId,
      transactionHash: Buffer.from(receipt.transactionHash, "hex"),
      ledgerSequence: receipt.ledgerSequence,
    });
    const confirmed = (await runtime.store.readSnapshot()).reservations.find(
      (item) => item.reservationId === toHex(reservationId),
    );
    if (confirmed?.status !== "SETTLED"
      || confirmed.settlementConfirmation?.transactionHash !== receipt.transactionHash) {
      throw new Error("encrypted settlement state did not reconcile with the Testnet receipt");
    }
    const resources = assembled.simulationData.transactionData.resources;
    return Object.freeze({
      sessionId: toHex(sessionId),
      reservationId: toHex(reservationId),
      transactionHash: receipt.transactionHash,
      ledgerSequence: receipt.ledgerSequence,
      maximumFeeStroops: assembled.built.fee,
      resource: Object.freeze({
        envelopeBytes: Buffer.from(assembled.toXdr(), "base64").byteLength,
        instructions: resources.instructions,
        diskReadBytes: resources.diskReadBytes,
        writeBytes: resources.writeBytes,
        readOnlyEntries: resources.footprint.readOnly.length,
        readWriteEntries: resources.footprint.readWrite.length,
      }),
      privacy: Object.freeze({
        publicAmountAtomic: prepared.input.spp_proof.public_amount.toString(),
        externalAmountAtomic: prepared.input.spp_ext_data.ext_amount.toString(),
        providerOutputCommitment: prepared.input.spp_proof.output_commitment0.toString(),
        refundOutputCommitment: prepared.input.spp_proof.output_commitment1.toString(),
        usageRoot: prepared.input.voucher.usage_root.toString(),
        auditUpdateAtomic: true as const,
      }),
    });
  } catch (error: unknown) {
    if (operationId && !submitted) await runtime.planner.abort(operationId).catch(() => undefined);
    throw error;
  } finally {
    runtime.store.close();
  }
}

/** Read-only reconciliation of public Testnet state with the encrypted local authority state. */
export async function verifyLivePrivateSettlement(input: {
  readonly sessionId: unknown;
  readonly reservationId: unknown;
}) {
  const sessionId = canonicalBytes32(input.sessionId, "session id");
  const reservationId = canonicalBytes32(input.reservationId, "reservation id");
  const { store } = await openEncryptedAgentIdentityVault();
  try {
    const client = controller();
    const [reservationRead, paymentRead, auditRead, snapshot] = await Promise.all([
      client.get_private_reservation({ reservation_id: reservationId }),
      client.get_private_payment_record({ reservation_id: reservationId }),
      client.get_audit_state({ session_id: sessionId }),
      store.readSnapshot(),
    ]);
    const chainReservation = reservationRead.result;
    const payment = paymentRead.result;
    const audit = auditRead.result;
    const localReservation = snapshot.reservations.find((item) => item.reservationId === toHex(reservationId));
    const localAudit = snapshot.auditAccumulators.find((item) => item.sessionId === toHex(sessionId));
    if (!chainReservation || chainReservation.status.tag !== "Settled") {
      throw new Error("Testnet reservation is not settled");
    }
    if (!payment || payment.status.tag !== "Settled") {
      throw new Error("Testnet private payment record is not settled");
    }
    if (!audit) throw new Error("Testnet audit state is missing");
    if (!localReservation
      || localReservation.sessionId !== toHex(sessionId)
      || localReservation.status !== "SETTLED"
      || !localReservation.latestVoucher
      || !localReservation.settlementConfirmation) {
      throw new Error("encrypted reservation state is not settled");
    }
    if (!localAudit
      || localAudit.auditVersion !== audit.audit_version
      || localAudit.commitment !== audit.total_spend_commitment.toString()) {
      throw new Error("encrypted audit opening differs from Testnet audit state");
    }
    if (payment.voucher_sequence.toString() !== localReservation.latestVoucher.sequence
      || payment.usage_root.toString() !== localReservation.latestVoucher.usageRoot) {
      throw new Error("Testnet payment record differs from the accepted voucher");
    }
    const sessionNotes = snapshot.sppTreasuryNotes.filter((note) => note.sessionId === toHex(sessionId));
    return Object.freeze({
      reconciled: true as const,
      sessionId: toHex(sessionId),
      reservationId: toHex(reservationId),
      transactionHash: localReservation.settlementConfirmation.transactionHash,
      ledgerSequence: localReservation.settlementConfirmation.ledgerSequence,
      chain: Object.freeze({
        reservationStatus: chainReservation.status.tag,
        paymentStatus: payment.status.tag,
        voucherSequence: payment.voucher_sequence.toString(),
        settledAtLedger: payment.settled_at_ledger,
        providerOutputCommitment: payment.provider_spp_output_commitment.toString(),
        refundOutputCommitment: payment.spp_refund_output_commitment.toString(),
        usageRoot: payment.usage_root.toString(),
        auditVersion: audit.audit_version,
        settlementCount: audit.settlement_count.toString(),
        unresolvedReservationCount: audit.unresolved_reservation_count.toString(),
      }),
      encryptedState: Object.freeze({
        reservationStatus: localReservation.status,
        auditVersion: localAudit.auditVersion,
        acceptedEvidenceCount: snapshot.usageEvidence.filter(
          (item) => item.evidence.reservationId === toHex(reservationId),
        ).length,
        sppNotes: Object.freeze({
          active: sessionNotes.filter((note) => note.status === "ACTIVE").length,
          spent: sessionNotes.filter((note) => note.status === "SPENT").length,
          pending: sessionNotes.filter((note) => note.status === "SPEND_PENDING").length,
        }),
      }),
    });
  } finally {
    store.close();
  }
}
