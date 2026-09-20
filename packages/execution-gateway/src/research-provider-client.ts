import {
  addressFromStrKey,
  encodeServiceOffer,
  encodeUsageEvidence,
  sha256,
  toHex,
  usageEvidenceSchema,
  serviceOfferSchema,
  utf8,
  type ServiceOffer,
  type ServiceOfferPayload,
  type UsageEvidence,
  type UsageEvidencePayload,
} from "@phloem/protocol-types";
import { Keypair } from "@stellar/stellar-sdk";
import { z } from "zod";

import type { AgentAction } from "@phloem/agent-runtime";
import type { AgentActor, ControlledProvider, ProviderServiceResult } from "./ports.js";

type ServiceAction = Extract<AgentAction, { type: "request_service" }>;
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ReservedResearchRequestContext {
  readonly reservationId: string;
  readonly offerCommitment: string;
  readonly issuedAtLedger: number;
  readonly maxItems: number;
  readonly signedServiceOffer: ServiceOffer;
}

export interface ReservedResearchContextResolver {
  resolve(action: ServiceAction, actor: AgentActor): Promise<ReservedResearchRequestContext>;
}

export interface ResearchProviderClientOptions {
  readonly endpoint: string;
  readonly context: ReservedResearchContextResolver;
  readonly fetch?: FetchLike;
  readonly requestTimeoutMs?: number;
}

const responseSchema = z.object({
  result: z.object({
    serviceId: z.literal("research-data-service"),
    requestId: z.string().regex(/^[0-9a-f]{64}$/u),
    items: z.array(z.object({
      id: z.string(),
      tags: z.array(z.string()),
      title: z.string(),
      score: z.number(),
    }).strict()).max(5),
    datasetVersion: z.literal(1),
  }).strict(),
  usageEvidence: usageEvidenceSchema,
}).strict();

function hex(value: string): Buffer {
  return Buffer.from(value, "hex");
}

function serviceOfferPayload(offer: ServiceOffer): ServiceOfferPayload {
  return {
    protocolVersion: offer.protocolVersion,
    offerVersion: offer.offerVersion,
    networkId: hex(offer.networkId),
    treasuryController: addressFromStrKey(offer.treasuryController),
    providerIdentity: addressFromStrKey(offer.providerIdentity),
    serviceIdHash: hex(offer.serviceIdHash),
    categoryId: offer.categoryId,
    asset: addressFromStrKey(offer.asset),
    pricingModel: 1,
    fixedPriceAtomic: BigInt(offer.fixedPriceAtomic),
    supportedSettlementModes: offer.supportedSettlementModes,
    validUntilLedger: offer.validUntilLedger,
    offerNonce: hex(offer.offerNonce),
  };
}

function usageEvidencePayload(evidence: UsageEvidence): UsageEvidencePayload {
  return {
    protocolVersion: evidence.protocolVersion,
    evidenceVersion: evidence.evidenceVersion,
    networkId: hex(evidence.networkId),
    treasuryController: addressFromStrKey(evidence.treasuryController),
    sessionId: hex(evidence.sessionId),
    reservationId: hex(evidence.reservationId),
    providerIdentity: addressFromStrKey(evidence.providerIdentity),
    serviceIdHash: hex(evidence.serviceIdHash),
    categoryId: evidence.categoryId,
    requestId: hex(evidence.requestId),
    requestHash: hex(evidence.requestHash),
    responseHash: hex(evidence.responseHash),
    usageUnits: BigInt(evidence.usageUnits),
    offerCommitment: BigInt(evidence.offerCommitment),
    providerSequence: BigInt(evidence.providerSequence),
    issuedAtLedger: evidence.issuedAtLedger,
    validUntilLedger: evidence.validUntilLedger,
    evidenceNonce: hex(evidence.evidenceNonce),
  };
}

function canonicalRequest(input: {
  readonly sessionId: string;
  readonly reservationId: string;
  readonly requestId: string;
  readonly query: string;
  readonly maxItems: number;
  readonly offerCommitment: string;
  readonly issuedAtLedger: number;
}): Uint8Array {
  return utf8(JSON.stringify(input));
}

function verifyControlledResponse(
  action: ServiceAction,
  context: ReservedResearchRequestContext,
  response: z.infer<typeof responseSchema>,
): void {
  const offer = serviceOfferSchema.parse(context.signedServiceOffer);
  const evidence = response.usageEvidence;
  const request = {
    sessionId: action.sessionId,
    reservationId: context.reservationId,
    requestId: action.requestId,
    query: action.query.trim(),
    maxItems: context.maxItems,
    offerCommitment: context.offerCommitment,
    issuedAtLedger: context.issuedAtLedger,
  };
  if (!Keypair.fromPublicKey(offer.providerIdentity).verify(
    encodeServiceOffer(serviceOfferPayload(offer)),
    hex(offer.providerSignature),
  )) {
    throw new Error("controlled provider ServiceOffer signature is invalid");
  }
  if (
    response.result.requestId !== action.requestId
    || evidence.sessionId !== action.sessionId
    || evidence.reservationId !== context.reservationId
    || evidence.requestId !== action.requestId
    || evidence.offerCommitment !== context.offerCommitment
    || evidence.issuedAtLedger !== context.issuedAtLedger
    || evidence.providerIdentity !== offer.providerIdentity
    || evidence.networkId !== offer.networkId
    || evidence.treasuryController !== offer.treasuryController
    || evidence.serviceIdHash !== offer.serviceIdHash
    || evidence.categoryId !== offer.categoryId
  ) {
    throw new Error("controlled provider evidence is not bound to the reserved request and signed offer");
  }
  if (evidence.requestHash !== toHex(sha256(canonicalRequest(request)))) {
    throw new Error("controlled provider evidence request hash is invalid");
  }
  if (evidence.responseHash !== toHex(sha256(utf8(JSON.stringify(response.result))))) {
    throw new Error("controlled provider evidence response hash is invalid");
  }
  if (!Keypair.fromPublicKey(evidence.providerIdentity).verify(
    encodeUsageEvidence(usageEvidencePayload(evidence)),
    hex(evidence.providerSignature),
  )) {
    throw new Error("controlled provider UsageEvidence signature is invalid");
  }
}

/** Real HTTP adapter for the single P0 controlled Research Data Service. */
export class HttpResearchDataService implements ControlledProvider {
  readonly #options: ResearchProviderClientOptions;

  constructor(options: ResearchProviderClientOptions) {
    this.#options = options;
  }

  async request(action: ServiceAction, actor: AgentActor): Promise<ProviderServiceResult> {
    const context = await this.#options.context.resolve(action, actor);
    const request = {
      sessionId: action.sessionId,
      reservationId: context.reservationId,
      requestId: action.requestId,
      query: action.query.trim(),
      maxItems: context.maxItems,
      offerCommitment: context.offerCommitment,
      issuedAtLedger: context.issuedAtLedger,
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#options.requestTimeoutMs ?? 15_000);
    try {
      const response = await (this.#options.fetch ?? fetch)(this.#options.endpoint, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`controlled provider returned HTTP ${response.status}`);
      const parsed = responseSchema.parse(await response.json());
      verifyControlledResponse(action, context, parsed);
      return Object.freeze({
        requestId: action.requestId,
        responseHash: parsed.usageEvidence.responseHash,
        signedUsageEvidence: JSON.stringify(parsed.usageEvidence),
        signedServiceOffer: JSON.stringify(context.signedServiceOffer),
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
