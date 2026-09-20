export interface PreparedPrivateRootDelegation {
  readonly transactionXdr: string;
  readonly transactionHash: string;
  readonly operationId: string;
  readonly sessionId: string;
  readonly sourceNoteId: string;
  readonly childNodeId: string;
  readonly childNoteId: string;
  readonly supervisor: string;
  readonly delegatedAmountAtomic: string;
  readonly policy: {
    readonly categoryMask: "4";
    readonly allowedActionsMask: "5";
    readonly remainingDelegationDepth: 1;
    readonly expiry: number;
  };
  readonly resource: {
    readonly instructions: number;
    readonly diskReadBytes: number;
    readonly writeBytes: number;
    readonly envelopeBytes: number;
    readonly maximumFeeStroops: string;
    readonly approvedFeeCeilingStroops: string;
  };
  readonly safety: {
    readonly operationCount: 1;
    readonly contractId: string;
    readonly functionName: "delegate_private_root";
    readonly companyAuthorization: "source-account";
    readonly assetMovement: false;
  };
}

export interface PrivateRootDelegationConfirmation {
  readonly transactionHash: string;
  readonly ledger: number;
  readonly feeChargedStroops: string;
  readonly sessionId: string;
  readonly supervisor: string;
  readonly childNodeId: string;
  readonly childNoteId: string;
}
