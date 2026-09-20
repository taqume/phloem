import type { AgentAction } from "@phloem/agent-runtime";
import type {
  AgentActor,
  PrivateDelegationContextResolver,
  PrivateReservationContextResolver,
  ReservedResearchContextResolver,
  ReservedResearchRequestContext,
  ResolvedPrivateDelegationContext,
  ResolvedPrivateReservationContext,
  ProtocolReader,
  ProtocolReadResult,
} from "@phloem/execution-gateway";
import type { EncryptedPrivacyStateStore } from "@phloem/privacy-runtime/state-store";
import {
  addressFromStrKey,
  encodeServiceOffer,
  providerPolicyLeaf,
  sha256,
  toHex,
  type ServiceOffer,
  type ServiceOfferPayload,
} from "@phloem/protocol-types";
import { serviceOfferSchema } from "@phloem/protocol-types";
import type {
  BudgetNode,
  BudgetNoteState,
  Client,
  PrivatePaymentReservation,
  Session,
} from "@phloem/treasury-controller-client";
import { Keypair } from "@stellar/stellar-sdk";

import type { ControlledProviderPrivatePublicConfig } from "./private-session";

type DelegateAction = Extract<AgentAction, { type: "delegate_authority" }>;
type PaymentAction = Extract<AgentAction, { type: "request_payment" }>;
type ServiceAction = Extract<AgentAction, { type: "request_service" }>;

const ACTION_DELEGATE_BUDGET = 1n;
const ACTION_OPEN_PRIVATE_RESERVATION = 1n << 2n;
const PRIVATE_SETTLEMENT_MODE_MASK = 2;

export type LiveControllerReader = Pick<Client,
  | "get_session"
  | "get_budget_note"
  | "get_budget_node"
  | "get_budget_note_context_hash"
  | "get_private_reservation"
>;

export interface ControlledOfferSnapshot {
  readonly offer: ServiceOffer;
  readonly referenceHash: string;
}

export interface ControlledOfferResolver {
  current(): Promise<ControlledOfferSnapshot>;
}

interface VerifiedPrivateSource {
  readonly opening: Readonly<{
    noteId: string;
    sessionId: string;
    nodeId: string;
    owner: string;
    asset: string;
    policyHash: string;
    contextHash: string;
    commitment: string;
    amountAtomic: string;
  }>;
  readonly session: Session;
  readonly note: BudgetNoteState;
  readonly node: BudgetNode;
  readonly latestLedger: number;
}

function canonicalOfferPayload(offer: ServiceOffer): ServiceOfferPayload {
  return {
    protocolVersion: offer.protocolVersion,
    offerVersion: offer.offerVersion,
    networkId: Buffer.from(offer.networkId, "hex"),
    treasuryController: addressFromStrKey(offer.treasuryController),
    providerIdentity: addressFromStrKey(offer.providerIdentity),
    serviceIdHash: Buffer.from(offer.serviceIdHash, "hex"),
    categoryId: offer.categoryId,
    asset: addressFromStrKey(offer.asset),
    pricingModel: 1,
    fixedPriceAtomic: BigInt(offer.fixedPriceAtomic),
    supportedSettlementModes: offer.supportedSettlementModes,
    validUntilLedger: offer.validUntilLedger,
    offerNonce: Buffer.from(offer.offerNonce, "hex"),
  };
}

export function verifyControlledOffer(
  input: unknown,
  expected: {
    readonly networkIdHex: string;
    readonly treasuryController: string;
    readonly provider: ControlledProviderPrivatePublicConfig;
  },
): ControlledOfferSnapshot {
  const offer = serviceOfferSchema.parse(input);
  if (offer.networkId !== expected.networkIdHex
    || offer.treasuryController !== expected.treasuryController
    || offer.providerIdentity !== expected.provider.providerIdentity
    || offer.serviceIdHash !== toHex(expected.provider.serviceIdHash)
    || offer.categoryId !== expected.provider.categoryId
    || (offer.supportedSettlementModes & PRIVATE_SETTLEMENT_MODE_MASK) === 0) {
    throw new Error("controlled provider offer differs from the pinned PRIVATE policy");
  }
  const signingBytes = encodeServiceOffer(canonicalOfferPayload(offer));
  if (!Keypair.fromPublicKey(offer.providerIdentity).verify(
    signingBytes,
    Buffer.from(offer.providerSignature, "hex"),
  )) {
    throw new Error("controlled provider offer signature is invalid");
  }
  return Object.freeze({
    offer,
    referenceHash: toHex(sha256(signingBytes)),
  });
}

