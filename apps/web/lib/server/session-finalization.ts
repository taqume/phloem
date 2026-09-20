import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

import {
  FinalAuditQueryPlanner,
  LocalGroth16ProofWorker,
} from "@phloem/privacy-runtime";
import { Client, type Groth16Proof } from "@phloem/treasury-controller-client";
import {
  Address,
  Networks,
  Transaction,
  TransactionBuilder,
  contract,
  inspectAuthEntry,
  rpc,
} from "@stellar/stellar-sdk";

import { PHLOEM_NETWORK } from "../network";
import type {
  AuditQlVerification,
  PreparedSessionFinalization,
  SessionFinalizationAction,
  SessionFinalizationConfirmation,
} from "../session-finalization-types";
import { openEncryptedAgentIdentityVault } from "./live-agent-runtime";

const FINALIZATION_FEE_CEILING_STROOPS = 2_000_000n;
const AUDIT_PUBLIC_INPUT_COUNT = 7;

interface AuditVerifierContract {
  verify_final: (
    args: { readonly session_id: Buffer; readonly threshold_atomic: bigint; readonly proof: Groth16Proof },
    options?: contract.MethodOptions,
  ) => Promise<contract.AssembledTransaction<boolean>>;
}

function repositoryRoot(): string {
  const cwd = process.cwd();
  return basename(cwd) === "web" && basename(dirname(cwd)) === "apps" ? resolve(cwd, "../..") : cwd;
}

function sessionIdBytes(value: unknown): Buffer {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError("sessionId must be 32-byte lowercase hexadecimal");
  }
  return Buffer.from(value, "hex");
}

function transactionHash(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError("transactionHash must be 32-byte lowercase hexadecimal");
  }
  return value;
}

function action(value: unknown): SessionFinalizationAction {
  if (value !== "begin_draining" && value !== "finalize_audit" && value !== "close_session") {
    throw new TypeError("unsupported session finalization action");
  }
  return value;
}

function threshold(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError("thresholdAtomic must be a canonical u64 decimal string");
  }
  const parsed = BigInt(value);
  if (parsed < 0n || parsed >= 1n << 64n) throw new RangeError("thresholdAtomic must fit u64");
  return parsed;
}

function controller(publicKey: string): Client {
  return new Client({
    contractId: PHLOEM_NETWORK.treasuryControllerId,
    networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
    rpcUrl: PHLOEM_NETWORK.rpcUrl,
    publicKey,
  });
}

function assertLifecycleEnvelope(transaction: Transaction, expectedAction: SessionFinalizationAction): void {
  if (transaction.source !== PHLOEM_NETWORK.companyFundingPublicKey || transaction.operations.length !== 1) {
    throw new Error(`${expectedAction} has an unexpected source or operation count`);
  }
  const operation = transaction.operations[0];
  if (!operation || operation.type !== "invokeHostFunction"
    || operation.func.type !== "hostFunctionTypeInvokeContract") {
    throw new Error(`${expectedAction} is not one contract invocation`);
  }
  const invocation = operation.func.invokeContract;
  if (Address.fromScAddress(invocation.contractAddress).toString() !== PHLOEM_NETWORK.treasuryControllerId
    || invocation.functionName.toString() !== expectedAction) {
    throw new Error(`${expectedAction} targets an unexpected contract function`);
  }
  const operationAuth = operation.auth ?? [];
  if (operationAuth.length !== 1) throw new Error(`${expectedAction} must contain one company authorization`);
  const auth = inspectAuthEntry(operationAuth[0]!);
  if (auth.credentialType !== "sourceAccount" || auth.address !== null
    || auth.invocation.function.type !== "sorobanAuthorizedFunctionTypeContractFn"
    || auth.invocation.subInvocations.length !== 0) {
    throw new Error(`${expectedAction} contains authorization beyond the source company account`);
  }
  const authorized = auth.invocation.function.value;
  if (Address.fromScAddress(authorized.contractAddress).toString() !== PHLOEM_NETWORK.treasuryControllerId
    || authorized.functionName.toString() !== expectedAction) {
    throw new Error(`${expectedAction} company authorization targets another invocation`);
  }
}

