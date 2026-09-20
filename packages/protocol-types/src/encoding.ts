import { createHash } from "node:crypto";

import { StrKey } from "@stellar/stellar-sdk";
import { bn254 } from "@taceo/poseidon2";

export const BN254_SCALAR_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const SIGNING_DOMAINS = {
  serviceOffer: "PHLOEM_SERVICE_OFFER_V1",
  usageEvidence: "PHLOEM_USAGE_EVIDENCE_V1",
  privateVoucher: "PHLOEM_PRIVATE_VOUCHER_V1",
} as const;

export const POSEIDON_DOMAINS = {
  contextInit: 0x50484c4d43545831n,
  contextFold: 0x50484c4d43545832n,
  sessionPolicyInit: 0x50484c4d504f4c31n,
  sessionPolicyFold: 0x50484c4d504f4c32n,
  budgetNote: 0x50484c4d42554431n,
  providerInit: 0x50484c4d50525631n,
  providerFold: 0x50484c4d50525632n,
  offerInit: 0x50484c4d4f464631n,
  offerFold: 0x50484c4d4f464632n,
  reservation: 0x50484c4d52535631n,
  voucherAmount: 0x50484c4d564f5531n,
  auditContextInit: 0x50484c4d41554331n,
  auditContextFold: 0x50484c4d41554332n,
  auditTotal: 0x50484c4d41554431n,
  sppTreasuryKey: 0x50484c4d53544b31n,
  merkleLeaf: 0x50484c4d4c463031n,
  sppNote: 1n,
} as const;

export type Bytes32 = Uint8Array;

export interface CanonicalAddress {
  readonly kind: 0 | 1;
  readonly payload: Bytes32;
}

export interface ServiceOfferPayload {
  readonly protocolVersion: number;
  readonly offerVersion: number;
  readonly networkId: Bytes32;
  readonly treasuryController: CanonicalAddress;
  readonly providerIdentity: CanonicalAddress;
  readonly serviceIdHash: Bytes32;
  readonly categoryId: number;
  readonly asset: CanonicalAddress;
  readonly pricingModel: 1;
  readonly fixedPriceAtomic: bigint;
  readonly supportedSettlementModes: number;
  readonly validUntilLedger: number;
  readonly offerNonce: Bytes32;
}

export interface UsageEvidencePayload {
  readonly protocolVersion: number;
  readonly evidenceVersion: number;
  readonly networkId: Bytes32;
  readonly treasuryController: CanonicalAddress;
  readonly sessionId: Bytes32;
  readonly reservationId: Bytes32;
  readonly providerIdentity: CanonicalAddress;
  readonly serviceIdHash: Bytes32;
  readonly categoryId: number;
  readonly requestId: Bytes32;
  readonly requestHash: Bytes32;
  readonly responseHash: Bytes32;
  readonly usageUnits: bigint;
  readonly offerCommitment: bigint;
  readonly providerSequence: bigint;
  readonly issuedAtLedger: number;
  readonly validUntilLedger: number;
  readonly evidenceNonce: Bytes32;
}

export interface PrivateVoucherPayload {
  readonly protocolVersion: number;
  readonly voucherVersion: number;
  readonly networkId: Bytes32;
  readonly treasuryController: CanonicalAddress;
  readonly sessionId: Bytes32;
  readonly reservationId: Bytes32;
  readonly sequence: bigint;
  readonly cumulativeAmountCommitment: bigint;
  readonly usageRoot: bigint;
  readonly offerCommitment: bigint;
  readonly expiryLedger: number;
}

export interface AuditContextInput {
  readonly protocolVersion: number;
  readonly networkId: Bytes32;
  readonly treasuryController: CanonicalAddress;
  readonly sessionId: Bytes32;
  readonly asset: CanonicalAddress;
  readonly settlementMode: 1 | 2;
  readonly policyHash: bigint;
}

