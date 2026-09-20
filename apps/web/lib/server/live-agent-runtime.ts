import { join } from "node:path";

import { NvidiaNimProvider } from "@phloem/agent-runtime";
import {
  ExecutionGateway,
  GeneratedTreasuryControllerAdapter,
  HttpResearchDataService,
  P0LiveAgentRunner,
  PrivateFinancialInvocationBuilder,
  RpcStellarSubmitter,
  StellarAgentAccountAuthorizer,
  StellarCliSourceSigner,
  type AgentIdentityResolver,
  type PrivateOperationPlanner,
  type ProtocolReader,
  type ReservedResearchContextResolver,
} from "@phloem/execution-gateway";
import { AgentIdentityVault, type PublicAgentIdentity } from "@phloem/privacy-runtime/agent-identities";
import { EncryptedPrivacyStateStore } from "@phloem/privacy-runtime/state-store";
import { Client } from "@phloem/treasury-controller-client";
import { rpc } from "@stellar/stellar-sdk";

import { PHLOEM_NETWORK } from "../network";

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

export interface LiveAgentRuntimeDependencies {
  readonly privateOperations: PrivateOperationPlanner;
  readonly providerContext: ReservedResearchContextResolver;
  readonly reader: ProtocolReader;
}

export interface LiveAgentRuntime {
  readonly runner: P0LiveAgentRunner;
  readonly gateway: ExecutionGateway;
  readonly identities: Readonly<{
    SUPERVISOR: PublicAgentIdentity;
    RESEARCH: PublicAgentIdentity;
    BUILDER: PublicAgentIdentity;
  }>;
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
 * Server-only P0 composition root. Constructing it performs no NIM request,
 * signature, submission, or asset movement; those occur only when runner
 * methods are explicitly invoked.
 */
export async function createP0LiveAgentRuntime(
  sessionId: string,
  dependencies: LiveAgentRuntimeDependencies,
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
    const invocations = new PrivateFinancialInvocationBuilder(dependencies.privateOperations, identityResolver);
    const treasuryController = new GeneratedTreasuryControllerAdapter(controllerClient, invocations);
    const gateway = new ExecutionGateway({
      reader: dependencies.reader,
      provider: new HttpResearchDataService({
        endpoint: providerEndpoint(),
        context: dependencies.providerContext,
      }),
      treasuryController,
      agentAuthorizer: new StellarAgentAccountAuthorizer({
        networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
        treasuryControllerId: PHLOEM_NETWORK.treasuryControllerId,
        ed25519VerifierId: PHLOEM_NETWORK.ed25519VerifierId,
        latestLedger: async () => (await server.getLatestLedger()).sequence,
        authority: vault,
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
    const runner = new P0LiveAgentRunner({
      model: new NvidiaNimProvider(process.env.NVIDIA_API_KEY ? { apiKey: process.env.NVIDIA_API_KEY } : {}),
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
      close: () => store.close(),
    });
  } catch (error: unknown) {
    store.close();
    throw error;
  }
}
