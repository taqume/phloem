import { NextRequest, NextResponse } from "next/server";

import { PHLOEM_NETWORK } from "../../../../lib/network";
import { anchorJson, bearer, discoverAnchor, parseTryAmount } from "../../../../lib/server/anchor";
import { ANCHOR_SESSION_COOKIE, openAnchorSession } from "../../../../lib/server/anchor-session";
import { apiError, assertSameOrigin } from "../../../../lib/server/api-response";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const body = (await request.json()) as { amount?: unknown; id?: unknown };
    if (typeof body.id !== "string" || !body.id || body.id.length > 256) {
      return NextResponse.json({ error: "Anchor transaction id is required." }, { status: 400 });
    }
    const amount = parseTryAmount(body.amount);
    const session = openAnchorSession(request.cookies.get(ANCHOR_SESSION_COOKIE)?.value);
    const discovery = await discoverAnchor();
    if (new URL(discovery.transferServer).hostname !== PHLOEM_NETWORK.anchorHomeDomain) {
      throw new Error("Sandbox transfer simulation is disabled for non-official Anchor hosts.");
    }
    const url = `${discovery.transferServer}/tx/${encodeURIComponent(body.id)}/simulate-bank-transfer`;
    const result = await anchorJson<Record<string, unknown>>(url, {
      method: "POST",
      headers: {
        ...bearer(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({ amount }),
    });
    return NextResponse.json({ accepted: true, result }, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    return apiError(reason);
  }
}
