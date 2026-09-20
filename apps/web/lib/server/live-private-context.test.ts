import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EncryptedPrivacyStateStore } from "@phloem/privacy-runtime/state-store";
import {
  addressFromStrKey,
  encodeServiceOffer,
  networkId,
  providerPolicyLeaf,
  toHex,
  type ServiceOfferPayload,
} from "@phloem/protocol-types";
import type {
  BudgetNode,
  BudgetNoteState,
  PrivatePaymentReservation,
  Session,
} from "@phloem/treasury-controller-client";
import { Keypair } from "@stellar/stellar-sdk";

import {
  LivePrivateDelegationContextResolver,
  LivePrivateReservationContextResolver,
  LivePrivateSourceReader,
  LiveResearchRequestContextResolver,
  verifyControlledOffer,
  type ControlledOfferResolver,
  type LiveControllerReader,
} from "./live-private-context";
import type { ControlledProviderPrivatePublicConfig } from "./private-session";

const NON_PRODUCTION_TEST_KEY = Buffer.alloc(32, 0x42);
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const NETWORK_ID = networkId(NETWORK_PASSPHRASE);
const CONTROLLER = "CB23C2OYMIDYC7OG2PK6NJFIVCYONYV43ABREOGVTW2LT4C2G53G2CWU";
const ASSET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const ACTOR = "CBNIEGOFLMJHOGDC5AH4IVHGYYLFU66KYPSQCWX7ZIRJCBEJLGBOQT2Q";
const CHILD = "CDVATO436WNXJUOGCEFG4I3IHR6K5Y5WMTQREYXE4P53WN2JQOQAC2HE";
const SESSION_ID = "01".repeat(32);
const NODE_ID = "02".repeat(32);
const NOTE_ID = "03".repeat(32);
const RESERVATION_ID = "04".repeat(32);

function transactionResult<T>(result: T) {
  return { result } as never;
}

