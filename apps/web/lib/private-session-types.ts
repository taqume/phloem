export interface PreparedPrivateSessionCreation {
  readonly transactionXdr: string;
  readonly sessionId: string;
  readonly currentLedger: number;
  readonly sessionExpiry: number;
  readonly policyHash: string;
  readonly approvedProviderRoot: string;
  readonly provider: {
    readonly identity: string;
    readonly sppPublicKey: string;
    readonly sppEncryptionPublicKeyHex: string;
    readonly serviceIdHashHex: string;
    readonly categoryId: number;
    readonly allowedSettlementModes: 2;
  };
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
    readonly functionName: "create_session";
    readonly companyAuthorization: "source-account";
    readonly contractInvocation: true;
    readonly assetMovement: false;
  };
}

export interface PrivateSessionConfirmationInput {
  readonly transactionHash: string;
  readonly sessionId: string;
  readonly policyHash: string;
  readonly approvedProviderRoot: string;
  readonly sessionExpiry: number;
}

export interface PrivateSessionConfirmation {
  readonly transactionHash: string;
  readonly ledger: number;
  readonly feeChargedStroops: string;
  readonly sessionId: string;
  readonly lifecycle: "Draft";
}