export class HttpControlledOfferResolver implements ControlledOfferResolver {
  readonly #endpoint: string;
  readonly #networkIdHex: string;
  readonly #treasuryController: string;
  readonly #provider: ControlledProviderPrivatePublicConfig;
  readonly #fetch: typeof fetch;

  constructor(input: {
    readonly endpoint: string;
    readonly networkIdHex: string;
    readonly treasuryController: string;
    readonly provider: ControlledProviderPrivatePublicConfig;
    readonly fetch?: typeof fetch;
  }) {
    const endpoint = new URL(input.endpoint);
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
      throw new Error("controlled provider offer endpoint must use HTTP or HTTPS");
    }
    this.#endpoint = endpoint.toString();
    this.#networkIdHex = input.networkIdHex;
    this.#treasuryController = input.treasuryController;
    this.#provider = input.provider;
    this.#fetch = input.fetch ?? fetch;
  }

  async current(): Promise<ControlledOfferSnapshot> {
    const response = await this.#fetch(this.#endpoint, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`controlled provider offer returned HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body) || !("offer" in body)) {
      throw new Error("controlled provider offer response is malformed");
    }
    return verifyControlledOffer((body as { readonly offer: unknown }).offer, {
      networkIdHex: this.#networkIdHex,
      treasuryController: this.#treasuryController,
      provider: this.#provider,
    });
  }
}

function canonicalSessionId(value: string): Buffer {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error("session id must be canonical lowercase hexadecimal");
  return Buffer.from(value, "hex");
}

function agentOwner(note: BudgetNoteState): string | undefined {
  return note.owner.tag === "AgentSmartAccount" ? note.owner.values[0] : undefined;
}

function assertPrivateSession(session: Session, sessionId: string, latestLedger: number): void {
  if (toHex(session.id) !== sessionId
    || session.lifecycle.tag !== "Active"
    || session.safety.tag !== "Normal"
    || session.settlement_mode.tag !== "Private"
    || session.expires_at_ledger <= latestLedger) {
    throw new Error("session is not live PRIVATE authority on Testnet");
  }
}

/** Joins encrypted openings to canonical Testnet state without exposing the opening. */
export class LivePrivateSourceReader {
  readonly #store: EncryptedPrivacyStateStore;
  readonly #client: LiveControllerReader;
  readonly #latestLedger: () => Promise<number>;

  constructor(input: {
    readonly store: EncryptedPrivacyStateStore;
    readonly client: LiveControllerReader;
    readonly latestLedger: () => Promise<number>;
  }) {
    this.#store = input.store;
    this.#client = input.client;
    this.#latestLedger = input.latestLedger;
  }

