import { actionsForRole, agentActionSchema, agentRoleSchema, type AgentAction } from "@phloem/agent-runtime";
import { z } from "zod";

import type {
  AgentActor,
  AgentAuthorizer,
  ControlledProvider,
  ContractRejection,
  PreparedContractInvocation,
  ProtocolReadResult,
  ProviderServiceResult,
  StellarSubmitter,
  SubmissionReceipt,
  TreasuryController,
  ProtocolReader,
  TransactionSourceSigner,
} from "./ports.js";

const gatewayRequestSchema = z.object({
  requestId: z.string().regex(/^[0-9a-f]{64}$/u),
  actor: z.object({
    role: agentRoleSchema,
    identity: z.string().regex(/^C[A-Z2-7]{55}$/u),
  }).strict(),
  action: agentActionSchema,
  submit: z.boolean(),
}).strict();

export type GatewayRequest = z.infer<typeof gatewayRequestSchema>;

export type GatewayResult =
  | { readonly kind: "READ"; readonly requestId: string; readonly result: ProtocolReadResult }
  | { readonly kind: "SERVICE"; readonly requestId: string; readonly result: ProviderServiceResult }
  | { readonly kind: "CONTRACT_REJECTED"; readonly requestId: string; readonly rejection: ContractRejection }
  | { readonly kind: "PREPARED"; readonly requestId: string; readonly invocation: PreparedContractInvocation }
  | { readonly kind: "SUBMITTED"; readonly requestId: string; readonly receipt: SubmissionReceipt; readonly simulationHash: string };

export interface ExecutionGatewayPorts {
  readonly reader: ProtocolReader;
  readonly provider: ControlledProvider;
  readonly treasuryController: TreasuryController;
  readonly agentAuthorizer: AgentAuthorizer;
  readonly transactionSourceSigner: TransactionSourceSigner;
  readonly submitter: StellarSubmitter;
}

function assertRoleOwnsAction(actor: AgentActor, action: AgentAction): void {
  if (!actionsForRole(actor.role).includes(action.type)) {
    throw new Error(`${actor.role} cannot request ${action.type}`);
  }
  if ((action.type === "request_service" || action.type === "request_payment") && action.agent !== actor.role) {
    throw new Error("action agent does not match authenticated actor");
  }
  if (action.type === "delegate_authority" && actor.role !== "SUPERVISOR") {
    throw new Error("only the Supervisor agent may request child delegation");
  }
}

export class ExecutionGateway {
  readonly #ports: ExecutionGatewayPorts;

  constructor(ports: ExecutionGatewayPorts) {
    this.#ports = ports;
  }

  async execute(input: unknown): Promise<GatewayResult> {
    const request = gatewayRequestSchema.parse(input);
    assertRoleOwnsAction(request.actor, request.action);

    switch (request.action.type) {
      case "get_budget":
        return { kind: "READ", requestId: request.requestId, result: await this.#ports.reader.getBudget(request.action, request.actor) };
      case "get_agent_state":
        return { kind: "READ", requestId: request.requestId, result: await this.#ports.reader.getAgentState(request.action, request.actor) };
      case "request_service":
        return { kind: "SERVICE", requestId: request.requestId, result: await this.#ports.provider.request(request.action, request.actor) };
      case "delegate_authority":
      case "request_payment":
        return this.#executeFinancial(request.requestId, request.action, request.actor, request.submit);
    }
  }

  async #executeFinancial(
    requestId: string,
    action: Extract<AgentAction, { type: "delegate_authority" | "request_payment" }>,
    actor: AgentActor,
    submit: boolean,
  ): Promise<GatewayResult> {
    const simulation = await this.#ports.treasuryController.simulate(action, actor);
    if (!simulation.accepted) return { kind: "CONTRACT_REJECTED", requestId, rejection: simulation };
    if (!submit) {
      await this.#ports.treasuryController.abort(simulation);
      return { kind: "PREPARED", requestId, invocation: simulation };
    }

    let submitted = false;
    try {
      const authorizedTransactionXdr = await this.#ports.agentAuthorizer.authorize(
        simulation.assembledTransactionJson,
        simulation.requiredAuthorizer,
      );
      const signed = await this.#ports.transactionSourceSigner.sign(authorizedTransactionXdr);
      const receipt = await this.#ports.submitter.submit(signed);
      submitted = true;
      await this.#ports.treasuryController.confirm(simulation, receipt);
      return { kind: "SUBMITTED", requestId, receipt, simulationHash: simulation.simulationHash };
    } catch (error: unknown) {
      if (!submitted) await this.#ports.treasuryController.abort(simulation).catch(() => undefined);
      throw error;
    }
  }
}
