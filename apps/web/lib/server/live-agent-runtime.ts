import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

import {
  GoogleGeminiProvider,
  NvidiaNimProvider,
  type AgentContext,
  type AgentRole,
} from "@phloem/agent-runtime";
import {
  ExecutionGateway,
  GeneratedTreasuryControllerAdapter,
  HttpResearchDataService,
  P0LiveAgentRunner,
  PrivateFinancialInvocationBuilder,
  PrivacyRuntimePrivateOperationPlanner,
  RpcStellarSubmitter,
  RpcTransactionResourceAssembler,
  StellarAgentAccountAuthorizer,
  StellarCliSourceSigner,
  type AgentIdentityResolver,
} from "@phloem/execution-gateway";
import { AgentIdentityVault, type PublicAgentIdentity } from "@phloem/privacy-runtime/agent-identities";
import { PrivateBudgetDelegationProofPlanner } from "@phloem/privacy-runtime/delegation";
import { LocalGroth16ProofWorker } from "@phloem/privacy-runtime";
import { PrivateReservationProofPlanner } from "@phloem/privacy-runtime/reservation";
import { EncryptedPrivacyStateStore } from "@phloem/privacy-runtime/state-store";
import { PrivateVoucherIssuer } from "@phloem/privacy-runtime";
import { networkId, toHex } from "@phloem/protocol-types";
import { Client } from "@phloem/treasury-controller-client";
import { rpc } from "@stellar/stellar-sdk";

import { PHLOEM_NETWORK } from "../network";
import {
  HttpControlledOfferResolver,
  LivePrivateDelegationContextResolver,
  LivePrivateReservationContextResolver,
  LivePrivateSourceReader,
  LiveResearchRequestContextResolver,
  LiveTestnetProtocolReader,
  type ControlledOfferSnapshot,
} from "./live-private-context";
import { loadControlledProviderPrivatePublicConfig } from "./private-session";

const PRIVATE_STATE_DEFAULT_PATH = ".phloem/private-state.v1.enc";
const FEE_PAYER_IDENTITY_ALIAS = "phloem-testnet-wasm-uploader";

function privateStateEncryptionKey(): Buffer {
  const value = process.env.PHLOEM_PRIVATE_STATE_KEY_HEX;
  if (!value || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error("PHLOEM_PRIVATE_STATE_KEY_HEX must be configured as 32-byte lowercase hexadecimal");
  }
  return Buffer.from(value, "hex");
}

function privateStatePath(): string {
  if (process.env.VERCEL) {
    throw new Error("authoritative private state cannot use the Vercel stateless filesystem");
  }
  return process.env.PHLOEM_PRIVATE_STATE_PATH
    || join(process.cwd(), PRIVATE_STATE_DEFAULT_PATH);
}

function providerEndpoint(): string {
  const configured = process.env.PHLOEM_RESEARCH_PROVIDER_ENDPOINT;
  const endpoint = new URL(configured || "http://127.0.0.1:3000/api/provider/research");
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("PHLOEM_RESEARCH_PROVIDER_ENDPOINT must use HTTP or HTTPS");
  }
  return endpoint.toString();
}

function providerOfferEndpoint(): string {
  const configured = process.env.PHLOEM_RESEARCH_PROVIDER_OFFER_ENDPOINT;
  if (configured) return new URL(configured).toString();
  return new URL("/api/provider/offer", providerEndpoint()).toString();
}

function repositoryRoot(): string {
  const cwd = process.cwd();
  return basename(cwd) === "web" && basename(dirname(cwd)) === "apps"
    ? resolve(cwd, "../..")
    : cwd;
}

function budgetTransitionArtifacts() {
  const setup = join(repositoryRoot(), ".phloem/budget-transition-setup");
  return Object.freeze({
    wasmPath: join(setup, "BudgetTransitionV1_js/BudgetTransitionV1.wasm"),
    zkeyPath: join(setup, "budget_transition_final.zkey"),
    verificationKeyPath: join(setup, "verification_key.json"),
    publicInputCount: 8,
  });
}

export interface LiveAgentRuntime {
  readonly runner: P0LiveAgentRunner;
  readonly gateway: ExecutionGateway;
  readonly identities: Readonly<{
    SUPERVISOR: PublicAgentIdentity;
    RESEARCH: PublicAgentIdentity;
    BUILDER: PublicAgentIdentity;
  }>;
  contextFor(role: AgentRole, input: {
    readonly task: string;
    readonly policySummary: string;
  }): Promise<AgentContext>;
  currentOffer(): Promise<ControlledOfferSnapshot>;
  acceptProviderEvidence(signedUsageEvidence: string): Promise<Readonly<{
    evidenceHash: string;
    usageRoot: string;
    voucherSequence: string;
    cumulativeAmountCommitment: string;
    expiryLedger: number;
  }>>;
  close(): void;
}

