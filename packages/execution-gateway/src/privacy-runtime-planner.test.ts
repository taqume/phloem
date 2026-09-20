import assert from "node:assert/strict";
import test from "node:test";

import type { AgentAction } from "@phloem/agent-runtime";
import type {
  PrivateBudgetDelegationProofPlanner,
  PrivateReservationProofPlanner,
} from "@phloem/privacy-runtime";
import type {
  Groth16Proof,
  PrivateDelegationInput,
  PrivateReservationInput,
} from "@phloem/treasury-controller-client";

import {
  PrivacyRuntimeDelegationPlanner,
  PrivacyRuntimePrivateOperationPlanner,
  PrivacyRuntimeReservationPlanner,
  type PrivateDelegationContextResolver,
  type PrivateReservationContextResolver,
} from "./privacy-runtime-planner.js";
import { PrivatePlanBindingError } from "./private-invocations.js";

const actor = {
  role: "RESEARCH" as const,
  identity: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
};
const action: Extract<AgentAction, { type: "request_payment" }> = {
  type: "request_payment",
  sessionId: "01".repeat(32),
  agent: "RESEARCH",
  serviceId: "research-data-service",
  offerReferenceHash: "02".repeat(32),
  amountAtomic: "100000",
  rationale: "Reserve the controlled provider's signed fixed-price offer.",
};
const proof = { a: Buffer.alloc(64), b: Buffer.alloc(128), c: Buffer.alloc(64) } as Groth16Proof;
const delegationAction: Extract<AgentAction, { type: "delegate_authority" }> = {
  type: "delegate_authority",
  sessionId: action.sessionId,
  childAgent: "RESEARCH",
  amountAtomic: "200000",
  categoryMask: "3",
  allowedActionsMask: "6",
  expiresAtLedger: 450,
  remainingDelegationDepth: 0,
  rationale: "Create a bounded Research authority.",
};
const privateDelegation = {
  child_node_id: Buffer.alloc(32, 20),
  child_note_id: Buffer.alloc(32, 21),
  child_owner: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBK3M",
  child_policy: {
    category_mask: 3n,
    allowed_actions_mask: 6n,
    expiry: 450,
    remaining_delegation_depth: 0,
  },
  child_commitment: 31n,
  remainder_note_id: Buffer.alloc(32, 22),
  remainder_commitment: 37n,
} satisfies PrivateDelegationInput;
const input = {
  reservation_id: Buffer.alloc(32, 3),
  session_id: Buffer.from(action.sessionId, "hex"),
  source_budget_note_id: Buffer.alloc(32, 4),
  category_id: 7,
  offer_commitment: 11n,
  voucher_signer_public_key: Buffer.alloc(32, 5),
  amount_commitment: 13n,
  provider_commitment: 17n,
  claim_deadline_ledger: 500,
  remainder_budget_note_id: Buffer.alloc(32, 6),
  remainder_commitment: 19n,
} satisfies PrivateReservationInput;

function resolver(overrides: Partial<Awaited<ReturnType<PrivateReservationContextResolver["resolve"]>>> = {}): PrivateReservationContextResolver {
  return {
    resolve: async () => ({
      sessionId: Buffer.from(action.sessionId, "hex"),
      sourceBudgetNoteId: input.source_budget_note_id,
      sourceAgent: actor.identity,
      networkId: Buffer.alloc(32, 7),
      treasuryController: "CB23C2OYMIDYC7OG2PK6NJFIVCYONYV43ABREOGVTW2LT4C2G53G2CWU",
      approvedProviderRoot: 23n,
      categoryId: 7,
      serviceId: "research-data-service",
      offerReferenceHash: action.offerReferenceHash,
      reservationAmountAtomic: action.amountAtomic,
      providerSppPublicKey: 29n,
      claimDeadlineLedger: 500,
      createdAtUnixMs: 1_700_000_000_000,
      ...overrides,
    }),
  };
}

function runtime(calls: unknown[]): PrivateReservationProofPlanner {
  return {
    prepare: async (request: unknown) => {
      calls.push(request);
      return { input, proof, publicSignals: [1n] };
    },
  } as unknown as PrivateReservationProofPlanner;
}

function delegationResolver(
  overrides: Partial<Awaited<ReturnType<PrivateDelegationContextResolver["resolve"]>>> = {},
): PrivateDelegationContextResolver {
  return {
    resolve: async () => ({
      sessionId: Buffer.from(delegationAction.sessionId, "hex"),
      sourceBudgetNoteId: Buffer.alloc(32, 23),
      sourceAgent: actor.identity,
      networkId: Buffer.alloc(32, 24),
      treasuryController: "CB23C2OYMIDYC7OG2PK6NJFIVCYONYV43ABREOGVTW2LT4C2G53G2CWU",
      childRole: "RESEARCH",
      childOwner: privateDelegation.child_owner,
      childPolicy: privateDelegation.child_policy,
      delegatedAmountAtomic: delegationAction.amountAtomic,
      createdAtUnixMs: 1_700_000_000_000,
      ...overrides,
    }),
  };
}

