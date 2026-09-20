import assert from "node:assert/strict";
import test from "node:test";

import type { AgentContext, GenerateActionRequest, GeneratedAction, ModelProvider } from "@phloem/agent-runtime";

import { P0LiveAgentRunner, type GatewayExecutor } from "./live-agent-runner.js";

const SESSION_ID = "11".repeat(32);
const IDENTITIES = {
  SUPERVISOR: "CBNIEGOFLMJHOGDC5AH4IVHGYYLFU66KYPSQCWX7ZIRJCBEJLGBOQT2Q",
  RESEARCH: "CDVATO436WNXJUOGCEFG4I3IHR6K5Y5WMTQREYXE4P53WN2JQOQAC2HE",
  BUILDER: "CCJGYCLFDXJD2LVIAM2E543JUAWWW3QG3P4U3KXLEWK7L7H2WYMWLTMR",
} as const;
const CONTEXT: AgentContext = {
  sessionId: SESSION_ID,
  agent: "SUPERVISOR",
  agentId: IDENTITIES.SUPERVISOR,
  task: "Delegate exact P0 child authority.",
  policySummary: "Research receives 6000000 and Builder receives 1000000 atomic units.",
  protocolState: {
    ledgerSequence: 1_000,
    lifecycle: "ACTIVE",
    nodeId: "22".repeat(32),
    remainingBudgetAtomic: "10000000",
    branchFrozen: false,
    settlementMode: "PRIVATE",
  },
};
const PLAN = {
  RESEARCH: {
    amountAtomic: "6000000",
    categoryMask: "4",
    allowedActionsMask: "4",
    expiresAtLedger: 2_000,
    remainingDelegationDepth: 0 as const,
  },
  BUILDER: {
    amountAtomic: "1000000",
    categoryMask: "4",
    allowedActionsMask: "4",
    expiresAtLedger: 2_000,
    remainingDelegationDepth: 0 as const,
  },
};

class Model implements ModelProvider {
  readonly #researchAmount: string;

  constructor(researchAmount = "6000000") {
    this.#researchAmount = researchAmount;
  }

  async generateAction(request: GenerateActionRequest): Promise<GeneratedAction> {
    const research = request.context.task.includes("Research");
    return {
      action: {
        type: "delegate_authority",
        sessionId: SESSION_ID,
        childAgent: research ? "RESEARCH" : "BUILDER",
        amountAtomic: research ? this.#researchAmount : "1000000",
        categoryMask: "4",
        allowedActionsMask: "4",
        expiresAtLedger: 2_000,
        remainingDelegationDepth: 0,
        rationale: "Exact bounded P0 authority.",
      },
      model: "live-test-model",
      provider: "test",
      toolCallId: research ? "research-call" : "builder-call",
    };
  }
}

test("Supervisor model output must match the deterministic plan before gateway submission", async () => {
  let gatewayCalls = 0;
  const gateway: GatewayExecutor = {
    execute: async () => {
      gatewayCalls += 1;
      throw new Error("gateway must not run for a widened model proposal");
    },
  };
  const runner = new P0LiveAgentRunner({ model: new Model("9000000"), gateway, identities: IDENTITIES });
  await assert.rejects(
    runner.runSupervisorDelegations(CONTEXT, PLAN),
    /differs from the deterministic bounded plan/u,
  );
  assert.equal(gatewayCalls, 0);
});

test("exact model delegations reach the gateway in Research then Builder order", async () => {
  const calls: unknown[] = [];
  const gateway: GatewayExecutor = {
    execute: async (input) => {
      calls.push(input);
      return {
        kind: "SUBMITTED" as const,
        requestId: "33".repeat(32),
        receipt: {
          transactionHash: (calls.length === 1 ? "44" : "55").repeat(32),
          ledgerSequence: 1_001 + calls.length,
          status: "SUCCESS" as const,
        },
        simulationHash: "66".repeat(32),
      };
    },
  };
  const runner = new P0LiveAgentRunner({ model: new Model(), gateway, identities: IDENTITIES });
  const result = await runner.runSupervisorDelegations(CONTEXT, PLAN);
  assert.equal(calls.length, 2);
  assert.equal(result.research.generated.action.type, "delegate_authority");
  assert.equal(result.builder.generated.action.type, "delegate_authority");
  assert.deepEqual(result.confirmations.map((item) => item.childAgent), ["RESEARCH", "BUILDER"]);
});

test("delegated model intent is checked before it reaches the gateway", async () => {
  let gatewayCalls = 0;
  const model: ModelProvider = {
    generateAction: async () => ({
      action: {
        type: "request_payment",
        sessionId: SESSION_ID,
        agent: "RESEARCH",
        serviceId: "research-data-service",
        offerReferenceHash: "77".repeat(32),
        amountAtomic: "200000",
        rationale: "Request a widened payment.",
      },
      model: "live-test-model",
      provider: "test",
      toolCallId: "payment-call",
    }),
  };
  const runner = new P0LiveAgentRunner({
    model,
    gateway: { execute: async () => { gatewayCalls += 1; throw new Error("unreachable"); } },
    identities: IDENTITIES,
  });
  await assert.rejects(
    runner.runExpectedAgentStep("RESEARCH", { ...CONTEXT, agent: "RESEARCH", agentId: IDENTITIES.RESEARCH }, {
      type: "request_payment",
      sessionId: SESSION_ID,
      agent: "RESEARCH",
      serviceId: "research-data-service",
      offerReferenceHash: "77".repeat(32),
      amountAtomic: "100000",
    }, { submitFinancial: true }),
    /differs from the deterministic live plan/u,
  );
  assert.equal(gatewayCalls, 0);
});

test("exact delegated model intent crosses the gateway under its Smart Account identity", async () => {
  let gatewayInput: unknown;
  let offeredTools: readonly string[] = [];
  const expected = {
    type: "get_budget" as const,
    sessionId: SESSION_ID,
    nodeId: "22".repeat(32),
  };
  const model: ModelProvider = {
    generateAction: async (request) => {
      offeredTools = request.tools.map((tool) => tool.function.name);
      return {
        action: { ...expected, rationale: "Read only the assigned branch." },
        model: "live-test-model",
        provider: "test",
        toolCallId: "read-call",
      };
    },
  };
  const runner = new P0LiveAgentRunner({
    model,
    gateway: {
      execute: async (input) => {
        gatewayInput = input;
        return { kind: "READ", requestId: "88".repeat(32), result: { ledgerSequence: 1_001, value: {} } };
      },
    },
    identities: IDENTITIES,
  });
  const trace = await runner.runExpectedAgentStep(
    "BUILDER",
    { ...CONTEXT, agent: "BUILDER", agentId: IDENTITIES.BUILDER },
    expected,
    { submitFinancial: false },
  );
  assert.equal(trace.gateway.kind, "READ");
  assert.deepEqual(offeredTools, ["get_budget"]);
  assert.deepEqual((gatewayInput as { actor: unknown }).actor, { role: "BUILDER", identity: IDENTITIES.BUILDER });
});