  async resolve(sessionId: string, actorIdentity: string): Promise<VerifiedPrivateSource> {
    const sessionIdBytes = canonicalSessionId(sessionId);
    const snapshot = await this.#store.readSnapshot();
    const candidates = snapshot.budgetNotes.filter((item) => (
      item.sessionId === sessionId && item.owner === actorIdentity && item.status === "ACTIVE"
    ));
    if (candidates.length !== 1) {
      throw new Error(`expected exactly one active private BudgetNote for the agent, found ${candidates.length}`);
    }
    const opening = candidates[0]!;
    const noteId = Buffer.from(opening.noteId, "hex");
    const nodeId = Buffer.from(opening.nodeId, "hex");
    const [sessionRead, noteRead, nodeRead, contextRead, latestLedger] = await Promise.all([
      this.#client.get_session({ session_id: sessionIdBytes }),
      this.#client.get_budget_note({ note_id: noteId }),
      this.#client.get_budget_node({ node_id: nodeId }),
      this.#client.get_budget_note_context_hash({ note_id: noteId }),
      this.#latestLedger(),
    ]);
    const session = sessionRead.result;
    const note = noteRead.result;
    const node = nodeRead.result;
    if (!session || !note || !node) throw new Error("encrypted BudgetNote is missing from canonical Testnet state");
    assertPrivateSession(session, sessionId, latestLedger);
    if (note.state.tag !== "Active"
      || node.state.tag !== "Active"
      || node.branch_frozen
      || toHex(note.id) !== opening.noteId
      || toHex(note.session_id) !== sessionId
      || toHex(note.node_id) !== opening.nodeId
      || toHex(node.id) !== opening.nodeId
      || toHex(node.session_id) !== sessionId
      || agentOwner(note) !== actorIdentity
      || node.owner.tag !== "AgentSmartAccount"
      || node.owner.values[0] !== actorIdentity
      || note.commitment.toString() !== opening.commitment
      || note.policy_hash.toString() !== opening.policyHash
      || contextRead.result.toString() !== opening.contextHash
      || session.asset !== opening.asset) {
      throw new Error("encrypted BudgetNote opening differs from canonical Testnet state");
    }
    return Object.freeze({ opening, session, note, node, latestLedger });
  }
}

export class LivePrivateDelegationContextResolver implements PrivateDelegationContextResolver {
  readonly #sources: LivePrivateSourceReader;
  readonly #childIdentity: (sessionId: string, role: DelegateAction["childAgent"]) => Promise<string>;
  readonly #networkId: Buffer;
  readonly #treasuryController: string;

  constructor(input: {
    readonly sources: LivePrivateSourceReader;
    readonly childIdentity: (sessionId: string, role: DelegateAction["childAgent"]) => Promise<string>;
    readonly networkId: Uint8Array;
    readonly treasuryController: string;
  }) {
    this.#sources = input.sources;
    this.#childIdentity = input.childIdentity;
    this.#networkId = Buffer.from(input.networkId);
    this.#treasuryController = input.treasuryController;
  }

  async resolve(action: DelegateAction, actor: AgentActor): Promise<ResolvedPrivateDelegationContext> {
    const source = await this.#sources.resolve(action.sessionId, actor.identity);
    const parent = source.node.node_policy;
    const childPolicy = {
      category_mask: BigInt(action.categoryMask),
      allowed_actions_mask: BigInt(action.allowedActionsMask),
      expiry: action.expiresAtLedger,
      remaining_delegation_depth: action.remainingDelegationDepth,
    };
    if ((parent.allowed_actions_mask & ACTION_DELEGATE_BUDGET) === 0n
      || (childPolicy.category_mask & ~parent.category_mask) !== 0n
      || (childPolicy.allowed_actions_mask & ~parent.allowed_actions_mask) !== 0n
      || childPolicy.expiry > parent.expiry
      || childPolicy.expiry > source.session.expires_at_ledger
      || childPolicy.expiry <= source.latestLedger
      || childPolicy.remaining_delegation_depth >= parent.remaining_delegation_depth
      || BigInt(action.amountAtomic) > BigInt(source.opening.amountAtomic)) {
      throw new Error("delegation intent exceeds the canonical parent authority");
    }
    return Object.freeze({
      sessionId: Buffer.from(action.sessionId, "hex"),
      sourceBudgetNoteId: Buffer.from(source.opening.noteId, "hex"),
      sourceAgent: actor.identity,
      networkId: this.#networkId,
      treasuryController: this.#treasuryController,
      childRole: action.childAgent,
      childOwner: await this.#childIdentity(action.sessionId, action.childAgent),
      childPolicy,
      delegatedAmountAtomic: action.amountAtomic,
      createdAtUnixMs: Date.now(),
    });
  }
}

