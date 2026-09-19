export const SPP_SOURCE_REVISION = "5f3a5d41f452069caf8d0e1654675bca55cb94d3";

export const SPP_USDC_ASSET = {
  code: "USDC",
  issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  sacContractId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
} as const;

export const SPP_DEPLOYMENT_CONFIG = {
  aspLevels: 10,
  maximumDepositAmount: "1000000000",
  policyFlags: 2,
  policyName: "blocklist",
  poolLevels: 20,
} as const;

export const SPP_ARTIFACTS = {
  aspMembership: {
    fileName: "asp_membership.wasm",
    sha256: "51c6b3752bc89f5ddd5cc57472e3b808bdc7e1311d19cdc03b29a3129c8f42a3",
    size: 19_661,
  },
  aspNonMembership: {
    fileName: "asp_non_membership.wasm",
    sha256: "4b3a6058063641953e76dd5fb4451f6ecebee2b52c225b3c93b3ab08cf83b5e3",
    size: 36_444,
  },
  publicKeyRegistry: {
    fileName: "public_key_registry.wasm",
    sha256: "6806c9ea5aaf8e3d6e09b2f0deb2852ca267b6b8be94be775381ff89e2354f7f",
    size: 2_456,
  },
  pool: {
    fileName: "pool.wasm",
    sha256: "47d68ca6096cce15d1bf383fc8427ec6a44d95a62d73610d796ff9b4db39f867",
    size: 30_328,
  },
  verifier: {
    fileName: "circom_groth16_verifier_B.wasm",
    sha256: "0b612d77030494a6f9490416ae0dae3708e70142f1a828cf9dc5e2ead43cfd2b",
    size: 4_921,
  },
} as const;

export type SppArtifactId = keyof typeof SPP_ARTIFACTS;

export const SPP_DEPLOYMENT_STEPS = [
  { artifactId: "pool", id: "upload-pool", kind: "upload", label: "Upload SPP pool WASM" },
  { artifactId: "aspMembership", id: "create-asp-membership", kind: "create", label: "Create ASP membership contract" },
  { artifactId: "aspNonMembership", id: "create-asp-non-membership", kind: "create", label: "Create ASP non-membership contract" },
  { artifactId: "verifier", id: "create-verifier", kind: "create", label: "Create blocklist verifier contract" },
  { artifactId: "publicKeyRegistry", id: "create-public-key-registry", kind: "create", label: "Create public-key registry contract" },
  { artifactId: "pool", id: "create-pool", kind: "create", label: "Create and initialize USDC SPP pool" },
] as const satisfies ReadonlyArray<{
  artifactId: SppArtifactId;
  id: string;
  kind: "create" | "upload";
  label: string;
}>;

export const SPP_REUSED_TESTNET_WASM = [
  "aspMembership",
  "aspNonMembership",
  "verifier",
  "publicKeyRegistry",
] as const satisfies ReadonlyArray<SppArtifactId>;

export type SppDeploymentStep = (typeof SPP_DEPLOYMENT_STEPS)[number];
export type SppDeploymentStepId = SppDeploymentStep["id"];

export interface SppContractIds {
  aspMembership?: string;
  aspNonMembership?: string;
  pool?: string;
  publicKeyRegistry?: string;
  verifier?: string;
}

export interface SppResourceSnapshot {
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

export interface PreparedSppDeploymentStep {
  assetVerification: {
    anchorStellarToml: string;
    checkedAt: string;
    decimals: number;
    issuerAccount: string;
    name: string;
    symbol: string;
  };
  expectedContractId?: string;
  expectedWasmHash: string;
  expiresAt: number;
  resource: SppResourceSnapshot;
  safety: {
    assetMovement: false;
    hostFunction: "createContractV2" | "uploadContractWasm";
    operationCount: 1;
  };
  stepId: SppDeploymentStepId;
  summary: string;
  transactionXdr: string;
}

export interface CompletedSppDeploymentStep {
  contractId?: string;
  ledger: number;
  resource: SppResourceSnapshot;
  stepId: SppDeploymentStepId;
  transactionHash: string;
  wasmHash: string;
}
