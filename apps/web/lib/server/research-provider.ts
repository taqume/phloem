import {
  addressFromStrKey,
  deriveId,
  encodeServiceOffer,
  encodeUsageEvidence,
  networkId,
  sha256,
  toHex,
  utf8,
  type ServiceOfferPayload,
  type UsageEvidencePayload,
} from "@phloem/protocol-types/encoding";
import { Asset, Keypair, StrKey, rpc } from "@stellar/stellar-sdk";

import { PHLOEM_NETWORK } from "../network";

export const RESEARCH_SERVICE_ID = "research-data-service";
export const RESEARCH_CATEGORY_ID = 2;
const OFFER_LIFETIME_LEDGERS = 120;
const EVIDENCE_LIFETIME_LEDGERS = 120;
const MAX_LEDGER_DRIFT = 20;
const MAX_QUERY_LENGTH = 500;
const MAX_ITEMS = 5;

const DATASET = [
  { id: "stellar-asset-contract", tags: ["asset", "sac", "usdc"], title: "Stellar Asset Contract", score: 97 },
  { id: "stellar-contract-auth", tags: ["auth", "agent", "contract"], title: "Stellar contract authorization", score: 95 },
  { id: "stellar-anchor-sep6", tags: ["anchor", "sep-6", "fiat"], title: "Anchor deposit and withdrawal", score: 93 },
  { id: "stellar-groth16", tags: ["groth16", "privacy", "zk"], title: "BN254 proof verification", score: 91 },
] as const;

export class ProviderRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface ProviderConfig {
  readonly signingKey: Keypair;
  readonly treasuryController: string;
  readonly fixedPriceAtomic: bigint;
  readonly assetContract: string;
  readonly networkId: Uint8Array;
  readonly serviceIdHash: Uint8Array;
}

export interface ResearchRequest {
  readonly sessionId: string;
  readonly reservationId: string;
  readonly requestId: string;
  readonly query: string;
  readonly maxItems: number;
  readonly offerCommitment: string;
  readonly issuedAtLedger: number;
}

function bytes32Hex(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new ProviderRequestError(`${label} must be 32-byte lowercase hex.`, 400);
  }
  return value;
}

function fieldDecimal(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new ProviderRequestError(`${label} must be an unsigned decimal field element.`, 400);
  }
  const field = BigInt(value);
  const modulus = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  if (field >= modulus) throw new ProviderRequestError(`${label} is outside the BN254 scalar field.`, 400);
  return value;
}

function unsignedInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ProviderRequestError(`${label} must be a non-negative safe integer.`, 400);
  }
  return value;
}

export function parseResearchRequest(value: unknown): ResearchRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderRequestError("Research request must be an object.", 400);
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "sessionId", "reservationId", "requestId", "query", "maxItems", "offerCommitment", "issuedAtLedger",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new ProviderRequestError(`Unknown research request field: ${key}.`, 400);
  }
  if (typeof input.query !== "string" || input.query.trim().length === 0 || input.query.length > MAX_QUERY_LENGTH) {
    throw new ProviderRequestError(`query must contain 1-${MAX_QUERY_LENGTH} characters.`, 400);
  }
  const maxItems = unsignedInteger(input.maxItems, "maxItems");
  if (maxItems < 1 || maxItems > MAX_ITEMS) {
    throw new ProviderRequestError(`maxItems must be between 1 and ${MAX_ITEMS}.`, 400);
  }
  return {
    sessionId: bytes32Hex(input.sessionId, "sessionId"),
    reservationId: bytes32Hex(input.reservationId, "reservationId"),
    requestId: bytes32Hex(input.requestId, "requestId"),
    query: input.query.trim(),
    maxItems,
    offerCommitment: fieldDecimal(input.offerCommitment, "offerCommitment"),
    issuedAtLedger: unsignedInteger(input.issuedAtLedger, "issuedAtLedger"),
  };
}

function configuredPrice(): bigint {
  const raw = process.env.PROVIDER_FIXED_PRICE_ATOMIC ?? "100000";
  if (!/^[1-9][0-9]*$/u.test(raw)) throw new Error("PROVIDER_FIXED_PRICE_ATOMIC must be a positive integer.");
  const amount = BigInt(raw);
  if (amount >= 1n << 64n) throw new Error("PROVIDER_FIXED_PRICE_ATOMIC must fit u64.");
  return amount;
}

export function loadProviderConfig(): ProviderConfig {
  const secret = process.env.PROVIDER_SIGNING_SECRET;
  if (!secret) throw new Error("PROVIDER_SIGNING_SECRET is not configured.");
  const treasuryController = process.env.TREASURY_CONTROLLER_ID;
  if (!treasuryController || !StrKey.isValidContract(treasuryController)) {
    throw new Error("TREASURY_CONTROLLER_ID is not configured as a contract address.");
  }
  const signingKey = Keypair.fromSecret(secret);
  const asset = new Asset(PHLOEM_NETWORK.assetCode, PHLOEM_NETWORK.assetIssuer);
  const assetContract = asset.contractId(PHLOEM_NETWORK.networkPassphrase);
  return {
    signingKey,
    treasuryController,
    fixedPriceAtomic: configuredPrice(),
    assetContract,
    networkId: networkId(PHLOEM_NETWORK.networkPassphrase),
    serviceIdHash: deriveId("PHLOEM_SERVICE_ID_V1", utf8(RESEARCH_SERVICE_ID)),
  };
}

export async function latestLedger(): Promise<number> {
  const response = await new rpc.Server(PHLOEM_NETWORK.rpcUrl).getLatestLedger();
  return response.sequence;
}

