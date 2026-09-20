import type { ExpectedSupervisorPlan } from "@phloem/execution-gateway";
import { Client } from "@phloem/treasury-controller-client";

import { PHLOEM_NETWORK } from "../network";
import { createP0LiveAgentRuntime, openEncryptedAgentIdentityVault } from "./live-agent-runtime";

const RESEARCH_BUDGET_ATOMIC = "6000000";
const BUILDER_BUDGET_ATOMIC = "1000000";
const CONTROLLED_CATEGORY_MASK = "4";
const PRIVATE_RESERVATION_ACTION_MASK = "4";

function canonicalSessionId(value: unknown): Buffer {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError("session id must be 32-byte lowercase hexadecimal");
  }
  return Buffer.from(value, "hex");
}

function controller(): Client {
  return new Client({
    contractId: PHLOEM_NETWORK.treasuryControllerId,
    networkPassphrase: PHLOEM_NETWORK.networkPassphrase,
    rpcUrl: PHLOEM_NETWORK.rpcUrl,
    publicKey: PHLOEM_NETWORK.executionFeePayerPublicKey,
  });
}

async function assertFreshChildAuthority(sessionId: string): Promise<void> {
  const { store, vault } = await openEncryptedAgentIdentityVault();
  try {
    const [supervisor, research, builder, snapshot] = await Promise.all([
      vault.resolve(sessionId, "SUPERVISOR"),
      vault.resolve(sessionId, "RESEARCH"),
      vault.resolve(sessionId, "BUILDER"),
      store.readSnapshot(),
    ]);
    if (!supervisor.contractId || !research.contractId || !builder.contractId) {
      throw new Error("all session-bound AgentAccounts must be deployed before live execution");
    }
    const activeSupervisor = snapshot.budgetNotes.filter((note) => (
      note.sessionId === sessionId && note.owner === supervisor.contractId && note.status === "ACTIVE"
    ));
    const existingChildren = snapshot.budgetNotes.filter((note) => (
      note.sessionId === sessionId
      && (note.owner === research.contractId || note.owner === builder.contractId)
      && note.status !== "SPENT"
    ));
    const pending = snapshot.privateBudgetDelegations.filter((delegation) => (
      delegation.sessionId === sessionId && delegation.status === "PREPARED"
    ));
    if (activeSupervisor.length !== 1 || activeSupervisor[0]!.amountAtomic !== "10000000") {
      throw new Error("Supervisor does not own the exact fresh 1 USDC P0 authority");
    }
    if (existingChildren.length !== 0 || pending.length !== 0) {
      throw new Error("Research/Builder authority is already present or a delegation is pending");
    }
  } finally {
    store.close();
  }
}

export async function runLiveSupervisorDelegations(sessionIdInput: unknown) {
  if (!process.env.NVIDIA_API_KEY) throw new Error("NVIDIA_API_KEY is required for the live Supervisor run");
  const sessionIdBytes = canonicalSessionId(sessionIdInput);
  const sessionId = sessionIdBytes.toString("hex");
  await assertFreshChildAuthority(sessionId);
  const session = (await controller().get_session({ session_id: sessionIdBytes })).result;
  if (!session
    || session.lifecycle.tag !== "Active"
    || session.safety.tag !== "Normal"
    || session.settlement_mode.tag !== "Private") {
    throw new Error("canonical session is not active PRIVATE authority");
  }
  const expiry = session.expires_at_ledger;
  const plan: ExpectedSupervisorPlan = Object.freeze({
    RESEARCH: Object.freeze({
      amountAtomic: RESEARCH_BUDGET_ATOMIC,
      categoryMask: CONTROLLED_CATEGORY_MASK,
      allowedActionsMask: PRIVATE_RESERVATION_ACTION_MASK,
      expiresAtLedger: expiry,
      remainingDelegationDepth: 0 as const,
    }),
    BUILDER: Object.freeze({
      amountAtomic: BUILDER_BUDGET_ATOMIC,
      categoryMask: CONTROLLED_CATEGORY_MASK,
      allowedActionsMask: PRIVATE_RESERVATION_ACTION_MASK,
      expiresAtLedger: expiry,
      remainingDelegationDepth: 0 as const,
    }),
  });
  const runtime = await createP0LiveAgentRuntime(sessionId);
  try {
    const policySummary = [
      "Emit only the exact child delegation selected by the current task.",
      `RESEARCH: amountAtomic=${RESEARCH_BUDGET_ATOMIC}, categoryMask=${CONTROLLED_CATEGORY_MASK}, allowedActionsMask=${PRIVATE_RESERVATION_ACTION_MASK}, expiresAtLedger=${expiry}, remainingDelegationDepth=0.`,
      `BUILDER: amountAtomic=${BUILDER_BUDGET_ATOMIC}, categoryMask=${CONTROLLED_CATEGORY_MASK}, allowedActionsMask=${PRIVATE_RESERVATION_ACTION_MASK}, expiresAtLedger=${expiry}, remainingDelegationDepth=0.`,
      "The deterministic gateway rejects every differing value before submission.",
    ].join(" ");
    const context = await runtime.contextFor("SUPERVISOR", {
      task: "Delegate the exact P0 child authorities described by policySummary.",
      policySummary,
    });
    const result = await runtime.runner.runSupervisorDelegations(context, plan);
    return Object.freeze({
      sessionId,
      provider: result.research.generated.provider,
      model: Object.freeze({
        researchDelegation: result.research.generated.model,
        builderDelegation: result.builder.generated.model,
      }),
      actions: Object.freeze({
        research: result.research.generated.action,
        builder: result.builder.generated.action,
      }),
      confirmations: result.confirmations,
    });
  } finally {
    runtime.close();
  }
}
