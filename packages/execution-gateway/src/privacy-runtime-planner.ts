import type { AgentAction } from "@phloem/agent-runtime";
import type { PrivateBudgetDelegationProofPlanner } from "@phloem/privacy-runtime/delegation";
import type { PrivateReservationProofPlanner } from "@phloem/privacy-runtime/reservation";
import type { NodePolicy } from "@phloem/treasury-controller-client";

import type { AgentActor } from "./ports.js";
import type { SubmissionReceipt } from "./ports.js";
import {
  PrivatePlanBindingError,
  type PreparedPrivateDelegation,
  type PreparedPrivateReservation,
  type PrivateOperationPlanner,
  type PrivateOperationReference,
} from "./private-invocations.js";

type PaymentAction = Extract<AgentAction, { type: "request_payment" }>;
type DelegateAction = Extract<AgentAction, { type: "delegate_authority" }>;

export interface ResolvedPrivateDelegationContext {
  readonly sessionId: Buffer;
  readonly sourceBudgetNoteId: Buffer;
  readonly sourceAgent: string;
  readonly networkId: Buffer;
  readonly treasuryController: string;
  readonly childRole: DelegateAction["childAgent"];
  readonly childOwner: string;
  readonly childPolicy: NodePolicy;
  readonly delegatedAmountAtomic: string;
  readonly createdAtUnixMs: number;
}

/** Resolves authoritative chain/session context without exposing a private opening. */
export interface PrivateDelegationContextResolver {
  resolve(action: DelegateAction, actor: AgentActor): Promise<ResolvedPrivateDelegationContext>;
}

export interface ResolvedPrivateReservationContext {
  readonly sessionId: Buffer;
  readonly sourceBudgetNoteId: Buffer;
  readonly sourceAgent: string;
  readonly networkId: Buffer;
  readonly treasuryController: string;
  readonly approvedProviderRoot: bigint;
  readonly categoryId: number;
  readonly serviceId: PaymentAction["serviceId"];
  readonly offerReferenceHash: string;
  readonly reservationAmountAtomic: string;
  readonly providerSppPublicKey: bigint;
  readonly claimDeadlineLedger: number;
  readonly createdAtUnixMs: number;
}

/** Resolves only verified chain/controlled-provider context, never private openings. */
export interface PrivateReservationContextResolver {
  resolve(action: PaymentAction, actor: AgentActor): Promise<ResolvedPrivateReservationContext>;
}

function matches(actual: string | number | bigint, expected: string | number | bigint): boolean {
  return actual.toString() === expected.toString();
}

/** Adapts a validated delegation intent to the trusted local conservation prover. */
export class PrivacyRuntimeDelegationPlanner implements Pick<PrivateOperationPlanner, "prepareDelegation"> {
  readonly #runtime: PrivateBudgetDelegationProofPlanner;
  readonly #context: PrivateDelegationContextResolver;

  constructor(runtime: PrivateBudgetDelegationProofPlanner, context: PrivateDelegationContextResolver) {
    this.#runtime = runtime;
    this.#context = context;
  }

  async prepareDelegation(action: DelegateAction, actor: AgentActor): Promise<PreparedPrivateDelegation> {
    const context = await this.#context.resolve(action, actor);
    if (!matches(context.sessionId.toString("hex"), action.sessionId)) {
      throw new PrivatePlanBindingError("resolved delegation session does not match the agent action");
    }
    if (!matches(context.sourceAgent, actor.identity)) {
      throw new PrivatePlanBindingError("resolved delegation source does not match the authenticated actor");
    }
    if (!matches(context.childRole, action.childAgent)) {
      throw new PrivatePlanBindingError("resolved child identity role does not match the agent action");
    }
    if (!matches(context.delegatedAmountAtomic, action.amountAtomic)
      || !matches(context.childPolicy.category_mask, action.categoryMask)
      || !matches(context.childPolicy.allowed_actions_mask, action.allowedActionsMask)
      || !matches(context.childPolicy.expiry, action.expiresAtLedger)
      || !matches(context.childPolicy.remaining_delegation_depth, action.remainingDelegationDepth)) {
      throw new PrivatePlanBindingError("resolved child authority does not match the bounded agent action");
    }

    const prepared = await this.#runtime.prepare({
      sessionId: context.sessionId,
      sourceBudgetNoteId: context.sourceBudgetNoteId,
      sourceAgent: context.sourceAgent,
      networkId: context.networkId,
      treasuryController: context.treasuryController,
      childOwner: context.childOwner,
      childPolicy: context.childPolicy,
      delegatedAmountAtomic: BigInt(context.delegatedAmountAtomic),
      createdAtUnixMs: context.createdAtUnixMs,
    });
    return {
      operationId: prepared.operationId,
      sessionId: prepared.sessionId,
      sourceNoteId: prepared.sourceNoteId,
      delegation: prepared.delegation,
      proof: prepared.proof,
      sourceAgent: context.sourceAgent,
      childRole: context.childRole,
      amountAtomic: context.delegatedAmountAtomic,
    };
  }
}

