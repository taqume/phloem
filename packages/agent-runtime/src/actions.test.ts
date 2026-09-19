import assert from "node:assert/strict";
import test from "node:test";

import { parseAgentAction, toolsForRole } from "./actions.js";

const sessionId = "01".repeat(32);
const nodeId = "02".repeat(32);

test("role tool surfaces exclude authority the role does not own", () => {
  assert.deepEqual(toolsForRole("SUPERVISOR").map((tool) => tool.function.name), [
    "delegate_authority",
    "get_budget",
    "get_agent_state",
  ]);
  assert.equal(toolsForRole("RESEARCH").some((tool) => tool.function.name === "delegate_authority"), false);
});

test("unknown fields and secret-shaped output are rejected", () => {
  assert.throws(() => parseAgentAction("RESEARCH", "get_budget", JSON.stringify({
    sessionId,
    nodeId,
    rationale: "Read current authority.",
    privateKey: "must-not-pass",
  })));
});

test("builder cannot request a delegation", () => {
  assert.throws(() => parseAgentAction("BUILDER", "delegate_authority", "{}"), /not available/u);
});
