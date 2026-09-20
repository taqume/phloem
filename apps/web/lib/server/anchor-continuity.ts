import { createHash } from "node:crypto";

import type { DegradedRailReceipt } from "../anchor-types";

interface CreateDegradedRailReceiptInput {
  anchorDomain: string;
  anchorError?: string;
  anchorStatus: string | null;
  anchorTransactionId: string;
  observedAt: string;
  walletAccount: string;
}

export function createDegradedRailReceipt(input: CreateDegradedRailReceiptInput): DegradedRailReceipt {
  if (input.anchorStatus === "completed") {
    throw new Error("A completed Anchor transaction cannot be represented as degraded.");
  }

  const evidence = {
    anchorObservation: {
      domain: input.anchorDomain,
      ...(input.anchorError ? { error: input.anchorError } : {}),
      observedAt: input.observedAt,
      reachable: input.anchorStatus !== null,
      status: input.anchorStatus,
      transactionId: input.anchorTransactionId,
    },
    mode: "DEGRADED_DEMO" as const,
    reason: "OFFICIAL_ANCHOR_SETTLEMENT_STALLED" as const,
    schema: "phloem.degraded-fiat-rail/v1" as const,
    scope: {
      anchorAttested: false as const,
      fiatLeg: "SIMULATED_ONLY" as const,
      protocolStateMutation: "NONE" as const,
      stellarAssetMovement: "NONE" as const,
    },
    walletAccount: input.walletAccount,
  };
  const digest = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");

  return {
    ...evidence,
    evidenceDigest: `sha256:${digest}`,
    receiptId: `degraded_rail_${digest.slice(0, 24)}`,
  };
}
