export interface PreparedPrivateActivation {
  readonly transactionXdr: string;
  readonly transactionHash: string;
  readonly operationId: string;
  readonly sessionId: string;
  readonly rootNodeId: string;
  readonly rootNoteId: string;
  readonly fundingAmountAtomic: string;
  readonly fundingAmountDisplay: string;
  readonly assetCode: "USDC";
  readonly assetIssuer: string;
  readonly resource: {
    readonly envelopeBytes: number;
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
    readonly contractId: string;
    readonly functionName: "activate_private_session";
    readonly companyAuthorization: "source-account";
    readonly sppPool: string;
    readonly assetMovement: true;
  };
}

export interface PrivateActivationConfirmationInput {
  readonly transactionHash: string;
  readonly operationId: string;
  readonly sessionId: string;
}

export interface PrivateActivationConfirmation {
  readonly transactionHash: string;
  readonly ledger: number;
  readonly feeChargedStroops: string;
  readonly sessionId: string;
  readonly lifecycle: "Active";
  readonly rootNodeId: string;
  readonly rootNoteId: string;
  readonly fundingLeafIndex: number;
}
