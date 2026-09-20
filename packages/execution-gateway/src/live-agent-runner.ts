import { createHash } from "node:crypto";

import {
  planChildDelegations,
  runDelegatedAgents,
  type AgentContext,
  type AgentRole,
  type ConfirmedDelegation,
  type GeneratedAction,
  type ModelProvider,
} from "@phloem/agent-runtime";

import type { GatewayRequest, GatewayResult } from "./gateway.js";

export interface GatewayExecutor {
  execute(input: unknown): Promise<GatewayResult>;
}

export interface LiveAgentIdentityMap {
  readonly SUPERVISOR: string;
  readonly RESEARCH: string;
  readonly BUILDER: string;
}

export interface DelegatedAgentContexts {
  readonly research: AgentContext;
  readonly builder: AgentContext;
}

export interface AgentExecutionTrace {
  readonly generated: GeneratedAction;
  readonly gateway: GatewayResult;
}

export interface ExpectedSupervisorDelegation {
  readonly amountAtomic: string;
  readonly categoryMask: string;
  readonly allowedActionsMask: string;
  readonly expiresAtLedger: number;
  readonly remainingDelegationDepth: 0;
}

export interface ExpectedSupervisorPlan {
  readonly RESEARCH: ExpectedSupervisorDelegation;
  readonly BUILDER: ExpectedSupervisorDelegation;
}

function assertExpectedDelegation(
  generated: GeneratedAction,
  expectedRole: "RESEARCH" | "BUILDER",
  expected: ExpectedSupervisorDelegation,
): void {
  const action = generated.action;
  if (action.type !== "delegate_authority"
    || action.childAgent !== expectedRole
    || action.amountAtomic !== expected.amountAtomic
    || action.categoryMask !== expected.categoryMask
    || action.allowedActionsMask !== expected.allowedActionsMask
    || action.expiresAtLedger !== expected.expiresAtLedger
    || action.remainingDelegationDepth !== expected.remainingDelegationDepth) {
    throw new Error(`${expectedRole} model delegation differs from the deterministic bounded plan`);
  }
}

function requestId(generated: GeneratedAction, role: AgentRole): string {
  return createHash("sha256")
    .update("PHLOEM_LIVE_AGENT_GATEWAY_REQUEST_V1", "utf8")
    .update(role, "utf8")
    .update(generated.model, "utf8")
    .update(generated.toolCallId, "utf8")
    .update(JSON.stringify(generated.action), "utf8")
    .digest("hex");
}

function gatewayRequest(
  generated: GeneratedAction,
  role: AgentRole,
  identity: string,
  submitFinancial: boolean,
): GatewayRequest {
  const financial = generated.action.type === "delegate_authority" || generated.action.type === "request_payment";
  return {
    requestId: requestId(generated, role),
    actor: { role, identity },
    action: generated.action,
    submit: financial && submitFinancial,
  };
}

function confirmedDelegation(result: GatewayResult, generated: GeneratedAction): ConfirmedDelegation {
  if (generated.action.type !== "delegate_authority") throw new Error("Supervisor emitted a non-delegation action");
  if (result.kind !== "SUBMITTED") {
    throw new Error(`Supervisor delegation did not reach confirmed submission: ${result.kind}`);
  }
  return {
    childAgent: generated.action.childAgent,
    status: "CONFIRMED",
    transactionHash: result.receipt.transactionHash,
  };
}

/**
 * Live composition coordinator. Models can only emit typed intent; every
 * action crosses the deterministic ExecutionGateway before any side effect.
 */
export class P0LiveAgentRunner {
  readonly #model: ModelProvider;
  readonly #gateway: GatewayExecutor;
  readonly #identities: LiveAgentIdentityMap;

  constructor(input: {
    readonly model: ModelProvider;
    readonly gateway: GatewayExecutor;
    readonly identities: LiveAgentIdentityMap;
  }) {
    this.#model = input.model;
    this.#gateway = input.gateway;
    this.#identities = input.identities;
  }

  async runSupervisorDelegations(
    supervisorContext: AgentContext,
    expected: ExpectedSupervisorPlan,
  ): Promise<Readonly<{
    research: AgentExecutionTrace;
    builder: AgentExecutionTrace;
    confirmations: readonly [ConfirmedDelegation, ConfirmedDelegation];
  }>> {
    const generated = await planChildDelegations(this.#model, supervisorContext);
    assertExpectedDelegation(generated[0], "RESEARCH", expected.RESEARCH);
    assertExpectedDelegation(generated[1], "BUILDER", expected.BUILDER);
    const traces: AgentExecutionTrace[] = [];
    const confirmations: ConfirmedDelegation[] = [];
    for (const action of generated) {
      const gateway = await this.#gateway.execute(
        gatewayRequest(action, "SUPERVISOR", this.#identities.SUPERVISOR, true),
      );
      traces.push({ generated: action, gateway });
      confirmations.push(confirmedDelegation(gateway, action));
    }
    return Object.freeze({
      research: traces[0]!,
      builder: traces[1]!,
      confirmations: [confirmations[0]!, confirmations[1]!] as const,
    });
  }

  async runDelegatedStep(
    contexts: DelegatedAgentContexts,
    confirmations: readonly ConfirmedDelegation[],
    options: { readonly submitFinancial: boolean },
  ): Promise<Readonly<{ research: AgentExecutionTrace; builder: AgentExecutionTrace }>> {
    const generated = await runDelegatedAgents(this.#model, contexts, confirmations);
    const [researchGateway, builderGateway] = await Promise.all([
      this.#gateway.execute(gatewayRequest(
        generated.research,
        "RESEARCH",
        this.#identities.RESEARCH,
        options.submitFinancial,
      )),
      this.#gateway.execute(gatewayRequest(
        generated.builder,
        "BUILDER",
        this.#identities.BUILDER,
        options.submitFinancial,
      )),
    ]);
    return Object.freeze({
      research: { generated: generated.research, gateway: researchGateway },
      builder: { generated: generated.builder, gateway: builderGateway },
    });
  }
}