function providerFixture(): {
  config: ControlledProviderPrivatePublicConfig;
  snapshot: ReturnType<typeof verifyControlledOffer>;
} {
  const signingKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x31));
  const config: ControlledProviderPrivatePublicConfig = {
    providerIdentity: signingKey.publicKey(),
    providerSppPublicKey: 101n,
    providerSppEncryptionPublicKey: Buffer.alloc(32, 0x32),
    serviceIdHash: Buffer.alloc(32, 0x33),
    categoryId: 2,
  };
  const payload: ServiceOfferPayload = {
    protocolVersion: 1,
    offerVersion: 1,
    networkId: NETWORK_ID,
    treasuryController: addressFromStrKey(CONTROLLER),
    providerIdentity: addressFromStrKey(config.providerIdentity),
    serviceIdHash: config.serviceIdHash,
    categoryId: config.categoryId,
    asset: addressFromStrKey(ASSET),
    pricingModel: 1,
    fixedPriceAtomic: 100_000n,
    supportedSettlementModes: 2,
    validUntilLedger: 2_000,
    offerNonce: Buffer.alloc(32, 0x34),
  };
  const signingBytes = encodeServiceOffer(payload);
  const offer = {
    protocolVersion: 1 as const,
    offerVersion: 1 as const,
    networkId: toHex(NETWORK_ID),
    treasuryController: CONTROLLER,
    providerIdentity: config.providerIdentity,
    serviceIdHash: toHex(config.serviceIdHash),
    categoryId: config.categoryId,
    asset: ASSET,
    pricingModel: "FIXED_REQUEST" as const,
    fixedPriceAtomic: "100000",
    supportedSettlementModes: 2,
    validUntilLedger: 2_000,
    offerNonce: "34".repeat(32),
    providerSignature: toHex(signingKey.sign(signingBytes)),
  };
  return {
    config,
    snapshot: verifyControlledOffer(offer, {
      networkIdHex: toHex(NETWORK_ID),
      treasuryController: CONTROLLER,
      provider: config,
    }),
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "phloem-live-context-test-"));
  const store = new EncryptedPrivacyStateStore(join(directory, "state.enc.json"), NON_PRODUCTION_TEST_KEY);
  await store.initialize();
  await store.transaction((state) => {
    state.budgetNotes.push({
      noteId: NOTE_ID,
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      owner: ACTOR,
      asset: ASSET,
      policyHash: "11",
      contextHash: "13",
      commitment: "17",
      amountAtomic: "500000",
      blinding: "19",
      status: "ACTIVE",
    });
  });
  const provider = providerFixture();
  const approvedProviderRoot = providerPolicyLeaf({
    version: 1,
    providerIdentity: addressFromStrKey(provider.config.providerIdentity),
    providerSppPublicKey: provider.config.providerSppPublicKey,
    serviceIdHash: provider.config.serviceIdHash,
    categoryId: provider.config.categoryId,
    allowedSettlementModes: 2,
  });
  const session: Session = {
    approved_provider_root: approvedProviderRoot,
    asset: ASSET,
    audit_finalized: false,
    audit_version: 1,
    category_schema_version: 1,
    company: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x41)).publicKey(),
    created_at_ledger: 900,
    created_protocol_version: 1,
    expires_at_ledger: 5_000,
    final_audit_snapshot_hash: undefined,
    id: Buffer.from(SESSION_ID, "hex"),
    lifecycle: { tag: "Active", values: undefined },
    policy_hash: 11n,
    root_budget_node_id: Buffer.alloc(32, 0x40),
    root_budget_note_id: Buffer.alloc(32, 0x41),
    safety: { tag: "Normal", values: undefined },
    settlement_count: 0n,
    settlement_mode: { tag: "Private", values: undefined },
    treasury_spp_key_commitment: 23n,
    unresolved_reservation_count: 0n,
  };
  const note: BudgetNoteState = {
    commitment: 17n,
    created_at_ledger: 950,
    id: Buffer.from(NOTE_ID, "hex"),
    node_id: Buffer.from(NODE_ID, "hex"),
    owner: { tag: "AgentSmartAccount", values: [ACTOR] },
    policy_hash: 11n,
    session_id: Buffer.from(SESSION_ID, "hex"),
    spent_at_ledger: undefined,
    state: { tag: "Active", values: undefined },
  };
  const node: BudgetNode = {
    branch_frozen: false,
    created_at_ledger: 950,
    depth: 1,
    id: Buffer.from(NODE_ID, "hex"),
    node_policy: {
      allowed_actions_mask: 7n,
      category_mask: 4n,
      expiry: 4_000,
      remaining_delegation_depth: 1,
    },
    owner: { tag: "AgentSmartAccount", values: [ACTOR] },
    parent_node_id: Buffer.alloc(32, 0x40),
    session_id: Buffer.from(SESSION_ID, "hex"),
    state: { tag: "Active", values: undefined },
  };
  const reservation: PrivatePaymentReservation = {
    amount_commitment: 29n,
    approved_provider_root: approvedProviderRoot,
    asset: ASSET,
    category_id: 2,
    claim_deadline_ledger: 2_000,
    created_at_ledger: 1_100,
    id: Buffer.from(RESERVATION_ID, "hex"),
    offer_commitment: 31n,
    provider_commitment: 37n,
    reservation_context_hash: 41n,
    session_id: Buffer.from(SESSION_ID, "hex"),
    source_agent: ACTOR,
    source_node_id: Buffer.from(NODE_ID, "hex"),
    status: { tag: "Open", values: undefined },
    voucher_signer_public_key: Buffer.alloc(32, 0x42),
  };
  const client: LiveControllerReader = {
    get_session: async () => transactionResult(session),
    get_budget_note: async () => transactionResult(note),
    get_budget_node: async () => transactionResult(node),
    get_budget_note_context_hash: async () => transactionResult(13n),
    get_private_reservation: async () => transactionResult(reservation),
  };
  const offers: ControlledOfferResolver = {
    current: async () => provider.snapshot,
    atReference: async () => provider.snapshot,
  };
  const sources = new LivePrivateSourceReader({ store, client, latestLedger: async () => 1_000 });
  return { directory, store, provider, session, note, node, reservation, client, offers, sources };
}

test("controlled offer verification binds signature and the pinned provider policy", () => {
  const provider = providerFixture();
  assert.match(provider.snapshot.referenceHash, /^[0-9a-f]{64}$/u);
  assert.equal(provider.snapshot.offer.fixedPriceAtomic, "100000");
  assert.throws(
    () => verifyControlledOffer(
      { ...provider.snapshot.offer, fixedPriceAtomic: "100001" },
      { networkIdHex: toHex(NETWORK_ID), treasuryController: CONTROLLER, provider: provider.config },
    ),
    /signature is invalid/u,
  );
});

test("live source joins one encrypted opening to exact canonical Testnet state", async (context) => {
  const value = await fixture();
  context.after(async () => {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  });
  const source = await value.sources.resolve(SESSION_ID, ACTOR);
  assert.equal(source.opening.amountAtomic, "500000");
  assert.equal(source.node.node_policy.remaining_delegation_depth, 1);
});

