import { randomBytes } from "node:crypto";

import type { ExpectedAgentIntent } from "@phloem/execution-gateway";
import { rpc } from "@stellar/stellar-sdk";

import { PHLOEM_NETWORK } from "../network";
import { createP0LiveAgentRuntime, openEncryptedAgentIdentityVault } from "./live-agent-runtime";

function canonicalSessionId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError("session id must be 32-byte lowercase hexadecimal");
  }
  return value;
}

async function assertReservationIsFresh(
  sessionId: string,
  researchIdentity: string,
  reservationAmountAtomic: string,
): Promise<void> {
  const { store } = await openEncryptedAgentIdentityVault();
  try {
    const latestLedger = (await new rpc.Server(PHLOEM_NETWORK.rpcUrl).getLatestLedger()).sequence;
    await store.transaction((state) => {
      for (const reservation of state.reservations) {
        if (reservation.sessionId !== sessionId
          || reservation.status !== "OPEN"
          || reservation.claimDeadlineLedger >= latestLedger) continue;
        const source = state.budgetNotes.find((note) => note.noteId === reservation.sourceBudgetNoteId);
        if (source?.owner === researchIdentity) reservation.status = "EXPIRED";
      }
    });
    const snapshot = await store.readSnapshot();
    const researchNotes = snapshot.budgetNotes.filter((note) => (
      note.sessionId === sessionId && note.owner === researchIdentity && note.status === "ACTIVE"
    ));
    const existingReservations = snapshot.reservations.filter((reservation) => {
      if (reservation.sessionId !== sessionId
        || reservation.status === "RECLAIMED"
        || reservation.status === "EXPIRED"
        || reservation.status === "SETTLED") return false;
      const source = snapshot.budgetNotes.find((note) => note.noteId === reservation.sourceBudgetNoteId);
      return source?.owner === researchIdentity;
    });
    if (researchNotes.length !== 1
      || BigInt(researchNotes[0]!.amountAtomic) < BigInt(reservationAmountAtomic)) {
      throw new Error("Research does not own one live PRIVATE budget note large enough for the offer");
    }
    if (existingReservations.length !== 0) {
      throw new Error("Research already has a private payment reservation");
    }
  } finally {
    store.close();
  }
}

export async function runLiveResearchReservation(sessionIdInput: unknown) {
  if (!process.env.GOOGLE_API_KEY && !process.env.GEMINI_API_KEY && !process.env.NVIDIA_API_KEY) {
    throw new Error("GOOGLE_API_KEY, GEMINI_API_KEY, or NVIDIA_API_KEY is required for the live agent run");
  }
  const sessionId = canonicalSessionId(sessionIdInput);
  const runtime = await createP0LiveAgentRuntime(sessionId);
  try {
    const researchIdentity = runtime.identities.RESEARCH.contractId;
    if (!researchIdentity) throw new Error("Research AgentAccount is not deployed");
    const offer = await runtime.currentOffer();
    await assertReservationIsFresh(sessionId, researchIdentity, offer.offer.fixedPriceAtomic);
    const [researchContext, builderContext] = await Promise.all([
      runtime.contextFor("RESEARCH", {
        task: [
          "Call request_payment exactly once with",
          `sessionId=${sessionId},`,
          "agent=RESEARCH, serviceId=research-data-service,",
          `offerReferenceHash=${offer.referenceHash},`,
          `amountAtomic=${offer.offer.fixedPriceAtomic}.`,
        ].join(" "),
        policySummary: "These exact signed-offer values are the only accepted payment intent. The deterministic gateway rejects every differing value before submission.",
      }),
      runtime.contextFor("BUILDER", {
        task: "Read exactly your own current PRIVATE budget node described by protocolState.",
        policySummary: "Use get_budget for the exact current session and nodeId. This is a read-only action and cannot move assets.",
      }),
    ]);
    const expectedResearch = {
      type: "request_payment",
      sessionId,
      agent: "RESEARCH",
      serviceId: "research-data-service",
      offerReferenceHash: offer.referenceHash,
      amountAtomic: offer.offer.fixedPriceAtomic,
    } as const satisfies ExpectedAgentIntent;
    const expectedBuilder = {
      type: "get_budget",
      sessionId,
      nodeId: builderContext.protocolState.nodeId,
    } as const satisfies ExpectedAgentIntent;
    const [research, builder] = await Promise.all([
      runtime.runner.runExpectedAgentStep(
        "RESEARCH",
        researchContext,
        expectedResearch,
        { submitFinancial: true },
      ),
      runtime.runner.runExpectedAgentStep(
        "BUILDER",
        builderContext,
        expectedBuilder,
        { submitFinancial: false },
      ),
    ]);
    if (research.gateway.kind !== "SUBMITTED") {
      throw new Error(`Research reservation did not reach confirmed submission: ${research.gateway.kind}`);
    }
    if (builder.gateway.kind !== "READ") {
      throw new Error(`Builder budget request did not resolve as a read: ${builder.gateway.kind}`);
    }

    const { store } = await openEncryptedAgentIdentityVault();
    try {
      const snapshot = await store.readSnapshot();
      const reservations = snapshot.reservations.filter((reservation) => {
        if (reservation.sessionId !== sessionId || reservation.status !== "OPEN") return false;
        const source = snapshot.budgetNotes.find((note) => note.noteId === reservation.sourceBudgetNoteId);
        return source?.owner === researchIdentity;
      });
      if (reservations.length !== 1) {
        throw new Error(`expected one confirmed Research reservation, found ${reservations.length}`);
      }
      const reservation = reservations[0]!;
      return Object.freeze({
        sessionId,
        provider: research.generated.provider,
        model: Object.freeze({
          research: research.generated.model,
          builder: builder.generated.model,
        }),
        reservation: Object.freeze({
          reservationId: reservation.reservationId,
          claimDeadlineLedger: reservation.claimDeadlineLedger,
          transactionHash: research.gateway.receipt.transactionHash,
          ledgerSequence: research.gateway.receipt.ledgerSequence,
        }),
        builderRead: Object.freeze({
          ledgerSequence: builder.gateway.result.ledgerSequence,
          nodeId: builderContext.protocolState.nodeId,
          privateAmountRedacted: true as const,
        }),
      });
    } finally {
      store.close();
    }
  } finally {
    runtime.close();
  }
}

