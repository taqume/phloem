import {
  deriveSppNotePublicKey,
  deriveX25519PublicKey,
} from "@phloem/privacy-runtime/keys";
import { buildPrivateSessionPolicy } from "@phloem/privacy-runtime/session-policy";
import {
  BN254_SCALAR_MODULUS,
  networkId,
  toHex,
} from "@phloem/protocol-types/encoding";
import { Client } from "@phloem/treasury-controller-client";
import {
  Address,
  Asset,
  Networks,
  StrKey,
  Transaction,
  TransactionBuilder,
  inspectAuthEntry,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";

import { PHLOEM_NETWORK } from "../network";
import type {
  PreparedPrivateSessionCreation,
  PrivateSessionConfirmation,
  PrivateSessionConfirmationInput,
} from "../private-session-types";
import {
  RESEARCH_CATEGORY_ID,
  loadProviderConfig,
} from "./research-provider";

export const PRIVATE_SESSION_LIFETIME_LEDGERS = 17_280;
export const PRIVATE_SESSION_CREATE_FEE_CEILING_STROOPS = 1_000_000n;

export interface ControlledProviderPrivatePublicConfig {
  readonly providerIdentity: string;
  readonly providerSppPublicKey: bigint;
  readonly providerSppEncryptionPublicKey: Buffer;
  readonly serviceIdHash: Buffer;
  readonly categoryId: number;
}

function secretBytes32(value: string | undefined, label: string): Buffer {
  if (!value || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be configured as 32-byte lowercase hexadecimal.`);
  }
  return Buffer.from(value, "hex");
}

function canonicalBytes32Hex(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be 32-byte lowercase hex`);
  }
  return value;
}

function canonicalFieldDecimal(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 78 || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError(`${label} must be a canonical decimal field`);
  }
  if (BigInt(value) >= BN254_SCALAR_MODULUS) {
    throw new TypeError(`${label} must be inside the BN254 scalar field`);
  }
  return value;
}

export function controlledProviderPublicConfigFromSecrets(input: {
  readonly providerIdentity: string;
  readonly notePrivateKeyLeHex: string;
  readonly encryptionPrivateKeyHex: string;
  readonly serviceIdHash: Uint8Array;
  readonly categoryId: number;
}): ControlledProviderPrivatePublicConfig {
  if (!StrKey.isValidEd25519PublicKey(input.providerIdentity)) {
    throw new TypeError("controlled provider identity must be a canonical G-address");
  }
  if (input.serviceIdHash.length !== 32) throw new RangeError("provider service id hash must be 32 bytes");
  if (!Number.isSafeInteger(input.categoryId) || input.categoryId < 0 || input.categoryId >= 2 ** 32) {
    throw new RangeError("provider category id must fit u32");
  }
  const notePrivateKey = secretBytes32(input.notePrivateKeyLeHex, "PROVIDER_SPP_NOTE_PRIVATE_KEY_LE_HEX");
  const encryptionPrivateKey = secretBytes32(
    input.encryptionPrivateKeyHex,
    "PROVIDER_SPP_ENCRYPTION_PRIVATE_KEY_HEX",
  );
  try {
    return Object.freeze({
      providerIdentity: input.providerIdentity,
      providerSppPublicKey: deriveSppNotePublicKey(notePrivateKey),
      providerSppEncryptionPublicKey: deriveX25519PublicKey(encryptionPrivateKey),
      serviceIdHash: Buffer.from(input.serviceIdHash),
      categoryId: input.categoryId,
    });
  } finally {
    notePrivateKey.fill(0);
    encryptionPrivateKey.fill(0);
  }
}

export function loadControlledProviderPrivatePublicConfig(): ControlledProviderPrivatePublicConfig {
  const provider = loadProviderConfig();
  if (provider.treasuryController !== PHLOEM_NETWORK.treasuryControllerId) {
    throw new Error("TREASURY_CONTROLLER_ID does not match the canonical Testnet deployment.");
  }
  return controlledProviderPublicConfigFromSecrets({
    providerIdentity: provider.signingKey.publicKey(),
    notePrivateKeyLeHex: process.env.PROVIDER_SPP_NOTE_PRIVATE_KEY_LE_HEX ?? "",
    encryptionPrivateKeyHex: process.env.PROVIDER_SPP_ENCRYPTION_PRIVATE_KEY_HEX ?? "",
    serviceIdHash: provider.serviceIdHash,
    categoryId: RESEARCH_CATEGORY_ID,
  });
}