export async function prepareSessionFinalization(input: {
  readonly company: unknown;
  readonly sessionId: unknown;
  readonly action: unknown;
}): Promise<PreparedSessionFinalization> {
  if (input.company !== PHLOEM_NETWORK.companyFundingPublicKey) {
    throw new Error("connected account is not the controlled company wallet");
  }
  const selectedAction = action(input.action);
  const canonicalSessionId = sessionIdBytes(input.sessionId);
  const api = controller(input.company);
  const assembled = selectedAction === "begin_draining"
    ? await api.begin_draining({ session_id: canonicalSessionId }, { timeoutInSeconds: 300 })
    : selectedAction === "finalize_audit"
      ? await api.finalize_audit({ session_id: canonicalSessionId }, { timeoutInSeconds: 300 })
      : await api.close_session({ session_id: canonicalSessionId }, { timeoutInSeconds: 300 });
  if (!assembled.built || assembled.isReadCall || assembled.needsNonInvokerSigningBy().length !== 0) {
    throw new Error(`${selectedAction} did not produce the canonical company-authorized write`);
  }
  assertLifecycleEnvelope(assembled.built, selectedAction);
  if (BigInt(assembled.built.fee) > FINALIZATION_FEE_CEILING_STROOPS) {
    throw new Error(`${selectedAction} fee exceeds the P0 finalization ceiling`);
  }
  const resources = assembled.simulationData.transactionData.resources;
  return Object.freeze({
    transactionXdr: assembled.toXdr(),
    sessionId: canonicalSessionId.toString("hex"),
    action: selectedAction,
    resource: Object.freeze({
      instructions: resources.instructions,
      diskReadBytes: resources.diskReadBytes,
      writeBytes: resources.writeBytes,
      maximumFeeStroops: assembled.built.fee,
      approvedFeeCeilingStroops: FINALIZATION_FEE_CEILING_STROOPS.toString(),
    }),
    safety: Object.freeze({
      operationCount: 1 as const,
      contractId: PHLOEM_NETWORK.treasuryControllerId,
      functionName: selectedAction,
      companyAuthorization: "source-account" as const,
      assetMovement: false as const,
    }),
  });
}

export async function verifySessionFinalization(input: {
  readonly transactionHash: unknown;
  readonly sessionId: unknown;
  readonly action: unknown;
}): Promise<SessionFinalizationConfirmation> {
  const hash = transactionHash(input.transactionHash);
  const canonicalSessionId = sessionIdBytes(input.sessionId);
  const selectedAction = action(input.action);
  const server = new rpc.Server(PHLOEM_NETWORK.rpcUrl);
  const final = await server.getTransaction(hash);
  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`${selectedAction} transaction is not confirmed successfully`);
  }
  const parsed = TransactionBuilder.fromXDR(final.envelopeXdr, Networks.TESTNET);
  if (!(parsed instanceof Transaction)) throw new Error(`${selectedAction} is not a classic transaction envelope`);
  assertLifecycleEnvelope(parsed, selectedAction);
  const api = controller(PHLOEM_NETWORK.companyFundingPublicKey);
  const [sessionRead, snapshotRead] = await Promise.all([
    api.get_session({ session_id: canonicalSessionId }),
    selectedAction === "begin_draining"
      ? Promise.resolve(undefined)
      : api.get_final_audit_snapshot({ session_id: canonicalSessionId }),
  ]);
  const session = sessionRead.result;
  const snapshot = snapshotRead?.result;
  const expectedLifecycle = selectedAction === "close_session" ? "Closed" : "Draining";
  if (!session || session.lifecycle.tag !== expectedLifecycle
    || (selectedAction === "begin_draining" && session.audit_finalized)
    || (selectedAction !== "begin_draining" && (!session.audit_finalized || !snapshot))) {
    throw new Error(`${selectedAction} confirmed state differs from the canonical lifecycle transition`);
  }
  return Object.freeze({
    transactionHash: hash,
    ledger: final.ledger,
    feeChargedStroops: final.resultXdr.feeCharged.toString(),
    sessionId: canonicalSessionId.toString("hex"),
    action: selectedAction,
    lifecycle: expectedLifecycle,
    auditFinalized: session.audit_finalized,
    ...(snapshot ? { finalSnapshotHash: Buffer.from(snapshot.snapshot_hash).toString("hex") } : {}),
  });
}