export async function runLiveResearchService(sessionIdInput: unknown) {
  if (!process.env.GOOGLE_API_KEY && !process.env.GEMINI_API_KEY && !process.env.NVIDIA_API_KEY) {
    throw new Error("GOOGLE_API_KEY, GEMINI_API_KEY, or NVIDIA_API_KEY is required for the live Research run");
  }
  const sessionId = canonicalSessionId(sessionIdInput);
  const runtime = await createP0LiveAgentRuntime(sessionId);
  try {
    const requestId = randomBytes(32).toString("hex");
    const query = "Stellar privacy-preserving autonomous agent payments";
    const context = await runtime.contextFor("RESEARCH", {
      task: [
        "Call request_service exactly once with",
        `sessionId=${sessionId}, agent=RESEARCH, serviceId=research-data-service,`,
        `requestId=${requestId}, query=${JSON.stringify(query)}.`,
      ].join(" "),
      policySummary: "Use only the already reserved controlled Research Data Service. The gateway verifies its HTTP response, ServiceOffer, request binding, response hash, and UsageEvidence signature.",
    });
    const expected = {
      type: "request_service",
      sessionId,
      agent: "RESEARCH",
      serviceId: "research-data-service",
      requestId,
      query,
    } as const satisfies ExpectedAgentIntent;
    const trace = await runtime.runner.runExpectedAgentStep(
      "RESEARCH",
      context,
      expected,
      { submitFinancial: false },
    );
    if (trace.gateway.kind !== "SERVICE") {
      throw new Error(`Research provider request did not resolve as a service call: ${trace.gateway.kind}`);
    }
    const voucher = await runtime.acceptProviderEvidence(trace.gateway.result.signedUsageEvidence);
    return Object.freeze({
      sessionId,
      provider: trace.generated.provider,
      model: trace.generated.model,
      requestId: trace.gateway.result.requestId,
      responseHash: trace.gateway.result.responseHash,
      evidence: Object.freeze({
        evidenceHash: voucher.evidenceHash,
        usageRoot: voucher.usageRoot,
      }),
      voucher: Object.freeze({
        sequence: voucher.voucherSequence,
        cumulativeAmountCommitment: voucher.cumulativeAmountCommitment,
        expiryLedger: voucher.expiryLedger,
      }),
    });
  } finally {
    runtime.close();
  }
}