export class LivePrivateReservationContextResolver implements PrivateReservationContextResolver {
  readonly #sources: LivePrivateSourceReader;
  readonly #offers: ControlledOfferResolver;
  readonly #provider: ControlledProviderPrivatePublicConfig;
  readonly #networkId: Buffer;
  readonly #treasuryController: string;

  constructor(input: {
    readonly sources: LivePrivateSourceReader;
    readonly offers: ControlledOfferResolver;
    readonly provider: ControlledProviderPrivatePublicConfig;
    readonly networkId: Uint8Array;
    readonly treasuryController: string;
  }) {
    this.#sources = input.sources;
    this.#offers = input.offers;
    this.#provider = input.provider;
    this.#networkId = Buffer.from(input.networkId);
    this.#treasuryController = input.treasuryController;
  }

  async resolve(action: PaymentAction, actor: AgentActor): Promise<ResolvedPrivateReservationContext> {
    const [source, offerSnapshot] = await Promise.all([
      this.#sources.resolve(action.sessionId, actor.identity),
      this.#offers.current(),
    ]);
    const { offer, referenceHash } = offerSnapshot;
    const providerRoot = providerPolicyLeaf({
      version: 1,
      providerIdentity: addressFromStrKey(this.#provider.providerIdentity),
      providerSppPublicKey: this.#provider.providerSppPublicKey,
      serviceIdHash: this.#provider.serviceIdHash,
      categoryId: this.#provider.categoryId,
      allowedSettlementModes: PRIVATE_SETTLEMENT_MODE_MASK,
    });
    const categoryBit = 1n << BigInt(offer.categoryId);
    if (referenceHash !== action.offerReferenceHash
      || offer.fixedPriceAtomic !== action.amountAtomic
      || offer.asset !== source.session.asset
      || offer.validUntilLedger <= source.latestLedger
      || providerRoot !== source.session.approved_provider_root
      || (source.node.node_policy.allowed_actions_mask & ACTION_OPEN_PRIVATE_RESERVATION) === 0n
      || (source.node.node_policy.category_mask & categoryBit) === 0n
      || BigInt(action.amountAtomic) > BigInt(source.opening.amountAtomic)) {
      throw new Error("payment intent differs from the live signed offer or bounded authority");
    }
    return Object.freeze({
      sessionId: Buffer.from(action.sessionId, "hex"),
      sourceBudgetNoteId: Buffer.from(source.opening.noteId, "hex"),
      sourceAgent: actor.identity,
      networkId: this.#networkId,
      treasuryController: this.#treasuryController,
      approvedProviderRoot: source.session.approved_provider_root,
      categoryId: offer.categoryId,
      serviceId: action.serviceId,
      offerReferenceHash: referenceHash,
      reservationAmountAtomic: offer.fixedPriceAtomic,
      providerSppPublicKey: this.#provider.providerSppPublicKey,
      claimDeadlineLedger: Math.min(offer.validUntilLedger, source.session.expires_at_ledger),
      createdAtUnixMs: Date.now(),
    });
  }
}

export class LiveResearchRequestContextResolver implements ReservedResearchContextResolver {
  readonly #store: EncryptedPrivacyStateStore;
  readonly #client: LiveControllerReader;
  readonly #offers: ControlledOfferResolver;
  readonly #latestLedger: () => Promise<number>;

  constructor(input: {
    readonly store: EncryptedPrivacyStateStore;
    readonly client: LiveControllerReader;
    readonly offers: ControlledOfferResolver;
    readonly latestLedger: () => Promise<number>;
  }) {
    this.#store = input.store;
    this.#client = input.client;
    this.#offers = input.offers;
    this.#latestLedger = input.latestLedger;
  }

