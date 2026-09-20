import { z } from "zod";

import { delegateAuthorityActionSchema, type AgentAction } from "./actions.js";
import { agentContextSchema, type AgentContext, type GeneratedAction, type ModelProvider } from "./model-provider.js";
import { toolsForRole } from "./actions.js";

const confirmedDelegationSchema = z.object({
  childAgent: z.enum(["RESEARCH", "BUILDER"]),
  status: z.literal("CONFIRMED"),
  transactionHash: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();

export type ConfirmedDelegation = z.infer<typeof confirmedDelegationSchema>;

function withTask(context: AgentContext, task: string): AgentContext {
  return agentContextSchema.parse({ ...context, task });
}

export async function planChildDelegations(
  provider: ModelProvider,
  supervisorContext: AgentContext,
): Promise<readonly [GeneratedAction, GeneratedAction]> {
  if (supervisorContext.agent !== "SUPERVISOR") throw new Error("supervisor context required");
  const tools = toolsForRole("SUPERVISOR");

  const [research, builder] = await Promise.all([
    provider.generateAction({
      role: "SUPERVISOR",
      context: withTask(supervisorContext, "Propose bounded authority for the Research child. remainingDelegationDepth must be 0."),
      tools,
    }),
    provider.generateAction({
      role: "SUPERVISOR",
      context: withTask(supervisorContext, "Propose narrower bounded authority for the Builder child. remainingDelegationDepth must be 0."),
      tools,
    }),
  ]);
  const researchDelegation = delegateAuthorityActionSchema.parse(research.action);
  if (researchDelegation.childAgent !== "RESEARCH") throw new Error("expected Research delegation");

  const builderDelegation = delegateAuthorityActionSchema.parse(builder.action);
  if (builderDelegation.childAgent !== "BUILDER") throw new Error("expected Builder delegation");

  return [research, builder];
}

function assertConfirmedDelegations(receipts: readonly ConfirmedDelegation[]): void {
  const parsed = receipts.map((receipt) => confirmedDelegationSchema.parse(receipt));
  const confirmed = new Set(parsed.map((receipt) => receipt.childAgent));
  if (confirmed.size !== 2 || !confirmed.has("RESEARCH") || !confirmed.has("BUILDER")) {
    throw new Error("both child delegations must be confirmed before parallel agent execution");
  }
}

export async function runDelegatedAgents(
  provider: ModelProvider,
  contexts: Readonly<{ research: AgentContext; builder: AgentContext }>,
  receipts: readonly ConfirmedDelegation[],
): Promise<Readonly<{ research: GeneratedAction; builder: GeneratedAction }>> {
  assertConfirmedDelegations(receipts);
  if (contexts.research.agent !== "RESEARCH" || contexts.builder.agent !== "BUILDER") {
    throw new Error("child agent context mismatch");
  }

  const researchPromise = provider.generateAction({
    role: "RESEARCH",
    context: agentContextSchema.parse(contexts.research),
    tools: toolsForRole("RESEARCH"),
  });
  const builderPromise = provider.generateAction({
    role: "BUILDER",
    context: agentContextSchema.parse(contexts.builder),
    tools: toolsForRole("BUILDER"),
  });
  const [research, builder] = await Promise.all([researchPromise, builderPromise]);
  return { research, builder };
}

export function actionOnly(result: GeneratedAction): AgentAction {
  return result.action;
}
