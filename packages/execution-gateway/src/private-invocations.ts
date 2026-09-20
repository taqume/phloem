import type { AgentAction } from "@phloem/agent-runtime";
import type {
  Client,
  Groth16Proof,
  PrivateDelegationInput,
  PrivateReservationInput,
  contract,
} from "@phloem/treasury-controller-client";

import type { AgentActor } from "./ports.js";
import type { SubmissionReceipt } from "./ports.js";
import type { BuiltControllerInvocation, ControllerInvocationBuilder } from "./stellar-controller.js";

type DelegateAction = Extract<AgentAction, { type: "delegate_authority" }>;
type PaymentAction = Extract<AgentAction, { type: "request_payment" }>;

export interface PreparedPrivateDelegation {
  readonly operationId: Buffer;
  readonly sessionId: Buffer;
  readonly sourceNoteId: Buffer;
  readonly delegation: PrivateDelegationInput;
  readonly proof: Groth16Proof;
  readonly sourceAgent: string;
  readonly childRole: DelegateAction["childAgent"];
  readonly amountAtomic: string;
}

export interface PreparedPrivateReservation {
  readonly operationId: Buffer;
  readonly input: PrivateReservationInput;
  readonly proof: Groth16Proof;
  readonly sourceAgent: string;
  readonly serviceId: PaymentAction["serviceId"];
  readonly offerReferenceHash: string;
  readonly amountAtomic: string;
}

export interface PrivateOperationReference {
  readonly kind: "DELEGATION" | "RESERVATION";
  readonly operationId: Buffer;
}

export interface PrivateOperationPlanner {
  prepareDelegation(action: DelegateAction, actor: AgentActor): Promise<PreparedPrivateDelegation>;
  prepareReservation(action: PaymentAction, actor: AgentActor): Promise<PreparedPrivateReservation>;
  confirm(operation: PrivateOperationReference, receipt: SubmissionReceipt): Promise<void>;
  abort(operation: PrivateOperationReference): Promise<void>;
}

export interface AgentIdentityResolver {
  resolve(sessionId: string, role: DelegateAction["childAgent"]): Promise<string>;
}

export class PrivatePlanBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivatePlanBindingError";
  }
}

function expectEqual(actual: string | number | bigint, expected: string | number | bigint, label: string): void {
  if (actual.toString() !== expected.toString()) {
    throw new PrivatePlanBindingError(`${label} does not match the validated agent action`);
  }
}

function sessionHex(value: Buffer): string {
  if (value.length !== 32) throw new PrivatePlanBindingError("planner returned a non-canonical session id");
  return value.toString("hex");
}

/**
 * Converts privacy-boundary proof artifacts into generated TreasuryController
 * calls. Raw openings, note secrets, proving witnesses and signing keys are not
 * part of this interface.
 */
export class PrivateFinancialInvocationBuilder implements ControllerInvocationBuilder {
  readonly #planner: PrivateOperationPlanner;
  readonly #agentIdentities: AgentIdentityResolver;

  constructor(planner: PrivateOperationPlanner, agentIdentities: AgentIdentityResolver) {
    this.#planner = planner;
    this.#agentIdentities = agentIdentities;
  }

  async build(
    client: Client,
    action: DelegateAction | PaymentAction,
    actor: AgentActor,
  ): Promise<BuiltControllerInvocation> {
    if (action.type === "delegate_authority") {
      const prepared = await this.#planner.prepareDelegation(action, actor);
      const operation = { kind: "DELEGATION", operationId: prepared.operationId } as const;
      try {
        expectEqual(sessionHex(prepared.sessionId), action.sessionId, "session");
        expectEqual(prepared.sourceAgent, actor.identity, "source agent");
        expectEqual(prepared.childRole, action.childAgent, "child role");
        expectEqual(
          prepared.delegation.child_owner,
          await this.#agentIdentities.resolve(action.sessionId, action.childAgent),
          "child agent identity",
        );
        expectEqual(prepared.amountAtomic, action.amountAtomic, "delegated amount");
        expectEqual(prepared.delegation.child_policy.category_mask, action.categoryMask, "category mask");
        expectEqual(
          prepared.delegation.child_policy.allowed_actions_mask,
          action.allowedActionsMask,
          "allowed-actions mask",
        );
        expectEqual(prepared.delegation.child_policy.expiry, action.expiresAtLedger, "expiry");
        expectEqual(
          prepared.delegation.child_policy.remaining_delegation_depth,
          action.remainingDelegationDepth,
          "delegation depth",
        );
        return {
          transaction: await client.delegate_private_budget({
            session_id: prepared.sessionId,
            source_note_id: prepared.sourceNoteId,
            delegation: prepared.delegation,
            proof: prepared.proof,
          }),
          privateOperation: operation,
        };
      } catch (error: unknown) {
        await this.#planner.abort(operation).catch(() => undefined);
        throw error;
      }
    }

    const prepared = await this.#planner.prepareReservation(action, actor);
    const operation = { kind: "RESERVATION", operationId: prepared.operationId } as const;
    try {
      expectEqual(sessionHex(prepared.input.session_id), action.sessionId, "session");
      expectEqual(prepared.sourceAgent, actor.identity, "source agent");
      expectEqual(prepared.serviceId, action.serviceId, "service");
      expectEqual(prepared.offerReferenceHash, action.offerReferenceHash, "offer reference");
      expectEqual(prepared.amountAtomic, action.amountAtomic, "reservation amount");
      return {
        transaction: await client.open_private_reservation({ input: prepared.input, proof: prepared.proof }),
        privateOperation: operation,
      };
    } catch (error: unknown) {
      await this.#planner.abort(operation).catch(() => undefined);
      throw error;
    }
  }

  async confirm(operation: PrivateOperationReference, receipt: SubmissionReceipt): Promise<void> {
    await this.#planner.confirm(operation, receipt);
  }

  async abort(operation: PrivateOperationReference): Promise<void> {
    await this.#planner.abort(operation);
  }
}
