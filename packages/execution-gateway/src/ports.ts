import type { AgentAction, AgentRole } from "@phloem/agent-runtime";

export interface AgentActor {
  readonly role: AgentRole;
  readonly identity: string;
}

export interface ProtocolReadResult {
  readonly ledgerSequence: number;
  readonly value: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ProtocolReader {
  getBudget(action: Extract<AgentAction, { type: "get_budget" }>, actor: AgentActor): Promise<ProtocolReadResult>;
  getAgentState(action: Extract<AgentAction, { type: "get_agent_state" }>, actor: AgentActor): Promise<ProtocolReadResult>;
}

export interface ProviderServiceResult {
  readonly requestId: string;
  readonly responseHash: string;
  readonly signedUsageEvidence: string;
  readonly signedServiceOffer: string;
}

export interface ControlledProvider {
  request(action: Extract<AgentAction, { type: "request_service" }>, actor: AgentActor): Promise<ProviderServiceResult>;
}

export interface ContractRejection {
  readonly accepted: false;
  readonly source: "TREASURY_CONTROLLER_SIMULATION";
  readonly contractErrorCode: string;
  readonly diagnosticHash: string;
  readonly latestLedger: number;
}

export interface PreparedContractInvocation {
  readonly accepted: true;
  readonly unsignedTransactionXdr: string;
  readonly simulationHash: string;
  readonly latestLedger: number;
  readonly requiredSigner: {
    readonly kind: "AGENT_SMART_ACCOUNT";
    readonly identity: string;
  };
}

export type ContractSimulation = ContractRejection | PreparedContractInvocation;

export interface TreasuryController {
  simulate(
    action: Extract<AgentAction, { type: "delegate_authority" | "request_payment" }>,
    actor: AgentActor,
  ): Promise<ContractSimulation>;
}

export interface AgentSigner {
  sign(unsignedTransactionXdr: string, signer: PreparedContractInvocation["requiredSigner"]): Promise<string>;
}

export interface SubmissionReceipt {
  readonly transactionHash: string;
  readonly ledgerSequence: number;
  readonly status: "SUCCESS";
}

export interface StellarSubmitter {
  submit(signedTransactionXdr: string): Promise<SubmissionReceipt>;
}
