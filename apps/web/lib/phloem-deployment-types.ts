export const PHLOEM_DEPLOYER = "GBRFJEDXTYPKMZCQNXQV5LS63YBKRVNTQLE37GKKMQEO3TQ2N6HI4QUC";
export const PHLOEM_UPLOAD_FEE_LIMIT_STROOPS = "190315109";
export const PHLOEM_UPLOAD_FEE_TOLERANCE_BPS = 100n;
export const PHLOEM_CONTRACT_SOURCE_REVISION = "83b6c1dcd7cc8bfbb62b06a69cc829a35ac0c6d0";

export function feeGuardrailStroops(preflightStroops: string): string {
  const value = BigInt(preflightStroops);
  return ((value * (10_000n + PHLOEM_UPLOAD_FEE_TOLERANCE_BPS) + 9_999n) / 10_000n).toString();
}

export const PHLOEM_ARTIFACTS = {
  ed25519Verifier: {
    fileName: "phloem_ed25519_verifier.wasm",
    label: "Ed25519 verifier",
    maxFeeStroops: "3503850",
    sha256: "aa15e1a91fd5d41a755b5321f97bb4290e0db4595dd4408e2e89f16d4d066600",
    size: 1_283,
  },
  budgetTransitionVerifierV1: {
    fileName: "phloem_budget_transition_verifier.wasm",
    label: "Budget transition verifier V1",
    maxFeeStroops: "9598440",
    sha256: "0e068ff97a66fb5056c7249444e2b31762dc1ae9031a725d7f5ae8f1676ddb0d",
    size: 4_271,
  },
  privateRootBackingVerifierV1: {
    fileName: "phloem_private_root_backing_verifier.wasm",
    label: "Private root backing verifier V1",
    maxFeeStroops: "9598440",
    sha256: "779d500e9afcf7d07eac315ae41ecc4e23df581dfceec2fd5a7668d45a270005",
    size: 4_271,
  },
  privateSettlementBindingVerifierV1: {
    fileName: "phloem_private_settlement_binding_verifier.wasm",
    label: "Private settlement binding verifier V1",
    maxFeeStroops: "9598440",
    sha256: "058079beb6e94dec7bfc594c3a2f21554af82d4bdd62a8fa70689d8ba0c72029",
    size: 4_271,
  },
  agentAccount: {
    fileName: "phloem_agent_account.wasm",
    label: "Agent Smart Account",
    maxFeeStroops: "49349026",
    sha256: "0a9d54d3bf278131cf2239e1db52eee54f057d4e3241a6aafc2b28bca22d156d",
    size: 39_444,
  },
  treasuryController: {
    fileName: "phloem_treasury_controller.wasm",
    label: "TreasuryController",
    maxFeeStroops: "108666913",
    sha256: "6d27f7cc117764a40fe0047c7d6c8b975c008d560dd96d4279258a7e7bc29b62",
    size: 73_776,
  },
} as const;

export type PhloemArtifactId = keyof typeof PHLOEM_ARTIFACTS;

export const PHLOEM_UPLOAD_STEPS = (Object.keys(PHLOEM_ARTIFACTS) as PhloemArtifactId[]).map((artifactId) => ({
  artifactId,
  id: `upload-${artifactId}`,
  label: `Upload ${PHLOEM_ARTIFACTS[artifactId].label} WASM`,
}));

export type PhloemUploadStep = (typeof PHLOEM_UPLOAD_STEPS)[number];

export interface PhloemUploadResourceSnapshot {
  diskReadBytes: number;
  envelopeBytes: number;
  footprintReadOnlyEntries: number;
  footprintReadWriteEntries: number;
  inclusionFeeStroops: string;
  instructions: number;
  latestLedger: number;
  minResourceFeeStroops: string;
  totalFeeStroops: string;
  writeBytes: number;
}

export interface PreparedPhloemUpload {
  expectedWasmHash: string;
  expiresAt: number;
  feeLimit: {
    artifactGuardrailStroops: string;
    artifactPreflightStroops: string;
    approvedPreflightStroops: string;
    approvedTotalGuardrailStroops: string;
    projectedTotalStroops: string;
  };
  resource: PhloemUploadResourceSnapshot;
  safety: {
    assetMovement: false;
    contractInvocation: false;
    hostFunction: "uploadContractWasm";
    operationCount: 1;
  };
  stepId: string;
  summary: string;
  transactionXdr: string;
}

export interface CompletedPhloemUpload {
  artifactId: PhloemArtifactId;
  ledger: number;
  resource: PhloemUploadResourceSnapshot;
  stepId: string;
  transactionHash: string;
  wasmHash: string;
}