/**
 * Adapter from validated agent intent to the trusted local reservation prover.
 * The return value contains no BudgetNote opening, blinding, or payment key.
 */
export class PrivacyRuntimeReservationPlanner implements Pick<PrivateOperationPlanner, "prepareReservation"> {
  readonly #runtime: PrivateReservationProofPlanner;
  readonly #context: PrivateReservationContextResolver;

  constructor(runtime: PrivateReservationProofPlanner, context: PrivateReservationContextResolver) {
    this.#runtime = runtime;
    this.#context = context;
  }

  async prepareReservation(action: PaymentAction, actor: AgentActor): Promise<PreparedPrivateReservation> {
    const context = await this.#context.resolve(action, actor);
    if (!matches(context.sessionId.toString("hex"), action.sessionId)) {
      throw new PrivatePlanBindingError("resolved reservation session does not match the agent action");
    }
    if (!matches(context.sourceAgent, actor.identity)) {
      throw new PrivatePlanBindingError("resolved private budget owner does not match the authenticated actor");
    }
    if (!matches(context.serviceId, action.serviceId)) {
      throw new PrivatePlanBindingError("resolved controlled-provider service does not match the agent action");
    }
    if (!matches(context.offerReferenceHash, action.offerReferenceHash)) {
      throw new PrivatePlanBindingError("resolved signed offer does not match the agent action");
    }
    if (!matches(context.reservationAmountAtomic, action.amountAtomic)) {
      throw new PrivatePlanBindingError("resolved signed price does not match the requested reservation amount");
    }

    const prepared = await this.#runtime.prepare({
      sessionId: context.sessionId,
      sourceBudgetNoteId: context.sourceBudgetNoteId,
      sourceAgent: context.sourceAgent,
      networkId: context.networkId,
      treasuryController: context.treasuryController,
      approvedProviderRoot: context.approvedProviderRoot,
      categoryId: context.categoryId,
      amountAtomic: BigInt(context.reservationAmountAtomic),
      offerReferenceHash: Buffer.from(context.offerReferenceHash, "hex"),
      providerSppPublicKey: context.providerSppPublicKey,
      claimDeadlineLedger: context.claimDeadlineLedger,
      createdAtUnixMs: context.createdAtUnixMs,
    });
    return {
      operationId: prepared.input.reservation_id,
      input: prepared.input,
      proof: prepared.proof,
      sourceAgent: context.sourceAgent,
      serviceId: context.serviceId,
      offerReferenceHash: context.offerReferenceHash,
      amountAtomic: context.reservationAmountAtomic,
    };
  }
}

/** One lifecycle-safe planner for both PRIVATE delegation and reservation transitions. */
export class PrivacyRuntimePrivateOperationPlanner implements PrivateOperationPlanner {
  readonly #delegationRuntime: PrivateBudgetDelegationProofPlanner;
  readonly #reservationRuntime: PrivateReservationProofPlanner;
  readonly #delegations: PrivacyRuntimeDelegationPlanner;
  readonly #reservations: PrivacyRuntimeReservationPlanner;

  constructor(input: {
    readonly delegationRuntime: PrivateBudgetDelegationProofPlanner;
    readonly delegationContext: PrivateDelegationContextResolver;
    readonly reservationRuntime: PrivateReservationProofPlanner;
    readonly reservationContext: PrivateReservationContextResolver;
  }) {
    this.#delegationRuntime = input.delegationRuntime;
    this.#reservationRuntime = input.reservationRuntime;
    this.#delegations = new PrivacyRuntimeDelegationPlanner(input.delegationRuntime, input.delegationContext);
    this.#reservations = new PrivacyRuntimeReservationPlanner(input.reservationRuntime, input.reservationContext);
  }

  async prepareDelegation(action: DelegateAction, actor: AgentActor): Promise<PreparedPrivateDelegation> {
    return this.#delegations.prepareDelegation(action, actor);
  }

  async prepareReservation(action: PaymentAction, actor: AgentActor): Promise<PreparedPrivateReservation> {
    return this.#reservations.prepareReservation(action, actor);
  }

  async confirm(operation: PrivateOperationReference, receipt: SubmissionReceipt): Promise<void> {
    if (!/^[0-9a-f]{64}$/u.test(receipt.transactionHash)) {
      throw new PrivatePlanBindingError("submission receipt contains a non-canonical transaction hash");
    }
    const input = {
      operationId: operation.operationId,
      transactionHash: Buffer.from(receipt.transactionHash, "hex"),
      ledgerSequence: receipt.ledgerSequence,
    };
    if (operation.kind === "DELEGATION") {
      await this.#delegationRuntime.confirm(input);
      return;
    }
    await this.#reservationRuntime.confirm(input);
  }

  async abort(operation: PrivateOperationReference): Promise<void> {
    if (operation.kind === "DELEGATION") {
      await this.#delegationRuntime.abort(operation.operationId);
      return;
    }
    await this.#reservationRuntime.abort(operation.operationId);
  }
}
