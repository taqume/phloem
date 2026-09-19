import { bytes32HexSchema, u64DecimalSchema } from "@phloem/protocol-types";
import { z } from "zod";

export const agentRoleSchema = z.enum(["SUPERVISOR", "RESEARCH", "BUILDER"]);
export type AgentRole = z.infer<typeof agentRoleSchema>;

const baseActionShape = {
  sessionId: bytes32HexSchema,
  rationale: z.string().min(1).max(500),
} as const;

export const delegateAuthorityActionSchema = z.object({
  type: z.literal("delegate_authority"),
  ...baseActionShape,
  childAgent: z.enum(["RESEARCH", "BUILDER"]),
  amountAtomic: u64DecimalSchema,
  categoryMask: u64DecimalSchema,
  allowedActionsMask: u64DecimalSchema,
  expiresAtLedger: z.number().int().positive(),
  remainingDelegationDepth: z.literal(0),
}).strict();

export const requestServiceActionSchema = z.object({
  type: z.literal("request_service"),
  ...baseActionShape,
  agent: z.enum(["RESEARCH", "BUILDER"]),
  serviceId: z.literal("research-data-service"),
  requestId: bytes32HexSchema,
  query: z.string().min(1).max(500),
}).strict();

export const requestPaymentActionSchema = z.object({
  type: z.literal("request_payment"),
  ...baseActionShape,
  agent: z.enum(["RESEARCH", "BUILDER"]),
  serviceId: z.literal("research-data-service"),
  offerReferenceHash: bytes32HexSchema,
  amountAtomic: u64DecimalSchema,
}).strict();

export const getBudgetActionSchema = z.object({
  type: z.literal("get_budget"),
  ...baseActionShape,
  nodeId: bytes32HexSchema,
}).strict();

export const getAgentStateActionSchema = z.object({
  type: z.literal("get_agent_state"),
  ...baseActionShape,
  agent: agentRoleSchema,
}).strict();

export const agentActionSchema = z.discriminatedUnion("type", [
  delegateAuthorityActionSchema,
  requestServiceActionSchema,
  requestPaymentActionSchema,
  getBudgetActionSchema,
  getAgentStateActionSchema,
]);

export type AgentAction = z.infer<typeof agentActionSchema>;
export type AgentActionName = AgentAction["type"];

const actionSchemas = {
  delegate_authority: delegateAuthorityActionSchema,
  request_service: requestServiceActionSchema,
  request_payment: requestPaymentActionSchema,
  get_budget: getBudgetActionSchema,
  get_agent_state: getAgentStateActionSchema,
} as const;

const actionArgumentSchemas = {
  delegate_authority: delegateAuthorityActionSchema.omit({ type: true }),
  request_service: requestServiceActionSchema.omit({ type: true }),
  request_payment: requestPaymentActionSchema.omit({ type: true }),
  get_budget: getBudgetActionSchema.omit({ type: true }),
  get_agent_state: getAgentStateActionSchema.omit({ type: true }),
} as const;

const actionDescriptions: Record<AgentActionName, string> = {
  delegate_authority: "Request a bounded child-agent delegation. The gateway and contract decide whether it is authorized.",
  request_service: "Request the single approved Research Data Service through the execution gateway.",
  request_payment: "Request settlement for a provider offer. Never constructs, signs, or submits a transaction.",
  get_budget: "Read the current budget state for a known node.",
  get_agent_state: "Read the current protocol-visible state of an agent.",
};

const allowedActions: Record<AgentRole, readonly AgentActionName[]> = {
  SUPERVISOR: ["delegate_authority", "get_budget", "get_agent_state"],
  RESEARCH: ["request_service", "request_payment", "get_budget", "get_agent_state"],
  BUILDER: ["request_service", "request_payment", "get_budget", "get_agent_state"],
};

export interface ModelToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: AgentActionName;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export function actionsForRole(role: AgentRole): readonly AgentActionName[] {
  return allowedActions[role];
}

export function parseAgentAction(role: AgentRole, name: string, rawArguments: string): AgentAction {
  if (!allowedActions[role].includes(name as AgentActionName)) {
    throw new Error(`action ${name} is not available to ${role}`);
  }
  const schema = actionSchemas[name as AgentActionName];
  if (!schema) throw new Error(`unknown agent action: ${name}`);
  const parsed = JSON.parse(rawArguments) as unknown;
  return schema.parse({ ...(typeof parsed === "object" && parsed !== null ? parsed : {}), type: name });
}

export function toolsForRole(role: AgentRole): readonly ModelToolDefinition[] {
  return allowedActions[role].map((name) => {
    const parameters = z.toJSONSchema(actionArgumentSchemas[name], {
      target: "draft-7",
      unrepresentable: "throw",
    }) as Record<string, unknown>;
    delete parameters.$schema;
    return {
      type: "function" as const,
      function: { name, description: actionDescriptions[name], parameters },
    };
  });
}