export interface SessionPolicyHashInput {
  readonly version: number;
  readonly networkId: Bytes32;
  readonly treasuryController: CanonicalAddress;
  readonly asset: CanonicalAddress;
  readonly settlementMode: 1 | 2;
  readonly approvedProviderRoot: bigint;
  readonly categorySchemaVersion: number;
  readonly maxDelegationDepth: number;
  readonly allowedActionsMask: bigint;
  readonly sessionExpiry: number;
}

export interface ProviderPolicyLeafInput {
  readonly version: number;
  readonly providerIdentity: CanonicalAddress;
  readonly providerSppPublicKey: bigint;
  readonly serviceIdHash: Bytes32;
  readonly categoryId: number;
  readonly allowedSettlementModes: number;
}

function checkedUnsigned(value: number | bigint, bits: number, label: string): bigint {
  const normalized = BigInt(value);
  const limit = 1n << BigInt(bits);
  if (normalized < 0n || normalized >= limit) {
    throw new RangeError(`${label} must fit u${bits}`);
  }
  return normalized;
}

function integerBytes(value: number | bigint, byteLength: number, label: string): Uint8Array {
  let remaining = checkedUnsigned(value, byteLength * 8, label);
  const output = new Uint8Array(byteLength);
  for (let index = byteLength - 1; index >= 0; index -= 1) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return output;
}

export const u8be = (value: number, label = "value"): Uint8Array => integerBytes(value, 1, label);
export const u16be = (value: number, label = "value"): Uint8Array => integerBytes(value, 2, label);
export const u32be = (value: number, label = "value"): Uint8Array => integerBytes(value, 4, label);
export const u64be = (value: bigint, label = "value"): Uint8Array => integerBytes(value, 8, label);

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function assertBytes(value: Uint8Array, length: number, label: string): void {
  if (value.length !== length) {
    throw new RangeError(`${label} must be ${length} bytes, received ${value.length}`);
  }
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let output = 0n;
  for (const byte of bytes) output = (output << 8n) | BigInt(byte);
  return output;
}

export function bigIntToBytes(value: bigint, length: number): Uint8Array {
  return integerBytes(value, length, "integer");
}

export function bytes32ToLimbs(value: Bytes32): readonly [bigint, bigint] {
  assertBytes(value, 32, "Bytes32");
  return [bytesToBigInt(value.subarray(0, 16)), bytesToBigInt(value.subarray(16, 32))];
}

export function fieldToBytes(value: bigint): Uint8Array {
  if (value < 0n || value >= BN254_SCALAR_MODULUS) {
    throw new RangeError("field element is not canonical BN254 Fr");
  }
  return bigIntToBytes(value, 32);
}

