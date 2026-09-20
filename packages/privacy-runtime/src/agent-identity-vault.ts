import { randomBytes } from "node:crypto";

import { Keypair, StrKey } from "@stellar/stellar-sdk";

import type { EncryptedPrivacyStateStore } from "./privacy-state-store.js";
import type { AgentIdentityState, ChainConfirmation } from "./state.js";

export type PrivateAgentRole = AgentIdentityState["role"];

export interface PublicAgentIdentity {
  readonly sessionId: string;
  readonly role: PrivateAgentRole;
  readonly publicKeyHex: string;
  readonly validUntilLedger: number;
  readonly status: AgentIdentityState["status"];
  readonly contractId?: string;
  readonly deploymentConfirmation?: ChainConfirmation;
}

export interface AgentDigestSignature {
  readonly publicKeyHex: string;
  readonly signature: Buffer;
}

type SeedGenerator = () => Uint8Array;

function publicIdentity(identity: AgentIdentityState): PublicAgentIdentity {
  return Object.freeze({
    sessionId: identity.sessionId,
    role: identity.role,
    publicKeyHex: identity.publicKeyHex,
    validUntilLedger: identity.validUntilLedger,
    status: identity.status,
    ...(identity.contractId ? { contractId: identity.contractId } : {}),
    ...(identity.deploymentConfirmation ? { deploymentConfirmation: identity.deploymentConfirmation } : {}),
  });
}

function assertDigest(digest: Uint8Array): void {
  if (digest.length !== 32) throw new RangeError("agent authorization digest must be exactly 32 bytes");
}

/**
 * Trusted-boundary manager for ephemeral AgentAccount signing identities.
 * Raw seeds never leave this class and are persisted only through the encrypted
 * authoritative PrivacyStateStore.
 */
export class AgentIdentityVault {
  readonly #store: EncryptedPrivacyStateStore;
  readonly #seedGenerator: SeedGenerator;

  constructor(store: EncryptedPrivacyStateStore, seedGenerator: SeedGenerator = () => randomBytes(32)) {
    this.#store = store;
    this.#seedGenerator = seedGenerator;
  }

  async prepare(input: {
    readonly sessionId: string;
    readonly role: PrivateAgentRole;
    readonly validUntilLedger: number;
    readonly createdAtUnixMs?: number;
  }): Promise<PublicAgentIdentity> {
    return this.#store.transaction((state) => {
      const existing = state.agentIdentities.find(
        (identity) => identity.sessionId === input.sessionId && identity.role === input.role,
      );
      if (existing) {
        if (existing.validUntilLedger !== input.validUntilLedger) {
          throw new Error("agent identity expiry differs from the existing session-bound identity");
        }
        return publicIdentity(existing);
      }

      const seed = Buffer.from(this.#seedGenerator());
      if (seed.length !== 32) {
        seed.fill(0);
        throw new RangeError("agent identity seed generator must return exactly 32 bytes");
      }
      try {
        const keypair = Keypair.fromRawEd25519Seed(seed);
        const identity: AgentIdentityState = {
          sessionId: input.sessionId,
          role: input.role,
          seedHex: seed.toString("hex"),
          publicKeyHex: Buffer.from(keypair.rawPublicKey()).toString("hex"),
          validUntilLedger: input.validUntilLedger,
          status: "KEY_READY",
          createdAtUnixMs: input.createdAtUnixMs ?? Date.now(),
        };
        state.agentIdentities.push(identity);
        return publicIdentity(identity);
      } finally {
        seed.fill(0);
      }
    });
  }

  async confirmDeployment(input: {
    readonly sessionId: string;
    readonly role: PrivateAgentRole;
    readonly contractId: string;
    readonly confirmation: ChainConfirmation;
  }): Promise<PublicAgentIdentity> {
    if (!StrKey.isValidContract(input.contractId)) throw new TypeError("agent contract id is not canonical");
    return this.#store.transaction((state) => {
      const identity = state.agentIdentities.find(
        (candidate) => candidate.sessionId === input.sessionId && candidate.role === input.role,
      );
      if (!identity) throw new Error("agent identity key must be prepared before deployment confirmation");
      if (identity.status === "DEPLOYED") {
        if (
          identity.contractId !== input.contractId
          || identity.deploymentConfirmation?.transactionHash !== input.confirmation.transactionHash
          || identity.deploymentConfirmation.ledgerSequence !== input.confirmation.ledgerSequence
        ) {
          throw new Error("agent identity is already bound to another deployment");
        }
        return publicIdentity(identity);
      }
      identity.status = "DEPLOYED";
      identity.contractId = input.contractId;
      identity.deploymentConfirmation = input.confirmation;
      return publicIdentity(identity);
    });
  }

  async resolve(sessionId: string, role: PrivateAgentRole): Promise<PublicAgentIdentity> {
    const state = await this.#store.readSnapshot();
    const identity = state.agentIdentities.find(
      (candidate) => candidate.sessionId === sessionId && candidate.role === role,
    );
    if (!identity) throw new Error("session-bound agent identity is not prepared");
    return publicIdentity(identity);
  }

  async resolveContract(contractId: string): Promise<PublicAgentIdentity> {
    if (!StrKey.isValidContract(contractId)) throw new TypeError("agent contract id is not canonical");
    const state = await this.#store.readSnapshot();
    const identity = state.agentIdentities.find(
      (candidate) => candidate.status === "DEPLOYED" && candidate.contractId === contractId,
    );
    if (!identity) throw new Error("no deployed encrypted agent identity matches the required authorizer");
    return publicIdentity(identity);
  }

  async signForContract(contractId: string, digest: Uint8Array): Promise<AgentDigestSignature> {
    if (!StrKey.isValidContract(contractId)) throw new TypeError("agent contract id is not canonical");
    assertDigest(digest);
    const state = await this.#store.readSnapshot();
    const identity = state.agentIdentities.find(
      (candidate) => candidate.status === "DEPLOYED" && candidate.contractId === contractId,
    );
    if (!identity) throw new Error("no deployed encrypted agent identity matches the required authorizer");
    const seed = Buffer.from(identity.seedHex, "hex");
    try {
      const keypair = Keypair.fromRawEd25519Seed(seed);
      if (Buffer.from(keypair.rawPublicKey()).toString("hex") !== identity.publicKeyHex) {
        throw new Error("agent identity public key does not match its encrypted signing seed");
      }
      return Object.freeze({
        publicKeyHex: identity.publicKeyHex,
        signature: Buffer.from(keypair.sign(digest)),
      });
    } finally {
      seed.fill(0);
    }
  }
}