test("delegation and reservation contexts reject authority or offer substitution", async (context) => {
  const value = await fixture();
  context.after(async () => {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  });
  const actor = { role: "SUPERVISOR" as const, identity: ACTOR };
  const delegations = new LivePrivateDelegationContextResolver({
    sources: value.sources,
    childIdentity: async () => CHILD,
    networkId: NETWORK_ID,
    treasuryController: CONTROLLER,
  });
  const delegation = await delegations.resolve({
    type: "delegate_authority",
    sessionId: SESSION_ID,
    childAgent: "RESEARCH",
    amountAtomic: "200000",
    categoryMask: "4",
    allowedActionsMask: "4",
    expiresAtLedger: 3_000,
    remainingDelegationDepth: 0,
    rationale: "Bound Research.",
  }, actor);
  assert.equal(delegation.childOwner, CHILD);
  await assert.rejects(delegations.resolve({
    type: "delegate_authority",
    sessionId: SESSION_ID,
    childAgent: "RESEARCH",
    amountAtomic: "200000",
    categoryMask: "8",
    allowedActionsMask: "4",
    expiresAtLedger: 3_000,
    remainingDelegationDepth: 0,
    rationale: "Attempt a wider category.",
  }, actor), /exceeds the canonical parent authority/u);

  const reservations = new LivePrivateReservationContextResolver({
    sources: value.sources,
    offers: value.offers,
    provider: value.provider.config,
    networkId: NETWORK_ID,
    treasuryController: CONTROLLER,
  });
  const payment = await reservations.resolve({
    type: "request_payment",
    sessionId: SESSION_ID,
    agent: "RESEARCH",
    serviceId: "research-data-service",
    offerReferenceHash: value.provider.snapshot.referenceHash,
    amountAtomic: "100000",
    rationale: "Use the signed fixed-price offer.",
  }, { role: "RESEARCH", identity: ACTOR });
  assert.equal(payment.providerSppPublicKey, value.provider.config.providerSppPublicKey);
  await assert.rejects(reservations.resolve({
    type: "request_payment",
    sessionId: SESSION_ID,
    agent: "RESEARCH",
    serviceId: "research-data-service",
    offerReferenceHash: "ff".repeat(32),
    amountAtomic: "100000",
    rationale: "Attempt a substituted offer.",
  }, { role: "RESEARCH", identity: ACTOR }), /differs from the live signed offer/u);
});

test("provider HTTP context requires one chain-confirmed reservation owned by the actor", async (context) => {
  const value = await fixture();
  context.after(async () => {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  });
  await value.store.transaction((state) => {
    state.budgetNotes[0]!.status = "SPENT";
    state.reservations.push({
      reservationId: RESERVATION_ID,
      sessionId: SESSION_ID,
      sourceBudgetNoteId: NOTE_ID,
      categoryId: 2,
      networkIdHex: toHex(NETWORK_ID),
      treasuryController: CONTROLLER,
      reservationContextHash: "41",
      approvedProviderRoot: value.session.approved_provider_root.toString(),
      amountAtomic: "100000",
      amountBlinding: "43",
      amountCommitment: "29",
      offerReferenceHash: value.provider.snapshot.referenceHash,
      offerBlinding: "47",
      offerCommitment: "31",
      providerSppPublicKey: value.provider.config.providerSppPublicKey.toString(),
      providerBlinding: "53",
      providerCommitment: "37",
      voucherSignerSeedHex: "54".repeat(32),
      voucherSignerPublicKeyHex: "42".repeat(32),
      claimDeadlineLedger: 2_000,
      status: "OPEN",
      openConfirmation: { transactionHash: "55".repeat(32), ledgerSequence: 1_100 },
      createdAtUnixMs: 1_700_000_000_000,
    });
  });
  const resolver = new LiveResearchRequestContextResolver({
    store: value.store,
    client: value.client,
    offers: value.offers,
    latestLedger: async () => 1_200,
  });
  const resolved = await resolver.resolve({
    type: "request_service",
    sessionId: SESSION_ID,
    agent: "RESEARCH",
    serviceId: "research-data-service",
    requestId: "56".repeat(32),
    query: "Stellar privacy",
    rationale: "Use the paid provider.",
  }, { role: "RESEARCH", identity: ACTOR });
  assert.equal(resolved.reservationId, RESERVATION_ID);
  assert.equal(resolved.offerCommitment, "31");
});
