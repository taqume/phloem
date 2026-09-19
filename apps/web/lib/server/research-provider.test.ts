import assert from "node:assert/strict";
import test from "node:test";

import {
  addressFromStrKey,
  deriveId,
  encodeServiceOffer,
  encodeUsageEvidence,
  networkId,
  sha256,
  utf8,
  type ServiceOfferPayload,
  type UsageEvidencePayload,
} from "@phloem/protocol-types/encoding";
import { serviceOfferSchema, usageEvidenceSchema } from "@phloem/protocol-types/schemas";
import { Keypair } from "@stellar/stellar-sdk";

import {
  ProviderRequestError,
  executeResearch,
  signedOffer,
  type ProviderConfig,
} from "./research-provider";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

function hex(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "hex"));
}

function fixture(): ProviderConfig {
  return {
    signingKey: Keypair.fromRawEd25519Seed(sha256(utf8("PHLOEM_NON_SECRET_TEST_KEY:research-provider"))),
    treasuryController: "CB23C2OYMIDYC7OG2PK6NJFIVCYONYV43ABREOGVTW2LT4C2G53G2CWU",
    fixedPriceAtomic: 100_000n,
    assetContract: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    networkId: networkId(TESTNET_PASSPHRASE),
    serviceIdHash: deriveId("PHLOEM_SERVICE_ID_V1", utf8("research-data-service")),
  };
}

test("controlled provider returns a canonical signed ServiceOffer", () => {
  const config = fixture();
  const offer = signedOffer(config, 5_000_000);
  assert.equal(serviceOfferSchema.safeParse(offer).success, true);

  const payload: ServiceOfferPayload = {
    protocolVersion: 1,
    offerVersion: 1,
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
  assert.equal(
    config.signingKey.verify(encodeServiceOffer(payload), hex(offer.providerSignature)),
    true,
  );
});

test("research response is deterministic and carries signed UsageEvidence", () => {
  const config = fixture();
  const request = {
    sessionId: "11".repeat(32),
    reservationId: "22".repeat(32),
    requestId: "33".repeat(32),
    query: "Stellar anchor USDC",
    maxItems: 2,
    offerCommitment: "17",
    issuedAtLedger: 5_000_000,
  };
  const first = executeResearch(config, request, 5_000_005);
  const second = executeResearch(config, request, 5_000_005);
  assert.deepEqual(first, second);
  assert.equal(first.result.items.length, 2);
  assert.equal(usageEvidenceSchema.safeParse(first.usageEvidence).success, true);

  const evidence = first.usageEvidence;
  const payload: UsageEvidencePayload = {
    protocolVersion: 1,
    evidenceVersion: 1,
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
  assert.equal(
    config.signingKey.verify(encodeUsageEvidence(payload), hex(evidence.providerSignature)),
    true,
  );
});

test("research endpoint rejects stale ledgers and unknown fields", () => {
  const config = fixture();
  const request = {
    sessionId: "11".repeat(32),
    reservationId: "22".repeat(32),
    requestId: "33".repeat(32),
    query: "Stellar",
    maxItems: 1,
    offerCommitment: "17",
    issuedAtLedger: 100,
  };

  assert.throws(
    () => executeResearch(config, request, 121),
    (error: unknown) => error instanceof ProviderRequestError && error.status === 409,
  );
  assert.throws(
    () => executeResearch(config, { ...request, issuedAtLedger: 120, extra: true }, 120),
    (error: unknown) => error instanceof ProviderRequestError && error.status === 400,
  );
});