function deployedContractId(identity: PublicAgentIdentity): string {
  if (identity.status !== "DEPLOYED" || !identity.contractId) {
    throw new Error(`${identity.role} AgentAccount has not been confirmed on Testnet`);
  }
  return identity.contractId;
}

export async function openEncryptedAgentIdentityVault(): Promise<Readonly<{
  store: EncryptedPrivacyStateStore;
  vault: AgentIdentityVault;
}>> {
  const key = privateStateEncryptionKey();
  try {
    const store = new EncryptedPrivacyStateStore(privateStatePath(), key);
    await store.initialize();
    return Object.freeze({ store, vault: new AgentIdentityVault(store) });
  } finally {
    key.fill(0);
  }
}

export async function preparePrivateSessionAgentIdentities(input: {
  readonly sessionId: string;
  readonly validUntilLedger: number;
}): Promise<readonly PublicAgentIdentity[]> {
  const { store, vault } = await openEncryptedAgentIdentityVault();
  try {
    return await Promise.all([
      vault.prepare({ ...input, role: "SUPERVISOR" }),
      vault.prepare({ ...input, role: "RESEARCH" }),
      vault.prepare({ ...input, role: "BUILDER" }),
    ]);
  } finally {
    store.close();
  }
}

/**
 * Server-only P0 composition root. Constructing it performs no model request,
 * signature, submission, or asset movement; those occur only when runner
 * methods are explicitly invoked.
 */
