export type SessionFinalizationAction = "begin_draining" | "finalize_audit" | "close_session";

export interface PreparedSessionFinalization {
  readonly transactionXdr: string;
  readonly sessionId: string;
  readonly action: SessionFinalizationAction;
  readonly resource: {
    readonly instructions: number;
    readonly diskReadBytes: number;
    readonly writeBytes: number;
    readonly maximumFeeStroops: string;
    readonly approvedFeeCeilingStroops: string;
  };
  readonly safety: {
    readonly operationCount: 1;
    readonly contractId: string;
    readonly functionName: SessionFinalizationAction;
    readonly companyAuthorization: "source-account";
    readonly assetMovement: false;
  };
}

export interface SessionFinalizationConfirmation {
  readonly transactionHash: string;
  readonly ledger: number;
  readonly feeChargedStroops: string;
  readonly sessionId: string;
  readonly action: SessionFinalizationAction;
  readonly lifecycle: "Draining" | "Closed";
  readonly auditFinalized: boolean;
  readonly finalSnapshotHash?: string;
}

export interface AuditQlVerification {
  readonly sessionId: string;
  readonly templateId: "TOTAL_SPEND_LEQ";
  readonly templateVersion: 1;
  readonly thresholdAtomic: string;
  readonly auditVersion: number;
  readonly snapshotHash: string;
  readonly proofSha256: string;
  readonly verifierContractId: string;
  readonly verified: true;
  readonly execution: "testnet-rpc-simulation" | "local-snarkjs-live-testnet-statement";
  readonly testnetVerifierAccepted: boolean;
  readonly resource: {
    readonly instructions: number;
    readonly diskReadBytes: number;
    readonly writeBytes: number;
    readonly maximumFeeStroops: string;
  };
}