function delegationRuntime(calls: unknown[]): PrivateBudgetDelegationProofPlanner {
  return {
    prepare: async (request: unknown) => {
      calls.push(request);
      return {
        operationId: Buffer.alloc(32, 25),
        sessionId: Buffer.from(delegationAction.sessionId, "hex"),
        sourceNoteId: Buffer.alloc(32, 23),
        delegation: privateDelegation,
        proof,
        publicSignals: [1n],
      };
    },
  } as unknown as PrivateBudgetDelegationProofPlanner;
}

test("verified provider context reaches PrivacyRuntime while private witness material stays behind it", async () => {
  const calls: unknown[] = [];
  const prepared = await new PrivacyRuntimeReservationPlanner(runtime(calls), resolver()).prepareReservation(action, actor);
  assert.equal(calls.length, 1);
  assert.equal(prepared.input, input);
  assert.equal(prepared.proof, proof);
  assert.equal("amountBlinding" in prepared, false);
  assert.equal("voucherSignerSeed" in prepared, false);
  assert.equal(prepared.amountAtomic, action.amountAtomic);
});

test("signed-offer or price substitution is rejected before local proof generation", async () => {
  for (const overrides of [
    { offerReferenceHash: "ff".repeat(32) },
    { reservationAmountAtomic: "99999" },
    { sourceAgent: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBK3M" },
  ]) {
    const calls: unknown[] = [];
    await assert.rejects(
      new PrivacyRuntimeReservationPlanner(runtime(calls), resolver(overrides)).prepareReservation(action, actor),
      PrivatePlanBindingError,
    );
    assert.deepEqual(calls, []);
  }
});

test("verified delegation context reaches the private prover without exposing its opening", async () => {
  const calls: unknown[] = [];
  const prepared = await new PrivacyRuntimeDelegationPlanner(
    delegationRuntime(calls),
    delegationResolver(),
  ).prepareDelegation(delegationAction, actor);
  assert.equal(calls.length, 1);
  assert.equal(prepared.delegation, privateDelegation);
  assert.equal(prepared.operationId.toString("hex"), "19".repeat(32));
  assert.equal("inputBlinding" in prepared, false);
  assert.equal(prepared.amountAtomic, delegationAction.amountAtomic);
});

test("delegation authority substitution is rejected before proof generation", async () => {
  for (const overrides of [
    { delegatedAmountAtomic: "199999" },
    { childRole: "BUILDER" as const },
    { childPolicy: { ...privateDelegation.child_policy, category_mask: 7n } },
    { sourceAgent: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBK3M" },
  ]) {
    const calls: unknown[] = [];
    await assert.rejects(
      new PrivacyRuntimeDelegationPlanner(
        delegationRuntime(calls),
        delegationResolver(overrides),
      ).prepareDelegation(delegationAction, actor),
      PrivatePlanBindingError,
    );
    assert.deepEqual(calls, []);
  }
});

test("private operation lifecycle dispatches exact chain confirmation and abort targets", async () => {
  const calls: unknown[] = [];
  const delegation = {
    ...delegationRuntime(calls),
    confirm: async (input: unknown) => { calls.push(["confirm-delegation", input]); },
    abort: async (operationId: Uint8Array) => { calls.push(["abort-delegation", Buffer.from(operationId)]); },
  } as unknown as PrivateBudgetDelegationProofPlanner;
  const reservation = {
    ...runtime(calls),
    confirm: async (input: unknown) => { calls.push(["confirm-reservation", input]); },
    abort: async (operationId: Uint8Array) => { calls.push(["abort-reservation", Buffer.from(operationId)]); },
  } as unknown as PrivateReservationProofPlanner;
  const planner = new PrivacyRuntimePrivateOperationPlanner({
    delegationRuntime: delegation,
    delegationContext: delegationResolver(),
    reservationRuntime: reservation,
    reservationContext: resolver(),
  });
  const operationId = Buffer.alloc(32, 31);
  const receipt = { transactionHash: "20".repeat(32), ledgerSequence: 777, status: "SUCCESS" as const };

  await planner.confirm({ kind: "DELEGATION", operationId }, receipt);
  await planner.abort({ kind: "RESERVATION", operationId });

  assert.deepEqual(calls, [
    ["confirm-delegation", {
      operationId,
      transactionHash: Buffer.alloc(32, 0x20),
      ledgerSequence: 777,
    }],
    ["abort-reservation", operationId],
  ]);
});
