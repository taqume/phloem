import { type NextRequest, NextResponse } from "next/server";

import { assertSameOrigin } from "../../../../../lib/server/api-response";
import { preparePrivateRootDelegation } from "../../../../../lib/server/private-root-delegation";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const input = (await request.json()) as { company?: unknown; sessionId?: unknown };
    if (typeof input.company !== "string" || typeof input.sessionId !== "string") {
      throw new TypeError("company and sessionId must be strings");
    }
    const prepared = await preparePrivateRootDelegation({ company: input.company, sessionId: input.sessionId });
    return NextResponse.json(prepared, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "PRIVATE root delegation preparation failed.";
    return NextResponse.json({ error: message }, { status: 400, headers: { "cache-control": "no-store" } });
  }
}
