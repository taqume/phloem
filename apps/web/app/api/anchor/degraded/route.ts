import { NextRequest, NextResponse } from "next/server";

import type { AnchorTransaction } from "../../../../lib/anchor-types";
import { PHLOEM_NETWORK } from "../../../../lib/network";
import { createDegradedRailReceipt } from "../../../../lib/server/anchor-continuity";
import { ANCHOR_SESSION_COOKIE, openAnchorSession } from "../../../../lib/server/anchor-session";
import { AnchorRequestError, anchorJson, assertAccount, bearer, discoverAnchor } from "../../../../lib/server/anchor";
import { apiError, assertSameOrigin } from "../../../../lib/server/api-response";

export const runtime = "nodejs";

function upstreamFailure(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message.slice(0, 240);
  return "Official Anchor status is unreachable.";
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const body = (await request.json()) as { account?: unknown; id?: unknown };
    assertAccount(body.account);
    if (typeof body.id !== "string" || !body.id || body.id.length > 256) {
      throw new AnchorRequestError("Anchor transaction id is required.", 400);
    }

    const session = openAnchorSession(request.cookies.get(ANCHOR_SESSION_COOKIE)?.value);
    if (session.account !== body.account) {
      throw new AnchorRequestError("Connected wallet does not match the Anchor session.", 403);
    }

    let anchorError: string | undefined;
    let anchorStatus: string | null = null;
    try {
      const discovery = await discoverAnchor();
      const url = new URL(`${discovery.transferServer}/transaction`);
      url.searchParams.set("id", body.id);
      const payload = await anchorJson<{ transaction?: AnchorTransaction }>(url.toString(), {
        headers: bearer(session.token),
      });
      if (!payload.transaction) throw new Error("Anchor did not return the requested transaction.");
      anchorStatus = payload.transaction.status;
    } catch (reason) {
      anchorError = upstreamFailure(reason);
    }

    if (anchorStatus === "completed") {
      throw new AnchorRequestError("The official Anchor transaction is already complete; degraded evidence is not allowed.", 409);
    }

    const receipt = createDegradedRailReceipt({
      anchorDomain: PHLOEM_NETWORK.anchorHomeDomain,
      ...(anchorError ? { anchorError } : {}),
      anchorStatus,
      anchorTransactionId: body.id,
      observedAt: new Date().toISOString(),
      walletAccount: body.account,
    });
    return NextResponse.json(
      { receipt },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  } catch (reason) {
    return apiError(reason);
  }
}
