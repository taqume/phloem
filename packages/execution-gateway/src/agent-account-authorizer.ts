import { createHash } from "node:crypto";

import type { AgentDigestSignature, PublicAgentIdentity } from "@phloem/privacy-runtime/agent-identities";
import {
  Address,
  Operation,
  Transaction,
  TransactionBuilder,
  authorizeEntry,
  inspectAuthEntry,
  xdr,
} from "@stellar/stellar-sdk";

import type { AgentAuthorizer, PreparedContractInvocation } from "./ports.js";

export interface AgentAccountSigningAuthority {
  resolveContract(contractId: string): Promise<PublicAgentIdentity>;
  signForContract(contractId: string, digest: Uint8Array): Promise<AgentDigestSignature>;
}

export interface AgentAccountAuthorizerOptions {
  readonly networkPassphrase: string;
  readonly treasuryControllerId: string;
  readonly ed25519VerifierId: string;
  readonly latestLedger: () => Promise<number>;
  readonly authority: AgentAccountSigningAuthority;
  readonly authorizationLifetimeLedgers?: number;
}

interface SerializedAssembledTransaction {
  readonly method: string;
  readonly tx: string;
}

function parseAssembledTransaction(value: string): SerializedAssembledTransaction {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object") throw new TypeError("assembled transaction must be a JSON object");
  const record = parsed as Record<string, unknown>;
  if (typeof record.method !== "string" || typeof record.tx !== "string") {
    throw new TypeError("assembled transaction JSON is missing its method or XDR");
  }
  return { method: record.method, tx: record.tx };
}

function contextRuleIdsScVal(count: number): xdr.ScVal {
  if (!Number.isSafeInteger(count) || count < 1) throw new RangeError("agent authorization needs at least one context");
  return xdr.ScVal.scvVec(Array.from({ length: count }, () => xdr.ScVal.scvU32(0)));
}

export function encodeAgentAccountAuthPayload(input: {
  readonly ed25519VerifierId: string;
  readonly publicKey: Uint8Array;
  readonly signature: Uint8Array;
  readonly contextCount: number;
}): xdr.ScVal {
  if (input.publicKey.length !== 32) throw new RangeError("agent public key must be exactly 32 bytes");
  if (input.signature.length !== 64) throw new RangeError("agent signature must be exactly 64 bytes");
  const signer = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    new Address(input.ed25519VerifierId).toScVal(),
    xdr.ScVal.scvBytes(Buffer.from(input.publicKey)),
  ]);
  const signers = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: signer, val: xdr.ScVal.scvBytes(Buffer.from(input.signature)) }),
  ]);
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("context_rule_ids"), val: contextRuleIdsScVal(input.contextCount) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("signers"), val: signers }),
  ]);
}

export function agentAccountSigningDigest(signaturePayload: Uint8Array, contextCount: number): Buffer {
  if (signaturePayload.length !== 32) throw new RangeError("Soroban signature payload must be exactly 32 bytes");
  return createHash("sha256")
    .update(signaturePayload)
    .update(contextRuleIdsScVal(contextCount).toXDR())
    .digest();
}

function assertCanonicalInvocation(
  transaction: Transaction,
  method: string,
  requiredAuthorizer: PreparedContractInvocation["requiredAuthorizer"],
  treasuryControllerId: string,
): { operation: Extract<Transaction["operations"][number], { type: "invokeHostFunction" }>; authIndexes: number[] } {
  if (transaction.operations.length !== 1) throw new Error("agent transaction must contain exactly one operation");
  const operation = transaction.operations[0];
  if (!operation || operation.type !== "invokeHostFunction" || operation.func.type !== "hostFunctionTypeInvokeContract") {
    throw new Error("agent transaction must contain one invokeContract host function");
  }
  const invocation = operation.func.invokeContract;
  if (
    Address.fromScAddress(invocation.contractAddress).toString() !== treasuryControllerId
    || invocation.functionName.toString() !== method
  ) {
    throw new Error("agent transaction targets a non-canonical controller invocation");
  }
  const authIndexes: number[] = [];
  for (const [index, entry] of (operation.auth ?? []).entries()) {
    const inspected = inspectAuthEntry(entry);
    if (inspected.address === requiredAuthorizer.identity) {
      if (inspected.credentialType === "sourceAccount") {
        throw new Error("agent smart account authorization cannot use source-account credentials");
      }
      if (inspected.invocation.subInvocations.length !== 0) {
        throw new Error("P0 agent authorization cannot cover nested invocation contexts");
      }
      authIndexes.push(index);
    }
  }
  if (authIndexes.length !== 1) throw new Error("agent transaction must contain one exact smart-account authorization entry");
  return { operation, authIndexes };
}

export class StellarAgentAccountAuthorizer implements AgentAuthorizer {
  readonly #options: AgentAccountAuthorizerOptions;

  constructor(options: AgentAccountAuthorizerOptions) {
    this.#options = options;
  }

  async authorize(
    assembledTransactionJson: string,
    authorizer: PreparedContractInvocation["requiredAuthorizer"],
  ): Promise<string> {
    const serialized = parseAssembledTransaction(assembledTransactionJson);
    const parsed = TransactionBuilder.fromXDR(serialized.tx, this.#options.networkPassphrase);
    if (!(parsed instanceof Transaction)) throw new Error("agent authorization requires a classic transaction envelope");
    const { operation, authIndexes } = assertCanonicalInvocation(
      parsed,
      serialized.method,
      authorizer,
      this.#options.treasuryControllerId,
    );
    const identity = await this.#options.authority.resolveContract(authorizer.identity);
    const latestLedger = await this.#options.latestLedger();
    if (latestLedger >= identity.validUntilLedger) throw new Error("agent identity has expired");
    const requestedExpiry = latestLedger + (this.#options.authorizationLifetimeLedgers ?? 100);
    const signatureExpiry = Math.min(requestedExpiry, identity.validUntilLedger);
    if (signatureExpiry <= latestLedger) throw new Error("agent authorization expiry is not in the future");

    const auth = [...(operation.auth ?? [])];
    for (const index of authIndexes) {
      const unsigned = auth[index]!;
      auth[index] = await authorizeEntry(
        unsigned,
        async (_preimage, signaturePayload) => {
          const digest = agentAccountSigningDigest(signaturePayload, 1);
          const signed = await this.#options.authority.signForContract(authorizer.identity, digest);
          if (signed.publicKeyHex !== identity.publicKeyHex) {
            throw new Error("agent signing authority returned another public key");
          }
          return {
            signatureScVal: encodeAgentAccountAuthPayload({
              ed25519VerifierId: this.#options.ed25519VerifierId,
              publicKey: Buffer.from(signed.publicKeyHex, "hex"),
              signature: signed.signature,
              contextCount: 1,
            }),
          };
        },
        signatureExpiry,
        this.#options.networkPassphrase,
        authorizer.identity,
      );
    }

    const replacement = Operation.invokeHostFunction({
      ...(operation.source ? { source: operation.source } : {}),
      func: operation.func,
      auth,
    });
    const rebuilt = TransactionBuilder.cloneFrom(parsed)
      .clearOperations()
      .addOperation(replacement)
      .build();
    return rebuilt.toEnvelope().toXDR("base64");
  }
}