export async function createP0LiveAgentRuntime(
  sessionId: string,
): Promise<LiveAgentRuntime> {
  const { store, vault } = await openEncryptedAgentIdentityVault();
  try {
    const [supervisor, research, builder] = await Promise.all([
      vault.resolve(sessionId, "SUPERVISOR"),
      vault.resolve(sessionId, "RESEARCH"),
      vault.resolve(sessionId, "BUILDER"),
    ]);
    const supervisorContractId = deployedContractId(supervisor);
    const researchContractId = deployedContractId(research);
    const builderContractId = deployedContractId(builder);
    const server = new rpc.Server(PHLOEM_NETWORK.rpcUrl);
    const controllerClient = new Client({
      contractId: PHLOEM_NETWORK.treasuryControllerId,
      networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
      rpcUrl: PHLOEM_NETWORK.rpcUrl,
      publicKey: PHLOEM_NETWORK.executionFeePayerPublicKey,
    });
    const identityResolver: AgentIdentityResolver = {
      resolve: async (resolvedSessionId, role) => {
        const identity = await vault.resolve(resolvedSessionId, role);
        if (identity.status !== "DEPLOYED" || !identity.contractId) {
          throw new Error(`${role} AgentAccount has not been confirmed on Testnet`);
        }
        return identity.contractId;
      },
    };
    const latestLedger = async () => (await server.getLatestLedger()).sequence;
    const provider = loadControlledProviderPrivatePublicConfig();
    const canonicalNetworkId = Buffer.from(networkId(PHLOEM_NETWORK.networkPassphrase));
    const sources = new LivePrivateSourceReader({ store, client: controllerClient, latestLedger });
    const offers = new HttpControlledOfferResolver({
      endpoint: providerOfferEndpoint(),
      networkIdHex: toHex(canonicalNetworkId),
      treasuryController: PHLOEM_NETWORK.treasuryControllerId,
      provider,
    });
    const proofWorker = new LocalGroth16ProofWorker({
      snarkJsCli: join(repositoryRoot(), "node_modules/snarkjs/build/cli.cjs"),
    });
    const artifacts = budgetTransitionArtifacts();
    const random = { bytes: (length: number) => randomBytes(length) };
    const issuer = new PrivateVoucherIssuer(store, random);
    const delegationRuntime = new PrivateBudgetDelegationProofPlanner({
      store,
      proofWorker,
      artifacts,
      random,
    });
    const reservationRuntime = new PrivateReservationProofPlanner({
      store,
      issuer,
      proofWorker,
      artifacts,
      random,
    });
    const privateOperations = new PrivacyRuntimePrivateOperationPlanner({
      delegationRuntime,
      delegationContext: new LivePrivateDelegationContextResolver({
        sources,
        childIdentity: async (resolvedSessionId, role) => identityResolver.resolve(resolvedSessionId, role),
        networkId: canonicalNetworkId,
        treasuryController: PHLOEM_NETWORK.treasuryControllerId,
      }),
      reservationRuntime,
      reservationContext: new LivePrivateReservationContextResolver({
        sources,
        offers,
        provider,
        networkId: canonicalNetworkId,
        treasuryController: PHLOEM_NETWORK.treasuryControllerId,
      }),
    });
    const providerContext = new LiveResearchRequestContextResolver({
      store,
      client: controllerClient,
      offers,
      latestLedger,
    });
    const reader = new LiveTestnetProtocolReader({
      sources,
      agentIdentity: async (resolvedSessionId, role) => vault.resolve(resolvedSessionId, role),
      latestLedger,
    });
    const invocations = new PrivateFinancialInvocationBuilder(privateOperations, identityResolver);
    const treasuryController = new GeneratedTreasuryControllerAdapter(controllerClient, invocations);
    const gateway = new ExecutionGateway({
      reader,
      provider: new HttpResearchDataService({
        endpoint: providerEndpoint(),
        context: providerContext,
      }),
      treasuryController,
      agentAuthorizer: new StellarAgentAccountAuthorizer({
        networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
        treasuryControllerId: PHLOEM_NETWORK.treasuryControllerId,
        ed25519VerifierId: PHLOEM_NETWORK.ed25519VerifierId,
        latestLedger,
        authority: vault,
      }),
      transactionResourceAssembler: new RpcTransactionResourceAssembler({
        server,
        networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
        sourcePublicKey: PHLOEM_NETWORK.executionFeePayerPublicKey,
        treasuryControllerId: PHLOEM_NETWORK.treasuryControllerId,
      }),
      transactionSourceSigner: new StellarCliSourceSigner({
        identityAlias: FEE_PAYER_IDENTITY_ALIAS,
        networkName: "testnet",
        networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
        sourcePublicKey: PHLOEM_NETWORK.executionFeePayerPublicKey,
        treasuryControllerId: PHLOEM_NETWORK.treasuryControllerId,
      }),
      submitter: new RpcStellarSubmitter({
        server,
        networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
        sourcePublicKey: PHLOEM_NETWORK.executionFeePayerPublicKey,
        treasuryControllerId: PHLOEM_NETWORK.treasuryControllerId,
      }),
    });
    const googleApiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
    const runner = new P0LiveAgentRunner({
      model: googleApiKey
        ? new GoogleGeminiProvider({
          apiKey: googleApiKey,
          requestTimeoutMs: 30_000,
        })
        : new NvidiaNimProvider(process.env.NVIDIA_API_KEY
          ? { apiKey: process.env.NVIDIA_API_KEY, requestTimeoutMs: 120_000 }
          : {}),
      gateway,
      identities: {
        SUPERVISOR: supervisorContractId,
        RESEARCH: researchContractId,
        BUILDER: builderContractId,
      },
    });
    return Object.freeze({
      runner,
      gateway,
      identities: Object.freeze({ SUPERVISOR: supervisor, RESEARCH: research, BUILDER: builder }),
      contextFor: async (role: AgentRole, input: {
        readonly task: string;
        readonly policySummary: string;
      }): Promise<AgentContext> => {
        const identity = { SUPERVISOR: supervisor, RESEARCH: research, BUILDER: builder }[role];
        const contractId = deployedContractId(identity);
        const source = await sources.resolve(sessionId, contractId);
        return {
          sessionId,
          agent: role,
          agentId: contractId,
          task: input.task,
          policySummary: input.policySummary,
          protocolState: {
            ledgerSequence: source.latestLedger,
            lifecycle: "ACTIVE",
            nodeId: source.opening.nodeId,
            remainingBudgetAtomic: source.opening.amountAtomic,
            branchFrozen: source.node.branch_frozen,
            settlementMode: "PRIVATE",
          },
        };
      },
      currentOffer: () => offers.current(),
      acceptProviderEvidence: async (signedUsageEvidence: string) => {
        const accepted = await issuer.acceptP0UsageEvidence({
          signedUsageEvidence: JSON.parse(signedUsageEvidence) as unknown,
          policy: {
            providerIdentity: provider.providerIdentity,
            serviceIdHash: provider.serviceIdHash,
            categoryId: provider.categoryId,
          },
          currentLedger: await latestLedger(),
          acceptedAtUnixMs: Date.now(),
        });
        return Object.freeze({
          evidenceHash: toHex(accepted.evidenceHash),
          usageRoot: accepted.usageRoot.toString(),
          voucherSequence: accepted.voucher.sequence.toString(),
          cumulativeAmountCommitment: accepted.voucher.cumulativeAmountCommitment.toString(),
          expiryLedger: accepted.voucher.expiryLedger,
        });
      },
      close: () => store.close(),
    });
  } catch (error: unknown) {
    store.close();
    throw error;
  }
}
