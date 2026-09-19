import assert from "node:assert/strict";
import test from "node:test";

import type { AgentAction } from "@phloem/agent-runtime";

import { ExecutionGateway, type ExecutionGatewayPorts } from "./gateway.js";

const sessionId = "01".repeat(32);
const requestId = "02".repeat(32);
const actor = { role: "BUILDER" as const, identity: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4" };

function ports(overrides: Partial<ExecutionGatewayPorts> = {}): ExecutionGatewayPorts {
  return {
    reader: {
      getBudget: async () => ({ ledgerSequence: 10, value: { remaining: "5" } }),
      getAgentState: async () => ({ ledgerSequence: 10, value: { state: "ACTIVE" } }),
    },
    provider: {
      request: async (action) => ({
        requestId: action.requestId,
        responseHash: "03".repeat(32),
        signedUsageEvidence: "usage-evidence",
        signedServiceOffer: "service-offer",
      }),
    },
    treasuryController: {
      simulate: async () => ({
        accepted: true,
        unsignedTransactionXdr: "unsigned-xdr",
        simulationHash: "04".repeat(32),
        latestLedger: 10,
        requiredSigner: { kind: "AGENT_SMART_ACCOUNT", identity: actor.identity },
      }),
    },
    signer: { sign: async () => "signed-xdr" },
    submitter: { submit: async () => ({ transactionHash: "05".repeat(32), ledgerSequence: 11, status: "SUCCESS" }) },
    ...overrides,
  };
}

function payment(amountAtomic = "10"): Extract<AgentAction, { type: "request_payment" }> {
  return {
    type: "request_payment",
    sessionId,
    agent: "BUILDER",
    serviceId: "research-data-service",
    offerReferenceHash: "06".repeat(32),
    amountAtomic,
    rationale: "Request the offered service payment.",
  };
}

test("schema and actor mismatch reject before any protocol port runs", async () => {
  let simulated = false;
  const gateway = new ExecutionGateway(ports({
    treasuryController: { simulate: async () => { simulated = true; throw new Error("unreachable"); } },
  }));
  await assert.rejects(gateway.execute({ requestId, actor, action: { ...payment(), agent: "RESEARCH" }, submit: true }), /does not match/u);
  assert.equal(simulated, false);
});

test("economic-policy rejection comes from contract simulation and never reaches signer", async () => {
  let signed = false;
  let submitted = false;
  const gateway = new ExecutionGateway(ports({
    treasuryController: {
      simulate: async () => ({
        accepted: false,
        source: "TREASURY_CONTROLLER_SIMULATION",
        contractErrorCode: "BudgetExceeded",
        diagnosticHash: "07".repeat(32),
        latestLedger: 10,
      }),
    },
    signer: { sign: async () => { signed = true; return "unreachable"; } },
    submitter: { submit: async () => { submitted = true; throw new Error("unreachable"); } },
  }));
  const result = await gateway.execute({ requestId, actor, action: payment("999999"), submit: true });
  assert.equal(result.kind, "CONTRACT_REJECTED");
  if (result.kind === "CONTRACT_REJECTED") assert.equal(result.rejection.contractErrorCode, "BudgetExceeded");
  assert.equal(signed, false);
  assert.equal(submitted, false);
});

test("accepted financial action preserves simulate-sign-submit ordering", async () => {
  const calls: string[] = [];
  const base = ports();
  const gateway = new ExecutionGateway(ports({
    treasuryController: { simulate: async (action, actionActor) => { calls.push("simulate"); return base.treasuryController.simulate(action, actionActor); } },
    signer: { sign: async () => { calls.push("sign"); return "signed-xdr"; } },
    submitter: { submit: async () => { calls.push("submit"); return { transactionHash: "05".repeat(32), ledgerSequence: 11, status: "SUCCESS" }; } },
  }));
  const result = await gateway.execute({ requestId, actor, action: payment(), submit: true });
  assert.equal(result.kind, "SUBMITTED");
  assert.deepEqual(calls, ["simulate", "sign", "submit"]);
});

test("service action routes only to the controlled provider", async () => {
  let providerCalls = 0;
  const gateway = new ExecutionGateway(ports({
    provider: { request: async (action) => { providerCalls += 1; return {
      requestId: action.requestId,
      responseHash: "03".repeat(32),
      signedUsageEvidence: "usage-evidence",
      signedServiceOffer: "service-offer",
    }; } },
  }));
  const result = await gateway.execute({
    requestId,
    actor,
    submit: false,
    action: {
      type: "request_service",
      sessionId,
      agent: "BUILDER",
      serviceId: "research-data-service",
      requestId: "08".repeat(32),
      query: "Attempt the policy-bounded build request.",
      rationale: "Exercise the controlled provider.",
    },
  });
  assert.equal(result.kind, "SERVICE");
  assert.equal(providerCalls, 1);
});
