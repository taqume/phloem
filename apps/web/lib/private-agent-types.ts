import type { PrivateAgentRole } from "@phloem/privacy-runtime/agent-identities";

export interface PreparedPrivateAgentDeployment {
  readonly transactionXdr: string;
  readonly sessionId: string;
  readonly role: PrivateAgentRole;
  readonly contractId: string;
  readonly publicKeyHex: string;
  readonly validUntilLedger: number;
  readonly resource: {
    readonly instructions: number;
    readonly diskReadBytes: number;
    readonly writeBytes: number;
    readonly readOnlyEntries: number;
    readonly readWriteEntries: number;
    readonly maximumFeeStroops: string;
    readonly approvedFeeCeilingStroops: string;
  };
  readonly safety: {
    readonly operationCount: 1;
    readonly hostFunction: "createContractV2";
    readonly contractInvocation: false;
    readonly assetMovement: false;
  };
}

export interface PrivateAgentDeploymentRecord {
  readonly transactionHash: string;
  readonly sessionId: string;
  readonly role: PrivateAgentRole;
  readonly contractId: string;
  readonly ledger: number;
}

export interface ExistingPrivateAgentDeployment extends PrivateAgentDeploymentRecord {
  readonly alreadyDeployed: true;
}

export type PrivateAgentPreparationResult = PreparedPrivateAgentDeployment | ExistingPrivateAgentDeployment;

export interface PrivateAgentDeploymentConfirmationInput {
  readonly transactionHash: string;
  readonly sessionId: string;
  readonly role: PrivateAgentRole;
  readonly contractId: string;
}

export interface PrivateAgentDeploymentConfirmation extends PrivateAgentDeploymentRecord {
  readonly feeChargedStroops: string;
}