export function signedOffer(config: ProviderConfig, currentLedger: number) {
  const validUntilLedger = currentLedger + OFFER_LIFETIME_LEDGERS;
  const offerNonce = deriveId(
    "PHLOEM_OFFER_NONCE_V1",
    utf8(`${config.signingKey.publicKey()}:${currentLedger}:${config.fixedPriceAtomic}`),
  );
  const payload: ServiceOfferPayload = {
    protocolVersion: 1,
    offerVersion: 1,
    networkId: config.networkId,
    treasuryController: addressFromStrKey(config.treasuryController),
    providerIdentity: addressFromStrKey(config.signingKey.publicKey()),
    serviceIdHash: config.serviceIdHash,
    categoryId: RESEARCH_CATEGORY_ID,
    asset: addressFromStrKey(config.assetContract),
    pricingModel: 1,
    fixedPriceAtomic: config.fixedPriceAtomic,
    supportedSettlementModes: 3,
    validUntilLedger,
    offerNonce,
  };
  const signingBytes = encodeServiceOffer(payload);
  return {
    protocolVersion: 1,
    offerVersion: 1,
    networkId: toHex(config.networkId),
    treasuryController: config.treasuryController,
    providerIdentity: config.signingKey.publicKey(),
    serviceIdHash: toHex(config.serviceIdHash),
    categoryId: RESEARCH_CATEGORY_ID,
    asset: config.assetContract,
    pricingModel: "FIXED_REQUEST" as const,
    fixedPriceAtomic: config.fixedPriceAtomic.toString(),
    supportedSettlementModes: 3,
    validUntilLedger,
    offerNonce: toHex(offerNonce),
    providerSignature: toHex(config.signingKey.sign(signingBytes)),
  };
}

function canonicalResearchRequest(input: ResearchRequest): Uint8Array {
  return utf8(JSON.stringify({
    sessionId: input.sessionId,
    reservationId: input.reservationId,
    requestId: input.requestId,
    query: input.query,
    maxItems: input.maxItems,
    offerCommitment: input.offerCommitment,
    issuedAtLedger: input.issuedAtLedger,
  }));
}

function researchItems(query: string, maxItems: number) {
  const terms = new Set(query.toLocaleLowerCase("en-US").split(/[^a-z0-9-]+/u).filter(Boolean));
  return DATASET
    .map((item) => ({
      ...item,
      matches: item.tags.reduce((total, tag) => total + (terms.has(tag) ? 1 : 0), 0),
    }))
    .toSorted((left, right) => right.matches - left.matches || right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, maxItems)
    .map(({ matches: _matches, ...item }) => item);
}

export function executeResearch(config: ProviderConfig, value: unknown, currentLedger: number) {
  const input = parseResearchRequest(value);
  if (input.issuedAtLedger > currentLedger || currentLedger - input.issuedAtLedger > MAX_LEDGER_DRIFT) {
    throw new ProviderRequestError("issuedAtLedger is outside the accepted live-ledger window.", 409);
  }
  const result = {
    serviceId: RESEARCH_SERVICE_ID,
    requestId: input.requestId,
    items: researchItems(input.query, input.maxItems),
    datasetVersion: 1,
  };
  const requestHash = sha256(canonicalResearchRequest(input));
  const responseHash = sha256(utf8(JSON.stringify(result)));
  const evidenceNonce = deriveId(
    "PHLOEM_EVIDENCE_NONCE_V1",
    sha256(Uint8Array.from(Buffer.from(input.requestId, "hex")), requestHash, responseHash),
  );
  const evidencePayload: UsageEvidencePayload = {
    protocolVersion: 1,
    evidenceVersion: 1,
    networkId: config.networkId,
    treasuryController: addressFromStrKey(config.treasuryController),
    sessionId: Uint8Array.from(Buffer.from(input.sessionId, "hex")),
    reservationId: Uint8Array.from(Buffer.from(input.reservationId, "hex")),
    providerIdentity: addressFromStrKey(config.signingKey.publicKey()),
    serviceIdHash: config.serviceIdHash,
    categoryId: RESEARCH_CATEGORY_ID,
    requestId: Uint8Array.from(Buffer.from(input.requestId, "hex")),
    requestHash,
    responseHash,
    usageUnits: 1n,
    offerCommitment: BigInt(input.offerCommitment),
    providerSequence: 1n,
    issuedAtLedger: input.issuedAtLedger,
    validUntilLedger: input.issuedAtLedger + EVIDENCE_LIFETIME_LEDGERS,
    evidenceNonce,
  };
  const signingBytes = encodeUsageEvidence(evidencePayload);
  const usageEvidence = {
    protocolVersion: 1,
    evidenceVersion: 1,
    networkId: toHex(config.networkId),
    treasuryController: config.treasuryController,
    sessionId: input.sessionId,
    reservationId: input.reservationId,
    providerIdentity: config.signingKey.publicKey(),
    serviceIdHash: toHex(config.serviceIdHash),
    categoryId: RESEARCH_CATEGORY_ID,
    requestId: input.requestId,
    requestHash: toHex(requestHash),
    responseHash: toHex(responseHash),
    usageUnits: "1",
    offerCommitment: input.offerCommitment,
    providerSequence: "1",
    issuedAtLedger: input.issuedAtLedger,
    validUntilLedger: input.issuedAtLedger + EVIDENCE_LIFETIME_LEDGERS,
    evidenceNonce: toHex(evidenceNonce),
    providerSignature: toHex(config.signingKey.sign(signingBytes)),
  };
  return { result, usageEvidence };
}
