import { createHash } from "node:crypto";

import type { AgentAction } from "@phloem/agent-runtime";
import {
  Client,
  Errors,
  contract,
  rpc,
} from "@phloem/treasury-controller-client";

import type {
  AgentActor,
  ContractSimulation,
  TreasuryController,
} from "./ports.js";

type FinancialAction = Extract<AgentAction, { type: "delegate_authority" | "request_payment" }>;
type ControllerTransaction = contract.AssembledTransaction<unknown>;

export interface ControllerInvocationBuilder {
  build(client: Client, action: FinancialAction, actor: AgentActor): Promise<ControllerTransaction>;
}

export class UnexpectedControllerAuthorizationError extends Error {
  constructor(readonly requiredAddresses: readonly string[]) {
    super("simulated invocation requested an unexpected authorization set");
    this.name = "UnexpectedControllerAuthorizationError";
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function contractError(error: string): { code: string; diagnosticHash: string } | undefined {
  const match = /Error\(Contract, #(\d+)\)/u.exec(error);
  if (!match?.[1]) return undefined;
  const numericCode = Number(match[1]);
  const descriptor = Errors[numericCode as keyof typeof Errors];
  if (!descriptor) return undefined;
  return { code: descriptor.message, diagnosticHash: digest(error) };
}

export class GeneratedTreasuryControllerAdapter implements TreasuryController {
  readonly #client: Client;
  readonly #invocations: ControllerInvocationBuilder;

  constructor(client: Client, invocations: ControllerInvocationBuilder) {
    this.#client = client;
    this.#invocations = invocations;
  }

  async simulate(action: FinancialAction, actor: AgentActor): Promise<ContractSimulation> {
    const transaction = await this.#invocations.build(this.#client, action, actor);
    const simulation = transaction.simulation;
    if (!simulation) throw new Error("generated controller call did not run RPC simulation");

    if (rpc.Api.isSimulationError(simulation)) {
      const rejection = contractError(simulation.error);
      if (!rejection) throw new Error("controller simulation failed without a recognized contract error");
      return {
        accepted: false,
        source: "TREASURY_CONTROLLER_SIMULATION",
        contractErrorCode: rejection.code,
        diagnosticHash: rejection.diagnosticHash,
        latestLedger: simulation.latestLedger,
      };
    }

    if (rpc.Api.isSimulationRestore(simulation)) {
      throw new Error("controller invocation requires an explicit footprint restoration step");
    }

    const requiredAddresses = transaction.needsNonInvokerSigningBy();
    if (requiredAddresses.length !== 1 || requiredAddresses[0] !== actor.identity) {
      throw new UnexpectedControllerAuthorizationError(requiredAddresses);
    }

    const assembledTransactionJson = transaction.toJson();
    return {
      accepted: true,
      assembledTransactionJson,
      simulationHash: digest(assembledTransactionJson),
      latestLedger: simulation.latestLedger,
      requiredAuthorizer: {
        kind: "AGENT_SMART_ACCOUNT",
        identity: actor.identity,
      },
    };
  }
}