export function sha256(...parts: readonly Uint8Array[]): Bytes32 {
  const digest = createHash("sha256");
  for (const part of parts) digest.update(part);
  return new Uint8Array(digest.digest());
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function networkId(passphrase: string): Bytes32 {
  return sha256(utf8(passphrase));
}

export function deriveId(domain: string, preimage: Uint8Array): Bytes32 {
  const domainBytes = utf8(domain);
  return sha256(u16be(domainBytes.length, "domain length"), domainBytes, u32be(preimage.length, "preimage length"), preimage);
}

export function addressFromStrKey(value: string): CanonicalAddress {
  if (StrKey.isValidEd25519PublicKey(value)) {
    return { kind: 0, payload: new Uint8Array(StrKey.decodeEd25519PublicKey(value)) };
  }
  if (StrKey.isValidContract(value)) {
    return { kind: 1, payload: new Uint8Array(StrKey.decodeContract(value)) };
  }
  throw new TypeError("only canonical G-addresses and C-addresses are supported");
}

export function encodeAddress(value: CanonicalAddress): Uint8Array {
  assertBytes(value.payload, 32, "address payload");
  return concatBytes(u8be(value.kind, "address kind"), value.payload);
}

export function addressFields(value: CanonicalAddress): readonly [bigint, bigint, bigint] {
  const [hi, lo] = bytes32ToLimbs(value.payload);
  return [BigInt(value.kind), hi, lo];
}

export function poseidon2Hash3(a: bigint, b: bigint, c: bigint, domain: bigint): bigint {
  for (const [label, value] of [["a", a], ["b", b], ["c", c], ["domain", domain]] as const) {
    if (value < 0n || value >= BN254_SCALAR_MODULUS) throw new RangeError(`${label} is not a field element`);
  }
  return bn254.t4.permutation([a, b, c, domain])[0]!;
}

/** Matches the upstream SPP Poseidon2 t=3 construction. */
export function poseidon2Hash2(a: bigint, b: bigint, domain: bigint): bigint {
  for (const [label, value] of [["a", a], ["b", b], ["domain", domain]] as const) {
    if (value < 0n || value >= BN254_SCALAR_MODULUS) throw new RangeError(`${label} is not a field element`);
  }
  return bn254.t3.permutation([a, b, domain])[0]!;
}

export function poseidon2HashFields(
  fields: readonly bigint[],
  initDomain: bigint,
  foldDomain: bigint,
): bigint {
  if (fields.length < 2) throw new RangeError("hashFields requires at least two fields");
  let accumulator = poseidon2Hash3(BigInt(fields.length), fields[0]!, fields[1]!, initDomain);
  for (let index = 2; index < fields.length; index += 1) {
    accumulator = poseidon2Hash3(accumulator, BigInt(index), fields[index]!, foldDomain);
  }
  return accumulator;
}

export function auditContextFields(value: AuditContextInput): readonly bigint[] {
  assertBytes(value.networkId, 32, "networkId");
  assertBytes(value.sessionId, 32, "sessionId");
  fieldToBytes(value.policyHash);
  const [networkHi, networkLo] = bytes32ToLimbs(value.networkId);
  const [sessionHi, sessionLo] = bytes32ToLimbs(value.sessionId);
  return [
    checkedUnsigned(value.protocolVersion, 32, "protocolVersion"),
    networkHi,
    networkLo,
    ...addressFields(value.treasuryController),
    sessionHi,
    sessionLo,
    ...addressFields(value.asset),
    checkedUnsigned(value.settlementMode, 32, "settlementMode"),
    value.policyHash,
  ];
}

export function auditContextHash(value: AuditContextInput): bigint {
  return poseidon2HashFields(
    auditContextFields(value),
    POSEIDON_DOMAINS.auditContextInit,
    POSEIDON_DOMAINS.auditContextFold,
  );
}

export function sessionPolicyHash(value: SessionPolicyHashInput): bigint {
  assertBytes(value.networkId, 32, "networkId");
  const fields = [
    checkedUnsigned(value.version, 32, "policy version"),
    ...bytes32ToLimbs(value.networkId),
    ...addressFields(value.treasuryController),
    ...addressFields(value.asset),
    checkedUnsigned(value.settlementMode, 32, "settlement mode"),
    value.approvedProviderRoot,
    checkedUnsigned(value.categorySchemaVersion, 32, "category schema version"),
    checkedUnsigned(value.maxDelegationDepth, 32, "max delegation depth"),
    checkedUnsigned(value.allowedActionsMask, 64, "allowed actions mask"),
    checkedUnsigned(value.sessionExpiry, 32, "session expiry"),
  ];
  return poseidon2HashFields(
    fields,
    POSEIDON_DOMAINS.sessionPolicyInit,
    POSEIDON_DOMAINS.sessionPolicyFold,
  );
}

export function providerPolicyLeaf(value: ProviderPolicyLeafInput): bigint {
  assertBytes(value.serviceIdHash, 32, "serviceIdHash");
  return poseidon2HashFields([
    checkedUnsigned(value.version, 32, "provider leaf version"),
    ...addressFields(value.providerIdentity),
    value.providerSppPublicKey,
    ...bytes32ToLimbs(value.serviceIdHash),
    checkedUnsigned(value.categoryId, 32, "category id"),
    checkedUnsigned(value.allowedSettlementModes, 32, "allowed settlement modes"),
  ], POSEIDON_DOMAINS.providerInit, POSEIDON_DOMAINS.providerFold);
}

export function poseidon2Compress(left: bigint, right: bigint): bigint {
  const permutation = bn254.t2.permutation([left, right]);
  return (permutation[0]! + left) % BN254_SCALAR_MODULUS;
}

export function signingEnvelope(domain: string, body: Uint8Array): Uint8Array {
  const domainBytes = utf8(domain);
  return concatBytes(u16be(domainBytes.length, "domain length"), domainBytes, u32be(body.length, "body length"), body);
}

export function encodeServiceOffer(value: ServiceOfferPayload): Uint8Array {
  assertBytes(value.networkId, 32, "networkId");
  assertBytes(value.serviceIdHash, 32, "serviceIdHash");
  assertBytes(value.offerNonce, 32, "offerNonce");
  const body = concatBytes(
    u32be(value.protocolVersion, "protocolVersion"),
    u32be(value.offerVersion, "offerVersion"),
    value.networkId,
    encodeAddress(value.treasuryController),
    encodeAddress(value.providerIdentity),
    value.serviceIdHash,
    u32be(value.categoryId, "categoryId"),
    encodeAddress(value.asset),
    u8be(value.pricingModel, "pricingModel"),
    u64be(value.fixedPriceAtomic, "fixedPriceAtomic"),
    u8be(value.supportedSettlementModes, "supportedSettlementModes"),
    u32be(value.validUntilLedger, "validUntilLedger"),
    value.offerNonce,
  );
  return signingEnvelope(SIGNING_DOMAINS.serviceOffer, body);
}

export function encodeUsageEvidence(value: UsageEvidencePayload): Uint8Array {
  for (const [label, bytes] of [
    ["networkId", value.networkId], ["sessionId", value.sessionId], ["reservationId", value.reservationId],
    ["serviceIdHash", value.serviceIdHash], ["requestId", value.requestId], ["requestHash", value.requestHash],
    ["responseHash", value.responseHash], ["evidenceNonce", value.evidenceNonce],
  ] as const) assertBytes(bytes, 32, label);
  const body = concatBytes(
    u32be(value.protocolVersion), u32be(value.evidenceVersion), value.networkId,
    encodeAddress(value.treasuryController), value.sessionId, value.reservationId,
    encodeAddress(value.providerIdentity), value.serviceIdHash, u32be(value.categoryId),
    value.requestId, value.requestHash, value.responseHash, u64be(value.usageUnits),
    fieldToBytes(value.offerCommitment), u64be(value.providerSequence),
    u32be(value.issuedAtLedger), u32be(value.validUntilLedger), value.evidenceNonce,
  );
  return signingEnvelope(SIGNING_DOMAINS.usageEvidence, body);
}

export function encodePrivateVoucher(value: PrivateVoucherPayload): Uint8Array {
  for (const [label, bytes] of [
    ["networkId", value.networkId], ["sessionId", value.sessionId], ["reservationId", value.reservationId],
  ] as const) assertBytes(bytes, 32, label);
  const body = concatBytes(
    u32be(value.protocolVersion), u32be(value.voucherVersion), value.networkId,
    encodeAddress(value.treasuryController), value.sessionId, value.reservationId,
    u64be(value.sequence), fieldToBytes(value.cumulativeAmountCommitment),
    fieldToBytes(value.usageRoot), fieldToBytes(value.offerCommitment), u32be(value.expiryLedger),
  );
  return signingEnvelope(SIGNING_DOMAINS.privateVoucher, body);
}

export function toHex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}
