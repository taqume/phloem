import { type NextRequest, NextResponse } from "next/server";

import { assertSameOrigin } from "../../../../../lib/server/api-response";
import { preparePrivateSessionCreation } from "../../../../../lib/server/private-session";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const input = (await request.json()) as { company?: unknown };
    if (typeof input.company !== "string") throw new TypeError("company must be a Stellar account address");
    const prepared = await preparePrivateSessionCreation({ company: input.company });
    return NextResponse.json(prepared, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "PRIVATE session preparation failed.";
    return NextResponse.json({ error: message }, { status: 400, headers: { "cache-control": "no-store" } });
  }
}
