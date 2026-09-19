import assert from "node:assert/strict";
import test from "node:test";

import type { AgentAction } from "@phloem/agent-runtime";
import type {
  Client,
  Groth16Proof,
  PrivateDelegationInput,
  PrivateReservationInput,
  contract,
} from "@phloem/treasury-controller-client";

import {
  PrivateFinancialInvocationBuilder,
  PrivatePlanBindingError,
  type PrivateOperationPlanner,
} from "./private-invocations.js";

const actor = {
  role: "SUPERVISOR" as const,
  identity: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
};
const sessionId = "01".repeat(32);
const proof = {} as Groth16Proof;
const tx = {} as contract.AssembledTransaction<unknown>;
const delegationAction: Extract<AgentAction, { type: "delegate_authority" }> = {
  type: "delegate_authority",
  sessionId,
  childAgent: "RESEARCH",
  amountAtomic: "500000",
  categoryMask: "2",
  allowedActionsMask: "6",
  expiresAtLedger: 1800,
  remainingDelegationDepth: 0,
  rationale: "Bound the research branch.",
};
const paymentAction: Extract<AgentAction, { type: "request_payment" }> = {
  type: "request_payment",
  sessionId,
  agent: "RESEARCH",
  serviceId: "research-data-service",
  offerReferenceHash: "02".repeat(32),
  amountAtomic: "100000",
  rationale: "Reserve the approved provider payment.",
};

function privateDelegation(): PrivateDelegationInput {
  return {
    child_node_id: Buffer.alloc(32, 3),
    child_note_id: Buffer.alloc(32, 4),
    child_owner: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    child_policy: {
      category_mask: 2n,
      allowed_actions_mask: 6n,
      expiry: 1800,
      remaining_delegation_depth: 0,
    },
    child_commitment: 11n,
    remainder_note_id: Buffer.alloc(32, 5),
    remainder_commitment: 13n,
  };
}

function privateReservation(): PrivateReservationInput {
  return {
    reservation_id: Buffer.alloc(32, 6),
    session_id: Buffer.from(sessionId, "hex"),
    source_budget_note_id: Buffer.alloc(32, 7),
    category_id: 1,
    offer_commitment: 17n,
    voucher_signer_public_key: Buffer.alloc(32, 8),
    amount_commitment: 19n,
    provider_commitment: 23n,
    claim_deadline_ledger: 1700,
    remainder_budget_note_id: Buffer.alloc(32, 9),
    remainder_commitment: 29n,
  };
}

function planner(overrides: Partial<PrivateOperationPlanner> = {}): PrivateOperationPlanner {
  return {
    prepareDelegation: async () => ({
      sessionId: Buffer.from(sessionId, "hex"),
      sourceNoteId: Buffer.alloc(32, 10),
      delegation: privateDelegation(),
      proof,
      sourceAgent: actor.identity,
      childRole: "RESEARCH",
      amountAtomic: delegationAction.amountAtomic,
    }),
    prepareReservation: async () => ({
      input: privateReservation(),
      proof,
      sourceAgent: actor.identity,
      serviceId: "research-data-service",
      offerReferenceHash: paymentAction.offerReferenceHash,
      amountAtomic: paymentAction.amountAtomic,
    }),
    ...overrides,
  };
}

function client(calls: string[]): Client {
  return {
    delegate_private_budget: async () => {
      calls.push("delegate_private_budget");
      return tx;
    },
    open_private_reservation: async () => {
      calls.push("open_private_reservation");
      return tx;
    },
  } as unknown as Client;
}

const agentIdentities = {
  resolve: async () => privateDelegation().child_owner,
};

test("delegation action binds every public policy field before generated call construction", async () => {
  const calls: string[] = [];
  const result = await new PrivateFinancialInvocationBuilder(planner(), agentIdentities).build(
    client(calls),
    delegationAction,
    actor,
  );
  assert.equal(result, tx);
  assert.deepEqual(calls, ["delegate_private_budget"]);
});

test("payment action becomes a private reservation rather than a plaintext settlement", async () => {
  const calls: string[] = [];
  const result = await new PrivateFinancialInvocationBuilder(planner(), agentIdentities).build(
    client(calls),
    paymentAction,
    { role: "RESEARCH", identity: actor.identity },
  );
  assert.equal(result, tx);
  assert.deepEqual(calls, ["open_private_reservation"]);
});

test("planner metadata substitution is rejected before a generated contract call", async () => {
  const calls: string[] = [];
  const badPlanner = planner({
    prepareReservation: async () => ({
      input: privateReservation(),
      proof,
      sourceAgent: actor.identity,
      serviceId: "research-data-service",
      offerReferenceHash: "ff".repeat(32),
      amountAtomic: paymentAction.amountAtomic,
    }),
  });
  await assert.rejects(
    new PrivateFinancialInvocationBuilder(badPlanner, agentIdentities).build(
      client(calls),
      paymentAction,
      { role: "RESEARCH", identity: actor.identity },
    ),
    PrivatePlanBindingError,
  );
  assert.deepEqual(calls, []);
});
