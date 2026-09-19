import { z } from "zod";

const contractIdSchema = z.string().regex(/^C[A-Z2-7]{55}$/u);
const accountIdSchema = z.string().regex(/^G[A-Z2-7]{55}$/u);
const sha1Schema = z.string().regex(/^[0-9a-f]{40}$/u);

const canonicalManifestSchema = z.object({
  network: z.literal("testnet"),
  networkPassphrase: z.literal("Test SDF Network ; September 2015"),
  spp: z.object({
    sourceRevision: sha1Schema,
    asset: z.object({
      code: z.literal("USDC"),
      issuer: accountIdSchema,
      sacContractId: contractIdSchema,
      decimals: z.literal(7),
    }),
    configuration: z.object({
      policy: z.literal("blocklist"),
      policyFlags: z.literal(2),
      aspLevels: z.number().int().positive(),
      poolLevels: z.number().int().positive(),
      maximumDepositAmount: z.string().regex(/^[1-9][0-9]*$/u),
    }),
    contracts: z.object({
      aspMembership: contractIdSchema,
      aspNonMembership: contractIdSchema,
      verifierB: contractIdSchema,
      publicKeyRegistry: contractIdSchema,
      pool: contractIdSchema,
    }),
  }),
});

const sdkManifestSchema = z.object({
  network: z.literal("testnet"),
  asp_membership: contractIdSchema,
  asp_non_membership: contractIdSchema,
  verifiers: z.object({ B: contractIdSchema }),
  public_key_registry: contractIdSchema,
  pools: z.array(z.object({
    poolContractId: contractIdSchema,
    tokenContractId: contractIdSchema,
    enabled: z.literal(true),
    policyFlags: z.tuple([z.literal("blocklist")]),
    asset: z.object({
      kind: z.literal("classic"),
      code: z.literal("USDC"),
      issuer: accountIdSchema,
    }),
  })).length(1),
});

export interface SppRuntimeBinding {
  readonly network: "testnet";
  readonly networkPassphrase: "Test SDF Network ; September 2015";
  readonly sourceRevision: string;
  readonly poolContractId: string;
  readonly tokenContractId: string;
  readonly aspMembershipContractId: string;
  readonly aspNonMembershipContractId: string;
  readonly verifierContractId: string;
  readonly publicKeyRegistryContractId: string;
  readonly asset: Readonly<{ code: "USDC"; issuer: string; decimals: 7 }>;
  readonly policy: Readonly<{
    name: "blocklist";
    flags: 2;
    aspLevels: number;
    poolLevels: number;
    maximumDepositAmount: bigint;
  }>;
}

export class SppDeploymentBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SppDeploymentBindingError";
  }
}

/**
 * Cross-checks the canonical Phloem evidence manifest against the exact format
 * consumed by the pinned upstream SDK. The result contains public metadata only.
 */
export function bindSppUsdcTestnetDeployment(
  canonicalManifestInput: unknown,
  sdkManifestInput: unknown,
): SppRuntimeBinding {
  const canonical = canonicalManifestSchema.parse(canonicalManifestInput);
  const sdk = sdkManifestSchema.parse(sdkManifestInput);
  const pool = sdk.pools[0]!;
  const mismatches = [
    ["pool", canonical.spp.contracts.pool, pool.poolContractId],
    ["token", canonical.spp.asset.sacContractId, pool.tokenContractId],
    ["asset issuer", canonical.spp.asset.issuer, pool.asset.issuer],
    ["ASP membership", canonical.spp.contracts.aspMembership, sdk.asp_membership],
    ["ASP non-membership", canonical.spp.contracts.aspNonMembership, sdk.asp_non_membership],
    ["verifier B", canonical.spp.contracts.verifierB, sdk.verifiers.B],
    ["public-key registry", canonical.spp.contracts.publicKeyRegistry, sdk.public_key_registry],
  ] as const;
  const mismatch = mismatches.find(([, expected, actual]) => expected !== actual);
  if (mismatch) throw new SppDeploymentBindingError(`${mismatch[0]} differs between deployment manifests`);

  return Object.freeze({
    network: canonical.network,
    networkPassphrase: canonical.networkPassphrase,
    sourceRevision: canonical.spp.sourceRevision,
    poolContractId: canonical.spp.contracts.pool,
    tokenContractId: canonical.spp.asset.sacContractId,
    aspMembershipContractId: canonical.spp.contracts.aspMembership,
    aspNonMembershipContractId: canonical.spp.contracts.aspNonMembership,
    verifierContractId: canonical.spp.contracts.verifierB,
    publicKeyRegistryContractId: canonical.spp.contracts.publicKeyRegistry,
    asset: Object.freeze({
      code: canonical.spp.asset.code,
      issuer: canonical.spp.asset.issuer,
      decimals: canonical.spp.asset.decimals,
    }),
    policy: Object.freeze({
      name: canonical.spp.configuration.policy,
      flags: canonical.spp.configuration.policyFlags,
      aspLevels: canonical.spp.configuration.aspLevels,
      poolLevels: canonical.spp.configuration.poolLevels,
      maximumDepositAmount: BigInt(canonical.spp.configuration.maximumDepositAmount),
    }),
  });
}
