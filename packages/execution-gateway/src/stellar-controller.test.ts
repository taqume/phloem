import assert from "node:assert/strict";
import test from "node:test";

import type { AgentAction } from "@phloem/agent-runtime";
import type { Client, contract, rpc } from "@phloem/treasury-controller-client";

import {
  GeneratedTreasuryControllerAdapter,
  type ControllerInvocationBuilder,
  UnexpectedControllerAuthorizationError,
} from "./stellar-controller.js";

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
  rationale: "Open the bounded private payment path.",
};

function successSimulation(latestLedger = 123): rpc.Api.SimulateTransactionSuccessResponse {
  return {
    _parsed: true,
    events: [],
    id: "simulation",
    latestLedger,
    minResourceFee: "100",
    transactionData: {} as never,
  };
}

function transaction(overrides: Partial<contract.AssembledTransaction<unknown>> = {}) {
  return {
    simulation: successSimulation(),
    needsNonInvokerSigningBy: () => [actor.identity],
    toJson: () => "{\"tx\":\"assembled\"}",
    ...overrides,
  } as contract.AssembledTransaction<unknown>;
}

function adapter(tx: contract.AssembledTransaction<unknown>) {
  const invocations: ControllerInvocationBuilder = {
    build: async () => ({
      transaction: tx,
      privateOperation: { kind: "RESERVATION", operationId: Buffer.alloc(32, 9) },
    }),
    confirm: async () => undefined,
    abort: async () => undefined,
  };
  return new GeneratedTreasuryControllerAdapter({} as Client, invocations);
}

test("successful simulation preserves assembled auth entries for the Smart Account", async () => {
  const result = await adapter(transaction()).simulate(action, actor);
  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  assert.equal(result.assembledTransactionJson, "{\"tx\":\"assembled\"}");
  assert.equal(result.requiredAuthorizer.identity, actor.identity);
  assert.equal(result.latestLedger, 123);
  assert.match(result.simulationHash, /^[0-9a-f]{64}$/u);
});

test("known TreasuryController errors become hashed contract-origin rejections", async () => {
  const simulation: rpc.Api.SimulateTransactionErrorResponse = {
    _parsed: true,
    events: [],
    id: "simulation",
    latestLedger: 124,
    error: "HostError: Error(Contract, #24)",
  };
  const result = await adapter(transaction({ simulation })).simulate(action, actor);
  assert.equal(result.accepted, false);
  if (result.accepted) return;
  assert.equal(result.contractErrorCode, "InvalidProof");
  assert.equal(result.latestLedger, 124);
  assert.match(result.diagnosticHash, /^[0-9a-f]{64}$/u);
});

test("simulation rejects missing, extra, or substituted financial authorizers", async () => {
  for (const requiredAddresses of [[], [actor.identity, "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"], ["GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"]]) {
    await assert.rejects(
      adapter(transaction({ needsNonInvokerSigningBy: () => requiredAddresses })).simulate(action, actor),
      UnexpectedControllerAuthorizationError,
    );
  }
});
