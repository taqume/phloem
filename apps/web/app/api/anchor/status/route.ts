import { NextRequest, NextResponse } from "next/server";

import type { AnchorTransaction } from "../../../../lib/anchor-types";
import { anchorJson, bearer, discoverAnchor } from "../../../../lib/server/anchor";
import { ANCHOR_SESSION_COOKIE, openAnchorSession } from "../../../../lib/server/anchor-session";
import { apiError } from "../../../../lib/server/api-response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get("id");
    if (!id || id.length > 256) return NextResponse.json({ error: "Anchor transaction id is required." }, { status: 400 });
    const session = openAnchorSession(request.cookies.get(ANCHOR_SESSION_COOKIE)?.value);
    const discovery = await discoverAnchor();
    const url = new URL(`${discovery.transferServer}/transaction`);
    url.searchParams.set("id", id);
    const payload = await anchorJson<{ transaction?: AnchorTransaction }>(url.toString(), {
      headers: bearer(session.token),
    });
    if (!payload.transaction) throw new Error("Anchor did not return the requested transaction.");
    return NextResponse.json(payload, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    return apiError(reason);
  }
}
