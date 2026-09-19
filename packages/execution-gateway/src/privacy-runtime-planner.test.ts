import assert from "node:assert/strict";
import test from "node:test";

import type { AgentAction } from "@phloem/agent-runtime";
import type { PrivateReservationProofPlanner } from "@phloem/privacy-runtime";
import type { Groth16Proof, PrivateReservationInput } from "@phloem/treasury-controller-client";

import {
  PrivacyRuntimeReservationPlanner,
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
