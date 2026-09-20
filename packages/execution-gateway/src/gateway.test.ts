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
        assembledTransactionJson: "assembled-json",
        simulationHash: "04".repeat(32),
        latestLedger: 10,
        requiredAuthorizer: { kind: "AGENT_SMART_ACCOUNT", identity: actor.identity },
        privateStateTransition: { kind: "RESERVATION", operationId: "09".repeat(32) },
      }),
      confirm: async () => undefined,
      abort: async () => undefined,
    },
    agentAuthorizer: { authorize: async () => "authorized-unsigned-xdr" },
    transactionSourceSigner: { sign: async () => "signed-xdr" },
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
    treasuryController: {
      simulate: async () => { simulated = true; throw new Error("unreachable"); },
      confirm: async () => undefined,
      abort: async () => undefined,
    },
  }));
  await assert.rejects(gateway.execute({ requestId, actor, action: { ...payment(), agent: "RESEARCH" }, submit: true }), /does not match/u);
  assert.equal(simulated, false);
});

test("economic-policy rejection comes from contract simulation and never reaches signer", async () => {
  let authorized = false;
  let sourceSigned = false;
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
      confirm: async () => undefined,
      abort: async () => undefined,
    },
    agentAuthorizer: { authorize: async () => { authorized = true; return "unreachable"; } },
    transactionSourceSigner: { sign: async () => { sourceSigned = true; return "unreachable"; } },
    submitter: { submit: async () => { submitted = true; throw new Error("unreachable"); } },
  }));
  const result = await gateway.execute({ requestId, actor, action: payment("999999"), submit: true });
  assert.equal(result.kind, "CONTRACT_REJECTED");
  if (result.kind === "CONTRACT_REJECTED") assert.equal(result.rejection.contractErrorCode, "BudgetExceeded");
  assert.equal(authorized, false);
  assert.equal(sourceSigned, false);
  assert.equal(submitted, false);
});

test("accepted financial action preserves simulate-sign-submit ordering", async () => {
  const calls: string[] = [];
  const base = ports();
  const gateway = new ExecutionGateway(ports({
    treasuryController: {
      simulate: async (action, actionActor) => { calls.push("simulate"); return base.treasuryController.simulate(action, actionActor); },
      confirm: async (invocation, receipt) => { calls.push("confirm"); return base.treasuryController.confirm(invocation, receipt); },
      abort: async (invocation) => base.treasuryController.abort(invocation),
    },
    agentAuthorizer: { authorize: async () => { calls.push("authorize"); return "authorized-unsigned-xdr"; } },
    transactionSourceSigner: { sign: async () => { calls.push("source-sign"); return "signed-xdr"; } },
    submitter: { submit: async () => { calls.push("submit"); return { transactionHash: "05".repeat(32), ledgerSequence: 11, status: "SUCCESS" }; } },
  }));
  const result = await gateway.execute({ requestId, actor, action: payment(), submit: true });
  assert.equal(result.kind, "SUBMITTED");
  assert.deepEqual(calls, ["simulate", "authorize", "source-sign", "submit", "confirm"]);
});

test("agent authorization is bound to the simulated Smart Account identity", async () => {
  let authorizedIdentity = "";
  const gateway = new ExecutionGateway(ports({
    agentAuthorizer: {
      authorize: async (_assembled, authorizer) => {
        authorizedIdentity = authorizer.identity;
        return "authorized-unsigned-xdr";
      },
    },
  }));

  const result = await gateway.execute({ requestId, actor, action: payment(), submit: true });
  assert.equal(result.kind, "SUBMITTED");
  assert.equal(authorizedIdentity, actor.identity);
});

test("dry-run simulation releases its encrypted private-state hold", async () => {
  let aborted = false;
  const gateway = new ExecutionGateway(ports({
    treasuryController: {
      ...ports().treasuryController,
      abort: async () => { aborted = true; },
    },
  }));
  const result = await gateway.execute({ requestId, actor, action: payment(), submit: false });
  assert.equal(result.kind, "PREPARED");
  assert.equal(aborted, true);
});

test("pre-submission failure aborts the staged transition", async () => {
  let aborted = false;
  let confirmed = false;
  const gateway = new ExecutionGateway(ports({
    treasuryController: {
      ...ports().treasuryController,
      confirm: async () => { confirmed = true; },
      abort: async () => { aborted = true; },
    },
    agentAuthorizer: { authorize: async () => { throw new Error("intentional authorization failure"); } },
  }));
  await assert.rejects(
    gateway.execute({ requestId, actor, action: payment(), submit: true }),
    /intentional authorization failure/u,
  );
  assert.equal(aborted, true);
  assert.equal(confirmed, false);
});

test("post-submission reconciliation failure leaves the private source held", async () => {
  let aborted = false;
  const gateway = new ExecutionGateway(ports({
    treasuryController: {
      ...ports().treasuryController,
      confirm: async () => { throw new Error("intentional reconciliation failure"); },
      abort: async () => { aborted = true; },
    },
  }));
  await assert.rejects(
    gateway.execute({ requestId, actor, action: payment(), submit: true }),
    /intentional reconciliation failure/u,
  );
  assert.equal(aborted, false);
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
