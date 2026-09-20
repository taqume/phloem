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
