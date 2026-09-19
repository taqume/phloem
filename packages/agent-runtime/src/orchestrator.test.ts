import assert from "node:assert/strict";
import test from "node:test";

import type { GenerateActionRequest, GeneratedAction, ModelProvider } from "./model-provider.js";
import { runDelegatedAgents } from "./orchestrator.js";

const sessionId = "01".repeat(32);

function context(agent: "RESEARCH" | "BUILDER") {
  return {
    sessionId,
    agent,
    agentId: agent.toLowerCase(),
    task: `${agent} task`,
    policySummary: "Policy is intentionally narrow.",
    protocolState: {
      ledgerSequence: 123,
      lifecycle: "ACTIVE" as const,
      nodeId: "04".repeat(32),
      remainingBudgetAtomic: "1000000",
      branchFrozen: false,
      settlementMode: "PRIVATE" as const,
    },
  } as const;
}

test("child agents cannot run before both financial delegations are confirmed", async () => {
  const provider: ModelProvider = { generateAction: async () => { throw new Error("must not run"); } };
  await assert.rejects(
    runDelegatedAgents(provider, { research: context("RESEARCH"), builder: context("BUILDER") }, []),
    /both child delegations/u,
  );
});

test("confirmed independent child agents start in parallel", async () => {
  const started: string[] = [];
  const pending = new Map<string, (value: GeneratedAction) => void>();
  const provider: ModelProvider = {
    generateAction(request: GenerateActionRequest) {
      started.push(request.role);
      return new Promise((resolve) => pending.set(request.role, resolve));
    },
  };
  const run = runDelegatedAgents(provider, { research: context("RESEARCH"), builder: context("BUILDER") }, [
    { childAgent: "RESEARCH", status: "CONFIRMED", transactionHash: "02".repeat(32) },
    { childAgent: "BUILDER", status: "CONFIRMED", transactionHash: "03".repeat(32) },
  ]);
  await Promise.resolve();
  assert.deepEqual(started, ["RESEARCH", "BUILDER"]);

  for (const role of ["RESEARCH", "BUILDER"] as const) {
    pending.get(role)?.({
      provider: "fake",
      model: "fake",
      toolCallId: role,
      action: {
        type: "get_agent_state",
        sessionId,
        agent: role,
        rationale: "Inspect state.",
      },
    });
  }
  const result = await run;
  assert.equal(result.research.action.type, "get_agent_state");
  assert.equal(result.builder.action.type, "get_agent_state");
});
