import {
  BN254_SCALAR_MODULUS,
  addressFromStrKey,
  fieldToBytes,
  providerPolicyLeaf,
  sessionPolicyHash,
} from "@phloem/protocol-types/encoding";
import type { SessionPolicy } from "@phloem/treasury-controller-client";
import { StrKey } from "@stellar/stellar-sdk";

export const PRIVATE_SESSION_POLICY_VERSION = 1;
export const PRIVATE_CATEGORY_SCHEMA_VERSION = 1;
export const PRIVATE_MAX_DELEGATION_DEPTH = 3;
export const PRIVATE_ALLOWED_ACTIONS_MASK = 0b111n;
export const PRIVATE_SETTLEMENT_MODE_MASK = 2;

export interface ControlledProviderSessionPolicyInput {
  readonly providerIdentity: string;
  readonly providerSppPublicKey: bigint;
  readonly serviceIdHash: Uint8Array;
  readonly categoryId: number;
}

export interface BuildPrivateSessionPolicyInput {
  readonly currentLedger: number;
  readonly networkId: Uint8Array;
  readonly treasuryController: string;
  readonly asset: string;
  readonly sessionExpiry: number;
  readonly provider: ControlledProviderSessionPolicyInput;
}

export interface PreparedPrivateSessionPolicy {
  readonly approvedProviderRoot: bigint;
  readonly policyHash: bigint;
  readonly draftPolicy: SessionPolicy;
  readonly provider: Readonly<ControlledProviderSessionPolicyInput & { readonly allowedSettlementModes: 2 }>;
}

function checkedU32(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** 32) {
    throw new RangeError(`${label} must fit u32`);
  }
  return value;
}

export function buildPrivateSessionPolicy(input: BuildPrivateSessionPolicyInput): PreparedPrivateSessionPolicy {
  const currentLedger = checkedU32(input.currentLedger, "current ledger");
  const sessionExpiry = checkedU32(input.sessionExpiry, "session expiry");
  if (sessionExpiry <= currentLedger) throw new RangeError("session expiry must be after the current ledger");
  if (input.networkId.length !== 32) throw new RangeError("network id must be exactly 32 bytes");
  if (!StrKey.isValidContract(input.treasuryController) || !StrKey.isValidContract(input.asset)) {
    throw new TypeError("controller and asset must be canonical C-addresses");
  }
  if (!StrKey.isValidEd25519PublicKey(input.provider.providerIdentity)) {
    throw new TypeError("controlled provider identity must be a canonical G-address");
  }
  if (input.provider.serviceIdHash.length !== 32) throw new RangeError("service id hash must be exactly 32 bytes");
  const categoryId = checkedU32(input.provider.categoryId, "provider category id");
  if (input.provider.providerSppPublicKey <= 0n || input.provider.providerSppPublicKey >= BN254_SCALAR_MODULUS) {
    throw new RangeError("provider SPP public key must be a non-zero canonical BN254 field");
  }
  fieldToBytes(input.provider.providerSppPublicKey);

  const provider = Object.freeze({
    ...input.provider,
    categoryId,
    allowedSettlementModes: PRIVATE_SETTLEMENT_MODE_MASK as 2,
  });
  const approvedProviderRoot = providerPolicyLeaf({
    version: PRIVATE_SESSION_POLICY_VERSION,
    providerIdentity: addressFromStrKey(provider.providerIdentity),
    providerSppPublicKey: provider.providerSppPublicKey,
    serviceIdHash: provider.serviceIdHash,
    categoryId: provider.categoryId,
    allowedSettlementModes: provider.allowedSettlementModes,
  });
  const policyHash = sessionPolicyHash({
    version: PRIVATE_SESSION_POLICY_VERSION,
    networkId: input.networkId,
    treasuryController: addressFromStrKey(input.treasuryController),
    asset: addressFromStrKey(input.asset),
    settlementMode: PRIVATE_SETTLEMENT_MODE_MASK,
    approvedProviderRoot,
    categorySchemaVersion: PRIVATE_CATEGORY_SCHEMA_VERSION,
    maxDelegationDepth: PRIVATE_MAX_DELEGATION_DEPTH,
    allowedActionsMask: PRIVATE_ALLOWED_ACTIONS_MASK,
    sessionExpiry,
  });
  const draftPolicy: SessionPolicy = {
    version: PRIVATE_SESSION_POLICY_VERSION,
    asset: input.asset,
    settlement_mode: { tag: "Private", values: undefined },
    approved_provider_root: approvedProviderRoot,
    category_schema_version: PRIVATE_CATEGORY_SCHEMA_VERSION,
    max_delegation_depth: PRIVATE_MAX_DELEGATION_DEPTH,
    allowed_actions_mask: PRIVATE_ALLOWED_ACTIONS_MASK,
    session_expiry: sessionExpiry,
    policy_hash: policyHash,
  };
  return Object.freeze({ approvedProviderRoot, policyHash, draftPolicy: Object.freeze(draftPolicy), provider });
}
