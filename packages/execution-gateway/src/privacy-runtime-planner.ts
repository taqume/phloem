import type { AgentAction } from "@phloem/agent-runtime";
import type { PrivateReservationProofPlanner } from "@phloem/privacy-runtime";

import type { AgentActor } from "./ports.js";
import {
  PrivatePlanBindingError,
  type PreparedPrivateReservation,
  type PrivateOperationPlanner,
} from "./private-invocations.js";

type PaymentAction = Extract<AgentAction, { type: "request_payment" }>;

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
      input: prepared.input,
      proof: prepared.proof,
      sourceAgent: context.sourceAgent,
      serviceId: context.serviceId,
      offerReferenceHash: context.offerReferenceHash,
      amountAtomic: context.reservationAmountAtomic,
    };
  }
}