  async resolve(action: ServiceAction, actor: AgentActor): Promise<ReservedResearchRequestContext> {
    const snapshot = await this.#store.readSnapshot();
    const reservations = snapshot.reservations.filter((reservation) => {
      if (reservation.sessionId !== action.sessionId || reservation.status !== "OPEN") return false;
      const source = snapshot.budgetNotes.find((note) => note.noteId === reservation.sourceBudgetNoteId);
      return source?.owner === actor.identity;
    });
    if (reservations.length !== 1) {
      throw new Error(`expected exactly one open controlled-provider reservation, found ${reservations.length}`);
    }
    const reservation = reservations[0]!;
    const [chainRead, offerSnapshot, issuedAtLedger] = await Promise.all([
      this.#client.get_private_reservation({ reservation_id: Buffer.from(reservation.reservationId, "hex") }),
      this.#offers.current(),
      this.#latestLedger(),
    ]);
    const chain: PrivatePaymentReservation | undefined = chainRead.result;
    if (!chain
      || chain.status.tag !== "Open"
      || toHex(chain.id) !== reservation.reservationId
      || toHex(chain.session_id) !== action.sessionId
      || chain.source_agent !== actor.identity
      || chain.offer_commitment.toString() !== reservation.offerCommitment
      || chain.amount_commitment.toString() !== reservation.amountCommitment
      || chain.provider_commitment.toString() !== reservation.providerCommitment
      || reservation.offerReferenceHash !== offerSnapshot.referenceHash
      || issuedAtLedger >= reservation.claimDeadlineLedger) {
      throw new Error("local provider reservation differs from live Testnet state or signed offer");
    }
    return Object.freeze({
      reservationId: reservation.reservationId,
      offerCommitment: reservation.offerCommitment,
      issuedAtLedger,
      maxItems: 5,
      signedServiceOffer: offerSnapshot.offer,
    });
  }
}

export class LiveTestnetProtocolReader implements ProtocolReader {
  readonly #sources: LivePrivateSourceReader;
  readonly #agentIdentity: (
    sessionId: string,
    role: "SUPERVISOR" | "RESEARCH" | "BUILDER",
  ) => Promise<Readonly<{ status: string; contractId?: string }>>;
  readonly #latestLedger: () => Promise<number>;

  constructor(input: {
    readonly sources: LivePrivateSourceReader;
    readonly agentIdentity: (
      sessionId: string,
      role: "SUPERVISOR" | "RESEARCH" | "BUILDER",
    ) => Promise<Readonly<{ status: string; contractId?: string }>>;
    readonly latestLedger: () => Promise<number>;
  }) {
    this.#sources = input.sources;
    this.#agentIdentity = input.agentIdentity;
    this.#latestLedger = input.latestLedger;
  }

  async getBudget(
    action: Extract<AgentAction, { type: "get_budget" }>,
    actor: AgentActor,
  ): Promise<ProtocolReadResult> {
    const source = await this.#sources.resolve(action.sessionId, actor.identity);
    if (source.opening.nodeId !== action.nodeId) {
      throw new Error("budget read requested a node outside the authenticated agent branch");
    }
    return Object.freeze({
      ledgerSequence: source.latestLedger,
      value: Object.freeze({
        nodeId: source.opening.nodeId,
        remainingBudgetAtomic: source.opening.amountAtomic,
        branchFrozen: source.node.branch_frozen,
        nodeExpiryLedger: source.node.node_policy.expiry,
        remainingDelegationDepth: source.node.node_policy.remaining_delegation_depth,
      }),
    });
  }

  async getAgentState(
    action: Extract<AgentAction, { type: "get_agent_state" }>,
    _actor: AgentActor,
  ): Promise<ProtocolReadResult> {
    const [identity, ledgerSequence] = await Promise.all([
      this.#agentIdentity(action.sessionId, action.agent),
      this.#latestLedger(),
    ]);
    return Object.freeze({
      ledgerSequence,
      value: Object.freeze({
        role: action.agent,
        deploymentStatus: identity.status,
        contractId: identity.contractId ?? null,
      }),
    });
  }
}