function assertCreateSessionEnvelope(transaction: Transaction): void {
  if (transaction.source !== PHLOEM_NETWORK.companyFundingPublicKey || transaction.operations.length !== 1) {
    throw new Error("create_session preflight has an unexpected source or operation count");
  }
  const operation = transaction.operations[0];
  if (!operation || operation.type !== "invokeHostFunction" || operation.func.type !== "hostFunctionTypeInvokeContract") {
    throw new Error("create_session preflight is not one contract invocation");
  }
  const invocation = operation.func.invokeContract;
  if (
    Address.fromScAddress(invocation.contractAddress).toString() !== PHLOEM_NETWORK.treasuryControllerId
    || invocation.functionName.toString() !== "create_session"
  ) {
    throw new Error("create_session preflight targets the wrong contract function");
  }
  const operationAuth = operation.auth ?? [];
  if (operationAuth.length !== 1) throw new Error("create_session must contain exactly one company authorization");
  const auth = inspectAuthEntry(operationAuth[0]!);
  if (
    auth.credentialType !== "sourceAccount"
    || auth.address !== null
    || auth.invocation.subInvocations.length !== 0
    || auth.invocation.function.type !== "sorobanAuthorizedFunctionTypeContractFn"
  ) {
    throw new Error("create_session contains authorization beyond the source company account");
  }
  const authorized = auth.invocation.function.value;
  if (
    Address.fromScAddress(authorized.contractAddress).toString() !== PHLOEM_NETWORK.treasuryControllerId
    || authorized.functionName.toString() !== "create_session"
  ) {
    throw new Error("company authorization does not bind the canonical create_session call");
  }
}

export async function verifyPrivateSessionCreation(
  input: PrivateSessionConfirmationInput,
): Promise<PrivateSessionConfirmation> {
  const transactionHash = canonicalBytes32Hex(input.transactionHash, "transaction hash");
  const expectedSessionId = canonicalBytes32Hex(input.sessionId, "session id");
  const expectedPolicyHash = canonicalFieldDecimal(input.policyHash, "policy hash");
  const expectedProviderRoot = canonicalFieldDecimal(input.approvedProviderRoot, "provider root");
  if (!Number.isSafeInteger(input.sessionExpiry) || input.sessionExpiry < 0 || input.sessionExpiry >= 2 ** 32) {
    throw new TypeError("session expiry must fit u32");
  }
  const server = new rpc.Server(PHLOEM_NETWORK.rpcUrl);
  const final = await server.getTransaction(transactionHash);
  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error("create_session transaction is not confirmed successfully");
  }
  const parsed = TransactionBuilder.fromXDR(final.envelopeXdr, Networks.TESTNET);
  if (!(parsed instanceof Transaction)) throw new Error("create_session confirmation is not a classic transaction envelope");
  assertCreateSessionEnvelope(parsed);
  if (!final.returnValue) throw new Error("confirmed create_session did not return a session id");
  const returnedSessionId = Buffer.from(scValToNative(final.returnValue));
  if (toHex(returnedSessionId) !== expectedSessionId) throw new Error("confirmed create_session returned another session id");

  const client = new Client({
    contractId: PHLOEM_NETWORK.treasuryControllerId,
    networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
    rpcUrl: PHLOEM_NETWORK.rpcUrl,
    publicKey: PHLOEM_NETWORK.companyFundingPublicKey,
  });
  const sessionId = Buffer.from(expectedSessionId, "hex");
  const [sessionRead, policyRead] = await Promise.all([
    client.get_session({ session_id: sessionId }),
    client.get_session_policy({ session_id: sessionId }),
  ]);
  const session = sessionRead.result;
  const policy = policyRead.result;
  const provider = loadControlledProviderPrivatePublicConfig();
  const canonicalPolicy = session
    ? buildPrivateSessionPolicy({
      currentLedger: session.created_at_ledger,
      networkId: networkId(PHLOEM_NETWORK.networkPassphrase),
      treasuryController: PHLOEM_NETWORK.treasuryControllerId,
      asset: new Asset(PHLOEM_NETWORK.assetCode, PHLOEM_NETWORK.assetIssuer)
        .contractId(PHLOEM_NETWORK.networkPassphrase),
      sessionExpiry: input.sessionExpiry,
      provider,
    })
    : null;
  if (!session || !policy
    || !canonicalPolicy
    || toHex(session.id) !== expectedSessionId
    || session.company !== PHLOEM_NETWORK.companyFundingPublicKey
    || session.asset !== new Asset(PHLOEM_NETWORK.assetCode, PHLOEM_NETWORK.assetIssuer)
      .contractId(PHLOEM_NETWORK.networkPassphrase)
    || session.settlement_mode.tag !== "Private"
    || session.lifecycle.tag !== "Draft"
    || session.safety.tag !== "Normal"
    || session.created_protocol_version !== 1
    || session.policy_hash.toString() !== expectedPolicyHash
    || session.approved_provider_root.toString() !== expectedProviderRoot
    || session.expires_at_ledger !== input.sessionExpiry
    || policy.policy_hash.toString() !== expectedPolicyHash
    || policy.approved_provider_root.toString() !== expectedProviderRoot
    || policy.session_expiry !== input.sessionExpiry
    || policy.version !== canonicalPolicy.draftPolicy.version
    || policy.asset !== canonicalPolicy.draftPolicy.asset
    || policy.settlement_mode.tag !== "Private"
    || policy.category_schema_version !== canonicalPolicy.draftPolicy.category_schema_version
    || policy.max_delegation_depth !== canonicalPolicy.draftPolicy.max_delegation_depth
    || policy.allowed_actions_mask !== canonicalPolicy.draftPolicy.allowed_actions_mask
    || policy.policy_hash !== canonicalPolicy.policyHash
    || policy.approved_provider_root !== canonicalPolicy.approvedProviderRoot) {
    throw new Error("confirmed PRIVATE session state differs from the prepared policy");
  }
  return Object.freeze({
    transactionHash,
    ledger: final.ledger,
    feeChargedStroops: final.resultXdr.feeCharged.toString(),
    sessionId: expectedSessionId,
    lifecycle: "Draft" as const,
  });
}

