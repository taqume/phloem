import { Keypair } from "@stellar/stellar-sdk";

import {
  POSEIDON_DOMAINS,
  addressFields,
  addressFromStrKey,
  bytes32ToLimbs,
  bytesToBigInt,
  deriveId,
  encodeAddress,
  encodePrivateVoucher,
  encodeServiceOffer,
  encodeUsageEvidence,
  fieldToBytes,
  networkId,
  poseidon2Hash3,
  poseidon2HashFields,
  sha256,
  toHex,
  utf8,
  type PrivateVoucherPayload,
  type ServiceOfferPayload,
  type UsageEvidencePayload,
} from "./encoding.js";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const CONTROLLER = "CB23C2OYMIDYC7OG2PK6NJFIVCYONYV43ABREOGVTW2LT4C2G53G2CWU";
const ASSET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const AGENT_OWNER = "CB2P6OWRQTMIDLN2XSD4PYSRP2P2U5TTR4VNCLEDKMXAQWN7CHWLHI27";

function testField(label: string): bigint {
  const digest = sha256(utf8(`PHLOEM_NON_SECRET_TEST_FIELD:${label}`));
  digest[0] = 0;
  return bytesToBigInt(digest);
}

function testId(domain: string, value: string): Uint8Array {
  return deriveId(domain, utf8(`PHLOEM_NON_SECRET_TEST_ID:${value}`));
}

function decimal(values: readonly bigint[]): string[] {
  return values.map((value) => value.toString());
}

function sign(keypair: Keypair, payload: Uint8Array): { digestHex: string; signatureHex: string } {
  const digest = sha256(payload);
  return { digestHex: toHex(digest), signatureHex: toHex(keypair.sign(payload)) };
}

export interface ProtocolVectorV1 {
  readonly metadata: Record<string, unknown>;
  readonly fixture: Record<string, unknown>;
  readonly circom: Record<string, unknown>;
  readonly expected: Record<string, unknown>;
  readonly signing: Record<string, unknown>;
}

