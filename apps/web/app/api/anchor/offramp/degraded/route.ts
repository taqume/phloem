import { type NextRequest, NextResponse } from "next/server";

import type { AnchorTransaction } from "../../../../../lib/anchor-types";
import { PHLOEM_NETWORK } from "../../../../../lib/network";
import { AnchorRequestError, anchorJson, assertAccount, bearer, discoverAnchor } from "../../../../../lib/server/anchor";
import { ANCHOR_SESSION_COOKIE, openAnchorSession } from "../../../../../lib/server/anchor-session";
import { apiError, assertSameOrigin } from "../../../../../lib/server/api-response";
import {
  assertProviderSppExitEvidence,
  createDegradedProviderOfframpReceipt,
  providerSettlementAccount,
  type Sep6Info,
  type Sep38Info,
  validateProviderOfframpCapability,
} from "../../../../../lib/server/provider-anchor-offramp";

export const runtime = "nodejs";

interface HorizonTransaction {
  envelope_xdr?: string;
  hash?: string;
  successful?: boolean;
}

function transactionHash(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new AnchorRequestError("Provider SPP exit transaction hash must be 32-byte lowercase hexadecimal.", 400);
  }
  return value;
}

function amountAtomic(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new AnchorRequestError("Provider settlement amount must be a positive atomic integer.", 400);
  }
  return value;
}

function failureMessage(reason: unknown): string {
  return reason instanceof Error && reason.message
    ? reason.message.slice(0, 240)
    : "Official Anchor withdrawal is unreachable.";
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const body = (await request.json()) as {
      account?: unknown;
      amountAtomic?: unknown;
      sppExitTransactionHash?: unknown;
      transactionId?: unknown;
    };
    assertAccount(body.account);
    const providerAccount = providerSettlementAccount();
    if (body.account !== providerAccount) {
      throw new AnchorRequestError("Connected wallet is not the controlled provider settlement account.", 403);
    }
    const exitHash = transactionHash(body.sppExitTransactionHash);
    const settledAmountAtomic = amountAtomic(body.amountAtomic);

    const evidenceResponse = await fetch(`${PHLOEM_NETWORK.horizonUrl}/transactions/${exitHash}`, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!evidenceResponse.ok) {
      throw new AnchorRequestError(`Provider SPP exit lookup returned Horizon HTTP ${evidenceResponse.status}.`, 409);
    }
    const evidence = (await evidenceResponse.json()) as HorizonTransaction;
    if (!evidence.successful || evidence.hash !== exitHash || !evidence.envelope_xdr) {
      throw new AnchorRequestError("Provider SPP exit is not a successful canonical Testnet transaction.", 409);
    }
    assertProviderSppExitEvidence({ envelopeXdr: evidence.envelope_xdr, transactionHash: exitHash });

    let anchorError: string | undefined;
    let anchorStatus: string | null = null;
    let anchorTransactionId: string | null = null;
    if (typeof body.transactionId === "string" && body.transactionId && body.transactionId.length <= 256) {
      anchorTransactionId = body.transactionId;
      const session = openAnchorSession(request.cookies.get(ANCHOR_SESSION_COOKIE)?.value);
      if (session.account !== providerAccount) {
        throw new AnchorRequestError("Provider wallet does not match the Anchor session.", 403);
      }
      try {
        const discovery = await discoverAnchor();
        const url = new URL(`${discovery.transferServer}/transaction`);
        url.searchParams.set("id", anchorTransactionId);
        const payload = await anchorJson<{ transaction?: AnchorTransaction }>(url.toString(), {
          headers: bearer(session.token),
        });
        if (!payload.transaction || payload.transaction.id !== anchorTransactionId) {
          throw new Error("Anchor did not return the requested withdrawal.");
        }
        anchorStatus = payload.transaction.status;
      } catch (reason) {
        anchorError = failureMessage(reason);
      }
    } else {
      try {
        const discovery = await discoverAnchor();
        const [sep6, sep38] = await Promise.all([
          anchorJson<Sep6Info>(`${discovery.transferServer}/info`),
          anchorJson<Sep38Info>(`${discovery.sep38Server}/info`),
        ]);
        validateProviderOfframpCapability({ providerAccount, sep6, sep38 });
        throw new AnchorRequestError(
          "The official off-ramp is currently advertised; create a real withdrawal before using degraded evidence.",
          409,
        );
      } catch (reason) {
        if (reason instanceof AnchorRequestError && reason.status === 409) throw reason;
        anchorError = failureMessage(reason);
      }
    }
    if (anchorStatus === "completed") {
      throw new AnchorRequestError("The official Anchor withdrawal is complete; degraded evidence is not allowed.", 409);
    }

    const receipt = createDegradedProviderOfframpReceipt({
      ...(anchorError ? { anchorError } : {}),
      anchorStatus,
      anchorTransactionId,
      amountAtomic: settledAmountAtomic,
      observedAt: new Date().toISOString(),
      providerAccount,
      sppExitTransactionHash: exitHash,
    });
    return NextResponse.json({ receipt }, { status: 202, headers: { "cache-control": "no-store" } });
  } catch (reason) {
    return apiError(reason);
  }
}
