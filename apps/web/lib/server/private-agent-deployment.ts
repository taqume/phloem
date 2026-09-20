import { createHash } from "node:crypto";

import type { PrivateAgentRole } from "@phloem/privacy-runtime/agent-identities";
import { Client } from "@phloem/treasury-controller-client";
import {
  Address,
  Account,
  BASE_FEE,
  Networks,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  inspectAuthEntry,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";

import type {
  PreparedPrivateAgentDeployment,
  PrivateAgentDeploymentConfirmation,
  PrivateAgentDeploymentConfirmationInput,
  PrivateAgentPreparationResult,
} from "../private-agent-types";
import { PHLOEM_NETWORK } from "../network";
import { assertCanonicalAgentAccountRule } from "./agent-account-rule";
import { openEncryptedAgentIdentityVault } from "./live-agent-runtime";

const AGENT_DEPLOYMENT_FEE_CEILING_STROOPS = 2_000_000n;

function bytes32Hex(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be 32-byte lowercase hexadecimal`);
  }
  return value;
}

function role(value: unknown): PrivateAgentRole {
  if (value !== "SUPERVISOR" && value !== "RESEARCH" && value !== "BUILDER") {
    throw new TypeError("agent role is invalid");
  }
  return value;
}

function deploymentSalt(sessionId: string, agentRole: PrivateAgentRole, publicKeyHex: string): Buffer {
  return createHash("sha256")
    .update("PHLOEM_AGENT_ACCOUNT_TESTNET_V1", "utf8")
    .update(Buffer.from(sessionId, "hex"))
    .update(agentRole, "utf8")
    .update(Buffer.from(publicKeyHex, "hex"))
    .digest();
}

function constructorArgs(publicKeyHex: string, validUntilLedger: number): xdr.ScVal[] {
  return [
    new Address(PHLOEM_NETWORK.treasuryControllerId).toScVal(),
    new Address(PHLOEM_NETWORK.ed25519VerifierId).toScVal(),
    xdr.ScVal.scvBytes(Buffer.from(publicKeyHex, "hex")),
    xdr.ScVal.scvU32(validUntilLedger),
  ];
}

function createOperation(input: {
  readonly company: string;
  readonly sessionId: string;
  readonly role: PrivateAgentRole;
  readonly publicKeyHex: string;
  readonly validUntilLedger: number;
}) {
  return Operation.createCustomContract({
    address: new Address(input.company),
    wasmHash: Buffer.from(PHLOEM_NETWORK.agentAccountWasmHash, "hex"),
    salt: deploymentSalt(input.sessionId, input.role, input.publicKeyHex),
    constructorArgs: constructorArgs(input.publicKeyHex, input.validUntilLedger),
  });
}

function hostFunctionHash(operation: Extract<Transaction["operations"][number], { type: "invokeHostFunction" }>): string {
  return createHash("sha256").update(operation.func.toXDR()).digest("hex");
}

function assertDeploymentTransaction(transaction: Transaction, expectedHostFunctionHash: string): void {
  if (
    transaction.source !== PHLOEM_NETWORK.companyFundingPublicKey
    || transaction.operations.length !== 1
    || transaction.signatures.length > 1
  ) {
    throw new Error("AgentAccount deployment has an unexpected source, operation count, or signature count");
  }
  const operation = transaction.operations[0];
  if (!operation || operation.type !== "invokeHostFunction" || operation.func.type !== "hostFunctionTypeCreateContractV2") {
    throw new Error("AgentAccount deployment is not one createContractV2 host function");
  }
  if (hostFunctionHash(operation) !== expectedHostFunctionHash) {
    throw new Error("AgentAccount deployment constructor differs from the session-bound preflight");
  }
  const auth = operation.auth ?? [];
  if (auth.length !== 1) throw new Error("AgentAccount deployment must carry one source-account authorization");
  const inspected = inspectAuthEntry(auth[0]!);
  if (
    inspected.credentialType !== "sourceAccount"
    || inspected.address !== null
    || inspected.invocation.function.type !== "sorobanAuthorizedFunctionTypeCreateContractV2HostFn"
    || inspected.invocation.subInvocations.length !== 0
  ) {
    throw new Error("AgentAccount deployment contains non-source or nested authorization");
  }
  if (BigInt(transaction.fee) > AGENT_DEPLOYMENT_FEE_CEILING_STROOPS) {
    throw new Error("AgentAccount deployment fee exceeds the approved ceiling");
  }
}

async function privateSession(sessionId: string) {
  const client = new Client({
    contractId: PHLOEM_NETWORK.treasuryControllerId,
    networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
    rpcUrl: PHLOEM_NETWORK.rpcUrl,
    publicKey: PHLOEM_NETWORK.companyFundingPublicKey,
  });
  const response = await client.get_session({ session_id: Buffer.from(sessionId, "hex") });
  const session = response.result;
  if (
    !session
    || session.company !== PHLOEM_NETWORK.companyFundingPublicKey
    || session.settlement_mode.tag !== "Private"
    || session.lifecycle.tag !== "Draft"
  ) {
    throw new Error("session is not the controlled company PRIVATE draft");
  }
  return session;
}

export async function preparePrivateAgentDeployment(input: {
  readonly company: string;
  readonly sessionId: string;
  readonly role: PrivateAgentRole;
}): Promise<PrivateAgentPreparationResult> {
  if (input.company !== PHLOEM_NETWORK.companyFundingPublicKey) {
    throw new Error("connected wallet is not the controlled Testnet company account");
  }
  const sessionId = bytes32Hex(input.sessionId, "session id");
  const agentRole = role(input.role);
  const [session, server] = await Promise.all([
    privateSession(sessionId),
    Promise.resolve(new rpc.Server(PHLOEM_NETWORK.rpcUrl)),
  ]);
  const latest = await server.getLatestLedger();
  if (latest.sequence >= session.expires_at_ledger) throw new Error("PRIVATE session has expired");
  const { store, vault } = await openEncryptedAgentIdentityVault();
  try {
    const identity = await vault.prepare({
      sessionId,
      role: agentRole,
      validUntilLedger: session.expires_at_ledger,
    });
    if (identity.status === "DEPLOYED") {
      if (!identity.contractId || !identity.deploymentConfirmation) {
        throw new Error(`${agentRole} AgentAccount deployment state is incomplete`);
      }
      return Object.freeze({
        alreadyDeployed: true as const,
        transactionHash: identity.deploymentConfirmation.transactionHash,
        sessionId,
        role: agentRole,
        contractId: identity.contractId,
        ledger: identity.deploymentConfirmation.ledgerSequence,
      });
    }
    const operation = createOperation({
      company: input.company,
      sessionId,
      role: agentRole,
      publicKeyHex: identity.publicKeyHex,
      validUntilLedger: identity.validUntilLedger,
    });
    const account = await server.getAccount(input.company);
    const raw = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(operation)
      .setTimeout(300)
      .build();
    const expectedHostFunctionHash = hostFunctionHash(raw.operations[0] as Extract<
      Transaction["operations"][number], { type: "invokeHostFunction" }
    >);
    const simulation = await server.simulateTransaction(raw);
    if (rpc.Api.isSimulationError(simulation)) throw new Error("AgentAccount Testnet simulation failed");
    if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
      throw new Error("AgentAccount Testnet simulation did not produce a contract id");
    }
    const prepared = rpc.assembleTransaction(raw, simulation).build();
    assertDeploymentTransaction(prepared, expectedHostFunctionHash);
    const contractId = Address.fromScVal(simulation.result.retval).toString();
    const resources = simulation.transactionData.build().resources;
    return Object.freeze({
      transactionXdr: prepared.toXDR(),
      sessionId,
      role: agentRole,
      contractId,
      publicKeyHex: identity.publicKeyHex,
      validUntilLedger: identity.validUntilLedger,
      resource: Object.freeze({
        instructions: resources.instructions,
        diskReadBytes: resources.diskReadBytes,
        writeBytes: resources.writeBytes,
        readOnlyEntries: resources.footprint.readOnly.length,
        readWriteEntries: resources.footprint.readWrite.length,
        maximumFeeStroops: prepared.fee,
        approvedFeeCeilingStroops: AGENT_DEPLOYMENT_FEE_CEILING_STROOPS.toString(),
      }),
      safety: Object.freeze({
        operationCount: 1 as const,
        hostFunction: "createContractV2" as const,
        contractInvocation: false as const,
        assetMovement: false as const,
      }),
    });
  } finally {
    store.close();
  }
}

export async function verifyPrivateAgentDeployment(
  input: PrivateAgentDeploymentConfirmationInput,
): Promise<PrivateAgentDeploymentConfirmation> {
  const transactionHash = bytes32Hex(input.transactionHash, "transaction hash");
  const sessionId = bytes32Hex(input.sessionId, "session id");
  const agentRole = role(input.role);
  if (!StrKey.isValidContract(input.contractId)) throw new TypeError("agent contract id is invalid");
  const session = await privateSession(sessionId);
  const { store, vault } = await openEncryptedAgentIdentityVault();
  try {
    const identity = await vault.resolve(sessionId, agentRole);
    const expectedOperation = createOperation({
      company: PHLOEM_NETWORK.companyFundingPublicKey,
      sessionId,
      role: agentRole,
      publicKeyHex: identity.publicKeyHex,
      validUntilLedger: session.expires_at_ledger,
    });
    const expectedTransaction = new TransactionBuilder(
      new Account(PHLOEM_NETWORK.companyFundingPublicKey, "0"),
      { fee: BASE_FEE, networkPassphrase: Networks.TESTNET },
    ).addOperation(expectedOperation).setTimeout(300).build();
    const expectedBuiltOperation = expectedTransaction.operations[0];
    if (!expectedBuiltOperation || expectedBuiltOperation.type !== "invokeHostFunction") {
      throw new Error("invalid expected deployment operation");
    }
    const expectedHostFunctionHash = hostFunctionHash(expectedBuiltOperation);
    const server = new rpc.Server(PHLOEM_NETWORK.rpcUrl);
    const final = await server.getTransaction(transactionHash);
    if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error("AgentAccount deployment is not confirmed successfully");
    }
    const transaction = TransactionBuilder.fromXDR(final.envelopeXdr, Networks.TESTNET);
    if (!(transaction instanceof Transaction)) throw new Error("AgentAccount deployment is not a classic transaction");
    assertDeploymentTransaction(transaction, expectedHostFunctionHash);
    const operation = transaction.operations[0];
    if (!operation || operation.type !== "invokeHostFunction") throw new Error("missing AgentAccount create operation");
    const created = Address.fromScVal(final.returnValue ?? xdr.ScVal.scvVoid()).toString();
    if (created !== input.contractId) throw new Error("confirmed AgentAccount id differs from the prepared id");
    const wasm = await server.getContractWasmByContractId(input.contractId);
    if (createHash("sha256").update(wasm).digest("hex") !== PHLOEM_NETWORK.agentAccountWasmHash) {
      throw new Error("confirmed AgentAccount resolves to another WASM");
    }
    const [countRead, ruleRead] = await Promise.all([
      server.queryContract<number>(input.contractId, "get_context_rules_count"),
      server.queryContract<Record<string, unknown>>(input.contractId, "get_context_rule", { context_rule_id: 0 }),
    ]);
    if (countRead.result !== 1) throw new Error("AgentAccount does not expose exactly one context rule");
    assertCanonicalAgentAccountRule(ruleRead.result, {
      controllerId: PHLOEM_NETWORK.treasuryControllerId,
      verifierId: PHLOEM_NETWORK.ed25519VerifierId,
      publicKeyHex: identity.publicKeyHex,
      validUntilLedger: identity.validUntilLedger,
    });
    await vault.confirmDeployment({
      sessionId,
      role: agentRole,
      contractId: input.contractId,
      confirmation: { transactionHash, ledgerSequence: final.ledger },
    });
    return Object.freeze({
      transactionHash,
      sessionId,
      role: agentRole,
      contractId: input.contractId,
      ledger: final.ledger,
      feeChargedStroops: final.resultXdr.feeCharged.toString(),
    });
  } finally {
    store.close();
  }
}