export function buildProtocolVectorV1(): ProtocolVectorV1 {
  const network = networkId(TESTNET_PASSPHRASE);
  const controller = addressFromStrKey(CONTROLLER);
  const asset = addressFromStrKey(ASSET);
  const owner = addressFromStrKey(AGENT_OWNER);

  const providerKey = Keypair.fromRawEd25519Seed(sha256(utf8("PHLOEM_NON_SECRET_TEST_KEY:provider")));
  const voucherKey = Keypair.fromRawEd25519Seed(sha256(utf8("PHLOEM_NON_SECRET_TEST_KEY:voucher")));
  const provider = addressFromStrKey(providerKey.publicKey());

  const sessionId = testId("PHLOEM_SESSION_ID_V1", "genesis-demo");
  const nodeId = testId("PHLOEM_BUDGET_NODE_ID_V1", "research-agent");
  const noteId = testId("PHLOEM_BUDGET_NOTE_ID_V1", "root-note-1");
  const reservationId = testId("PHLOEM_RESERVATION_ID_V1", "research-payment-1");
  const serviceIdHash = testId("PHLOEM_SERVICE_ID_V1", "research-data-service");
  const requestId = testId("PHLOEM_REQUEST_ID_V1", "request-1");
  const requestHash = sha256(utf8('{"query":"stellar genesis evidence"}'));
  const responseHash = sha256(utf8('{"items":[{"id":"genesis-001","score":100}],"version":1}'));
  const policyHash = testField("session-policy");
  const providerSppPublicKey = testField("provider-spp-public-key");

  const [networkHi, networkLo] = bytes32ToLimbs(network);
  const [sessionHi, sessionLo] = bytes32ToLimbs(sessionId);
  const [nodeHi, nodeLo] = bytes32ToLimbs(nodeId);
  const [noteHi, noteLo] = bytes32ToLimbs(noteId);
  const contextFields = [
    1n,
    networkHi, networkLo,
    ...addressFields(controller),
    sessionHi, sessionLo,
    nodeHi, nodeLo,
    ...addressFields(owner),
    ...addressFields(asset),
    policyHash,
    noteHi, noteLo,
  ];
  const contextHash = poseidon2HashFields(contextFields, POSEIDON_DOMAINS.contextInit, POSEIDON_DOMAINS.contextFold);

  const budgetAmount = 2_000_000n;
  const budgetBlind = testField("budget-blind");
  const budgetCommitment = poseidon2Hash3(contextHash, budgetAmount, budgetBlind, POSEIDON_DOMAINS.budgetNote);

  const [serviceHi, serviceLo] = bytes32ToLimbs(serviceIdHash);
  const providerLeafFields = [
    1n,
    ...addressFields(provider),
    providerSppPublicKey,
    serviceHi, serviceLo,
    7n,
    2n,
  ];
  const providerLeaf = poseidon2HashFields(providerLeafFields, POSEIDON_DOMAINS.providerInit, POSEIDON_DOMAINS.providerFold);

  const offer: ServiceOfferPayload = {
    protocolVersion: 1,
    offerVersion: 1,
    networkId: network,
    treasuryController: controller,
    providerIdentity: provider,
    serviceIdHash,
    categoryId: 7,
    asset,
    pricingModel: 1,
    fixedPriceAtomic: 100_000n,
    supportedSettlementModes: 2,
    validUntilLedger: 5_000_000,
    offerNonce: testId("PHLOEM_OFFER_NONCE_V1", "offer-1"),
  };
  const serviceOfferBytes = encodeServiceOffer(offer);
  const offerDigest = sha256(serviceOfferBytes);
  const [offerDigestHi, offerDigestLo] = bytes32ToLimbs(offerDigest);

  const reservationContextHash = poseidon2HashFields(
    [contextHash, ...bytes32ToLimbs(reservationId), providerLeaf],
    POSEIDON_DOMAINS.contextInit,
    POSEIDON_DOMAINS.contextFold,
  );
  const offerCommitmentFields = [reservationContextHash, offerDigestHi, offerDigestLo, testField("offer-blind")];
  const offerCommitment = poseidon2HashFields(
    offerCommitmentFields,
    POSEIDON_DOMAINS.offerInit,
    POSEIDON_DOMAINS.offerFold,
  );

  const reservationAmount = 500_000n;
  const claimAmount = 100_000n;
  const reservationCommitment = poseidon2Hash3(
    reservationContextHash,
    reservationAmount,
    testField("reservation-blind"),
    POSEIDON_DOMAINS.reservation,
  );
  const voucherContextHash = poseidon2HashFields(
    [reservationContextHash, offerCommitment, ...bytes32ToLimbs(voucherKey.rawPublicKey())],
    POSEIDON_DOMAINS.contextInit,
    POSEIDON_DOMAINS.contextFold,
  );
  const voucherAmountCommitment = poseidon2Hash3(
    voucherContextHash,
    claimAmount,
    testField("voucher-amount-blind"),
    POSEIDON_DOMAINS.voucherAmount,
  );
  const providerCommitment = poseidon2Hash3(
    reservationContextHash,
    providerSppPublicKey,
    testField("provider-blind"),
    POSEIDON_DOMAINS.providerInit,
  );
  const sppOutputCommitment = poseidon2Hash3(
    claimAmount,
    providerSppPublicKey,
    testField("spp-output-blind"),
    POSEIDON_DOMAINS.sppNote,
  );

  const refundContextHash = poseidon2HashFields(
    [contextHash, ...bytes32ToLimbs(testId("PHLOEM_BUDGET_NOTE_ID_V1", "refund-note-1"))],
    POSEIDON_DOMAINS.contextInit,
    POSEIDON_DOMAINS.contextFold,
  );
  const refundAmount = reservationAmount - claimAmount;
  const refundBudgetCommitment = poseidon2Hash3(
    refundContextHash,
    refundAmount,
    testField("refund-blind"),
    POSEIDON_DOMAINS.budgetNote,
  );

  const auditContextHash = poseidon2HashFields(
    [contextHash, 1n, policyHash],
    POSEIDON_DOMAINS.contextInit,
    POSEIDON_DOMAINS.contextFold,
  );
  const oldAuditTotal = 300_000n;
  const newAuditTotal = oldAuditTotal + claimAmount;
  const oldAuditTotalCommitment = poseidon2Hash3(
    auditContextHash,
    oldAuditTotal,
    testField("old-audit-blind"),
    POSEIDON_DOMAINS.auditTotal,
  );
  const newAuditTotalCommitment = poseidon2Hash3(
    auditContextHash,
    newAuditTotal,
    testField("new-audit-blind"),
    POSEIDON_DOMAINS.auditTotal,
  );
  const usageRoot = testField("usage-root");

  const evidence: UsageEvidencePayload = {
    protocolVersion: 1,
    evidenceVersion: 1,
    networkId: network,
    treasuryController: controller,
    sessionId,
    reservationId,
    providerIdentity: provider,
    serviceIdHash,
    categoryId: 7,
    requestId,
    requestHash,
    responseHash,
    usageUnits: 1n,
    offerCommitment,
    providerSequence: 1n,
    issuedAtLedger: 4_900_000,
    validUntilLedger: 4_900_100,
    evidenceNonce: testId("PHLOEM_EVIDENCE_NONCE_V1", "evidence-1"),
  };
  const usageEvidenceBytes = encodeUsageEvidence(evidence);

  const voucher: PrivateVoucherPayload = {
    protocolVersion: 1,
    voucherVersion: 1,
    networkId: network,
    treasuryController: controller,
    sessionId,
    reservationId,
    sequence: 1n,
    cumulativeAmountCommitment: voucherAmountCommitment,
    usageRoot,
    offerCommitment,
    expiryLedger: 4_900_200,
  };
  const voucherBytes = encodePrivateVoucher(voucher);

  const budgetPublicSignals = [contextHash, budgetCommitment, refundBudgetCommitment, 1n, 0n, 0n];
  const privateSettlementPublicSignals = [
    reservationContextHash,
    reservationCommitment,
    voucherAmountCommitment,
    providerCommitment,
    sppOutputCommitment,
    refundBudgetCommitment,
    providerLeaf,
    oldAuditTotalCommitment,
    newAuditTotalCommitment,
    usageRoot,
    offerCommitment,
  ];
  const auditPublicSignals = [auditContextHash, newAuditTotalCommitment, 500_000n, testField("snapshot-hash-field")];

  return {
    metadata: {
      name: "phloem-phase0-v1",
      protocolVersion: 1,
      encodingVersion: 1,
      fixtureOnly: true,
      containsProductionSecrets: false,
      poseidon2: {
        field: "BN254 scalar",
        rust: "taceo-poseidon2@0.3.0",
        typescript: "@taceo/poseidon2@0.2.0",
        circom: "@taceo/circom-lib@0.9.0",
      },
    },
    fixture: {
      networkPassphrase: TESTNET_PASSPHRASE,
      networkIdHex: toHex(network),
      controller: CONTROLLER,
      asset: ASSET,
      agentOwner: AGENT_OWNER,
      providerIdentity: providerKey.publicKey(),
      providerPublicKeyHex: toHex(providerKey.rawPublicKey()),
      voucherSignerPublicKeyHex: toHex(voucherKey.rawPublicKey()),
      ids: {
        sessionId: toHex(sessionId), nodeId: toHex(nodeId), noteId: toHex(noteId),
        reservationId: toHex(reservationId), serviceIdHash: toHex(serviceIdHash), requestId: toHex(requestId),
      },
      values: {
        budgetAmount: budgetAmount.toString(), reservationAmount: reservationAmount.toString(),
        claimAmount: claimAmount.toString(), refundAmount: refundAmount.toString(),
        oldAuditTotal: oldAuditTotal.toString(), newAuditTotal: newAuditTotal.toString(),
      },
      signingInputs: {
        serviceOffer: {
          protocolVersion: offer.protocolVersion,
          offerVersion: offer.offerVersion,
          networkIdHex: toHex(offer.networkId),
          treasuryControllerHex: toHex(encodeAddress(offer.treasuryController)),
          providerIdentityHex: toHex(encodeAddress(offer.providerIdentity)),
          serviceIdHashHex: toHex(offer.serviceIdHash),
          categoryId: offer.categoryId,
          assetHex: toHex(encodeAddress(offer.asset)),
          pricingModel: offer.pricingModel,
          fixedPriceAtomic: offer.fixedPriceAtomic.toString(),
          supportedSettlementModes: offer.supportedSettlementModes,
          validUntilLedger: offer.validUntilLedger,
          offerNonceHex: toHex(offer.offerNonce),
        },
        usageEvidence: {
          protocolVersion: evidence.protocolVersion,
          evidenceVersion: evidence.evidenceVersion,
          networkIdHex: toHex(evidence.networkId),
          treasuryControllerHex: toHex(encodeAddress(evidence.treasuryController)),
          sessionIdHex: toHex(evidence.sessionId),
          reservationIdHex: toHex(evidence.reservationId),
          providerIdentityHex: toHex(encodeAddress(evidence.providerIdentity)),
          serviceIdHashHex: toHex(evidence.serviceIdHash),
          categoryId: evidence.categoryId,
          requestIdHex: toHex(evidence.requestId),
          requestHashHex: toHex(evidence.requestHash),
          responseHashHex: toHex(evidence.responseHash),
          usageUnits: evidence.usageUnits.toString(),
          offerCommitment: evidence.offerCommitment.toString(),
          providerSequence: evidence.providerSequence.toString(),
          issuedAtLedger: evidence.issuedAtLedger,
          validUntilLedger: evidence.validUntilLedger,
          evidenceNonceHex: toHex(evidence.evidenceNonce),
        },
        privateVoucher: {
          protocolVersion: voucher.protocolVersion,
          voucherVersion: voucher.voucherVersion,
          networkIdHex: toHex(voucher.networkId),
          treasuryControllerHex: toHex(encodeAddress(voucher.treasuryController)),
          sessionIdHex: toHex(voucher.sessionId),
          reservationIdHex: toHex(voucher.reservationId),
          sequence: voucher.sequence.toString(),
          cumulativeAmountCommitment: voucher.cumulativeAmountCommitment.toString(),
          usageRoot: voucher.usageRoot.toString(),
          offerCommitment: voucher.offerCommitment.toString(),
          expiryLedger: voucher.expiryLedger,
        },
      },
    },
    circom: {
      contextFields: decimal(contextFields),
      providerLeafFields: decimal(providerLeafFields),
      offerCommitmentFields: decimal(offerCommitmentFields),
      budgetAmount: budgetAmount.toString(),
      budgetBlind: budgetBlind.toString(),
      domains: Object.fromEntries(Object.entries(POSEIDON_DOMAINS).map(([key, value]) => [key, value.toString()])),
    },
    expected: {
      contextHash: contextHash.toString(),
      budgetCommitment: budgetCommitment.toString(),
      providerLeaf: providerLeaf.toString(),
      offerCommitment: offerCommitment.toString(),
      reservationCommitment: reservationCommitment.toString(),
      voucherAmountCommitment: voucherAmountCommitment.toString(),
      sppOutputCommitment: sppOutputCommitment.toString(),
      refundBudgetCommitment: refundBudgetCommitment.toString(),
      oldAuditTotalCommitment: oldAuditTotalCommitment.toString(),
      newAuditTotalCommitment: newAuditTotalCommitment.toString(),
      publicSignals: {
        budgetTransitionV1: decimal(budgetPublicSignals),
        privateSettlementBindingV1: decimal(privateSettlementPublicSignals),
        auditTotalSpendLeqV1: decimal(auditPublicSignals),
      },
    },
    signing: {
      serviceOffer: {
        bytesHex: toHex(serviceOfferBytes),
        ...sign(providerKey, serviceOfferBytes),
      },
      usageEvidence: {
        bytesHex: toHex(usageEvidenceBytes),
        ...sign(providerKey, usageEvidenceBytes),
      },
      privateVoucher: {
        bytesHex: toHex(voucherBytes),
        ...sign(voucherKey, voucherBytes),
      },
    },
  };
}

export function verifyVectorSignatures(vector: ProtocolVectorV1): boolean {
  const fixture = vector.fixture as { providerIdentity: string; voucherSignerPublicKeyHex: string };
  const signing = vector.signing as Record<string, { bytesHex: string; signatureHex: string }>;
  const provider = Keypair.fromPublicKey(fixture.providerIdentity);
  const voucher = Keypair.fromRawEd25519Seed(sha256(utf8("PHLOEM_NON_SECRET_TEST_KEY:voucher")));
  const decode = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));
  return provider.verify(decode(signing.serviceOffer!.bytesHex), decode(signing.serviceOffer!.signatureHex))
    && provider.verify(decode(signing.usageEvidence!.bytesHex), decode(signing.usageEvidence!.signatureHex))
    && toHex(voucher.rawPublicKey()) === fixture.voucherSignerPublicKeyHex
    && voucher.verify(decode(signing.privateVoucher!.bytesHex), decode(signing.privateVoucher!.signatureHex));
}
