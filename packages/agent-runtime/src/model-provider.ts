import { z } from "zod";

import { agentRoleSchema, type AgentAction, type AgentRole, type ModelToolDefinition } from "./actions.js";
import { bytes32HexSchema, u64DecimalSchema } from "@phloem/protocol-types";

const publicTextSchema = z.string().refine(
  (value) => !/(?:nvapi-[A-Za-z0-9_-]+|\bS[A-Z2-7]{55}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----)/u.test(value),
  "agent context contains secret-shaped material",
);

export const agentContextSchema = z.object({
  sessionId: bytes32HexSchema,
  agent: agentRoleSchema,
  agentId: z.string().min(1).max(120),
  task: publicTextSchema.min(1).max(2_000),
  policySummary: publicTextSchema.min(1).max(2_000),
  protocolState: z.object({
    ledgerSequence: z.number().int().positive(),
    lifecycle: z.enum(["DRAFT", "FUNDING", "ACTIVE", "DRAINING", "CLOSED", "CANCELLED"]),
    nodeId: bytes32HexSchema,
    remainingBudgetAtomic: u64DecimalSchema,
    branchFrozen: z.boolean(),
    settlementMode: z.enum(["STANDARD", "PRIVATE"]),
  }).strict(),
}).strict();

export type AgentContext = z.infer<typeof agentContextSchema>;

export interface GenerateActionRequest {
  readonly role: AgentRole;
  readonly context: AgentContext;
  readonly tools: readonly ModelToolDefinition[];
}

export interface GeneratedAction {
  readonly action: AgentAction;
  readonly model: string;
  readonly provider: string;
  readonly toolCallId: string;
}

export interface ModelProvider {
  generateAction(request: GenerateActionRequest): Promise<GeneratedAction>;
}

export const AGENT_SYSTEM_PROMPT = `You are a Phloem demo agent. Decide what action you want to request, then emit exactly one provided tool call. Phloem—not you—validates policy, constructs transactions, selects signers, and submits to Stellar. Never request, reveal, infer, or handle private keys, wallet seeds, signing secrets, witnesses, raw provider secrets, or API keys. Do not claim an action succeeded; you only propose a typed action.`;