export async function preparePrivateSessionCreation(input: {
  readonly company: string;
}): Promise<PreparedPrivateSessionCreation> {
  if (input.company !== PHLOEM_NETWORK.companyFundingPublicKey) {
    throw new Error("connected company account does not match the controlled Testnet demo wallet");
  }
  const provider = loadControlledProviderPrivatePublicConfig();
  const server = new rpc.Server(PHLOEM_NETWORK.rpcUrl);
  const latest = await server.getLatestLedger();
  const sessionExpiry = latest.sequence + PRIVATE_SESSION_LIFETIME_LEDGERS;
  if (sessionExpiry >= 2 ** 32) throw new RangeError("session expiry exceeds u32");
  const asset = new Asset(PHLOEM_NETWORK.assetCode, PHLOEM_NETWORK.assetIssuer)
    .contractId(PHLOEM_NETWORK.networkPassphrase);
  const policy = buildPrivateSessionPolicy({
    currentLedger: latest.sequence,
    networkId: networkId(PHLOEM_NETWORK.networkPassphrase),
    treasuryController: PHLOEM_NETWORK.treasuryControllerId,
    asset,
    sessionExpiry,
    provider,
  });
  const client = new Client({
    contractId: PHLOEM_NETWORK.treasuryControllerId,
    networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
    rpcUrl: PHLOEM_NETWORK.rpcUrl,
    publicKey: input.company,
  });
  const assembled = await client.create_session({
    company: input.company,
    asset,
    settlement_mode: { tag: "Private", values: undefined },
    draft_policy: policy.draftPolicy,
    expires_at: sessionExpiry,
  }, { timeoutInSeconds: 300 });
  if (!assembled.built || assembled.isReadCall || assembled.needsNonInvokerSigningBy().length !== 0) {
    throw new Error("create_session preflight did not produce the canonical company-authorized write");
  }
  assertCreateSessionEnvelope(assembled.built);
  if (BigInt(assembled.built.fee) > PRIVATE_SESSION_CREATE_FEE_CEILING_STROOPS) {
    throw new Error("create_session fee exceeds the approved P0 ceiling");
  }
  const resources = assembled.simulationData.transactionData.resources;
  return Object.freeze({
    transactionXdr: assembled.toXdr(),
    sessionId: toHex(Buffer.from(assembled.result)),
    currentLedger: latest.sequence,
    sessionExpiry,
    policyHash: policy.policyHash.toString(),
    approvedProviderRoot: policy.approvedProviderRoot.toString(),
    provider: Object.freeze({
      identity: provider.providerIdentity,
      sppPublicKey: provider.providerSppPublicKey.toString(),
      sppEncryptionPublicKeyHex: toHex(provider.providerSppEncryptionPublicKey),
      serviceIdHashHex: toHex(provider.serviceIdHash),
      categoryId: provider.categoryId,
      allowedSettlementModes: 2 as const,
    }),
    resource: Object.freeze({
      envelopeBytes: Buffer.from(assembled.toXdr(), "base64").byteLength,
      instructions: resources.instructions,
      diskReadBytes: resources.diskReadBytes,
      writeBytes: resources.writeBytes,
      readOnlyEntries: resources.footprint.readOnly.length,
      readWriteEntries: resources.footprint.readWrite.length,
      maximumFeeStroops: assembled.built.fee,
      approvedFeeCeilingStroops: PRIVATE_SESSION_CREATE_FEE_CEILING_STROOPS.toString(),
    }),
    safety: Object.freeze({
      operationCount: 1 as const,
      contractId: PHLOEM_NETWORK.treasuryControllerId,
      functionName: "create_session" as const,
      companyAuthorization: "source-account" as const,
      contractInvocation: true as const,
      assetMovement: false as const,
    }),
  });
}