export async function proveAndVerifyAuditQl(input: {
  readonly sessionId: unknown;
  readonly thresholdAtomic: unknown;
}): Promise<AuditQlVerification> {
  const canonicalSessionId = sessionIdBytes(input.sessionId);
  const thresholdAtomic = threshold(input.thresholdAtomic);
  const api = controller(PHLOEM_NETWORK.executionFeePayerPublicKey);
  const statement = await api.get_total_spend_leq_inputs({
    session_id: canonicalSessionId,
    threshold_atomic: thresholdAtomic,
  });
  const root = repositoryRoot();
  const { store } = await openEncryptedAgentIdentityVault();
  try {
    const planner = new FinalAuditQueryPlanner({
      store,
      proofWorker: new LocalGroth16ProofWorker({
        snarkJsCli: join(root, "node_modules/snarkjs/build/cli.cjs"),
      }),
      artifacts: Object.freeze({
        wasmPath: join(root, ".phloem/audit-total-spend-leq-setup/AuditTotalSpendLeqV1_js/AuditTotalSpendLeqV1.wasm"),
        zkeyPath: join(root, ".phloem/audit-total-spend-leq-setup/audit_total_spend_leq_final.zkey"),
        verificationKeyPath: join(root, ".phloem/audit-total-spend-leq-setup/verification_key.json"),
        publicInputCount: AUDIT_PUBLIC_INPUT_COUNT,
      }),
    });
    const bundle = await planner.proveTotalSpendLeq({
      sessionId: canonicalSessionId,
      publicInputs: statement.result,
    });
    const verifier = await contract.Client.from<AuditVerifierContract>({
      contractId: PHLOEM_NETWORK.auditTotalSpendLeqVerifierId,
      networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
      rpcUrl: PHLOEM_NETWORK.rpcUrl,
      publicKey: PHLOEM_NETWORK.executionFeePayerPublicKey,
    });
    const verification = await verifier.verify_final({
      session_id: canonicalSessionId,
      threshold_atomic: thresholdAtomic,
      proof: bundle.proof,
    }, { timeoutInSeconds: 300 });
    const resources = verification.simulationData.transactionData.resources;
    const testnetVerifierAccepted = verification.result === true;
    const proofBytes = Buffer.concat([bundle.proof.a, bundle.proof.b, bundle.proof.c]);
    return Object.freeze({
      sessionId: canonicalSessionId.toString("hex"),
      templateId: bundle.templateId,
      templateVersion: bundle.templateVersion,
      thresholdAtomic: thresholdAtomic.toString(),
      auditVersion: bundle.auditVersion,
      snapshotHash: bundle.snapshotHash.toString("hex"),
      proofSha256: createHash("sha256").update(proofBytes).digest("hex"),
      verifierContractId: PHLOEM_NETWORK.auditTotalSpendLeqVerifierId,
      verified: true as const,
      execution: testnetVerifierAccepted
        ? "testnet-rpc-simulation" as const
        : "local-snarkjs-live-testnet-statement" as const,
      testnetVerifierAccepted,
      resource: Object.freeze({
        instructions: resources.instructions,
        diskReadBytes: resources.diskReadBytes,
        writeBytes: resources.writeBytes,
        maximumFeeStroops: verification.built?.fee ?? "0",
      }),
    });
  } finally {
    store.close();
  }
}
