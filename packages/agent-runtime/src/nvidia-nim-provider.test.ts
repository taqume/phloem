import assert from "node:assert/strict";
import test from "node:test";

import { toolsForRole } from "./actions.js";
import { MissingNvidiaApiKeyError, NVIDIA_NIM_ENDPOINT, NVIDIA_PRIMARY_MODEL, NvidiaNimProvider } from "./nvidia-nim-provider.js";

const context = {
  sessionId: "01".repeat(32),
  agent: "RESEARCH" as const,
  agentId: "research-1",
  task: "Inspect the current budget.",
  policySummary: "Read access is permitted.",
  protocolState: {
    ledgerSequence: 123,
    lifecycle: "ACTIVE" as const,
    nodeId: "02".repeat(32),
    remainingBudgetAtomic: "1000000",
    branchFrozen: false,
    settlementMode: "PRIVATE" as const,
  },
};

test("live provider refuses to run without the user-supplied server secret", async () => {
  const previous = process.env.NVIDIA_API_KEY;
  delete process.env.NVIDIA_API_KEY;
  try {
    await assert.rejects(
      new NvidiaNimProvider().generateAction({ role: "RESEARCH", context, tools: toolsForRole("RESEARCH") }),
      MissingNvidiaApiKeyError,
    );
  } finally {
    if (previous !== undefined) process.env.NVIDIA_API_KEY = previous;
  }
});

test("NIM request stays server-side and accepts exactly one typed tool call", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const provider = new NvidiaNimProvider({
    apiKey: "test-only-placeholder",
    fetch: async (input, init) => {
      requestedUrl = input.toString();
      requestedInit = init;
      return Response.json({
        choices: [{ message: { tool_calls: [{
          id: "call-1",
          type: "function",
          function: {
            name: "get_budget",
            arguments: JSON.stringify({
              sessionId: context.sessionId,
              nodeId: context.protocolState.nodeId,
              rationale: "Read current authority.",
            }),
          },
        }] } }],
      });
    },
  });

  const result = await provider.generateAction({ role: "RESEARCH", context, tools: toolsForRole("RESEARCH") });
  assert.equal(requestedUrl, NVIDIA_NIM_ENDPOINT);
  assert.equal(new Headers(requestedInit?.headers).get("authorization"), "Bearer test-only-placeholder");
  const body = JSON.parse(String(requestedInit?.body)) as { model: string; tool_choice: string };
  assert.equal(body.model, NVIDIA_PRIMARY_MODEL);
  assert.equal(body.tool_choice, "required");
  assert.equal(result.action.type, "get_budget");
});
