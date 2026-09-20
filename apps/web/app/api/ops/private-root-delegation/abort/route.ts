import { type NextRequest, NextResponse } from "next/server";

import { assertSameOrigin } from "../../../../../lib/server/api-response";
import { abortPrivateRootDelegation } from "../../../../../lib/server/private-root-delegation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const input = (await request.json()) as { operationId?: unknown; sessionId?: unknown };
    if (typeof input.operationId !== "string" || typeof input.sessionId !== "string") {
      throw new TypeError("operationId and sessionId must be strings");
    }
    await abortPrivateRootDelegation({ operationId: input.operationId, sessionId: input.sessionId });
    return NextResponse.json({ discarded: true }, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "PRIVATE root delegation abort failed.";
    return NextResponse.json({ error: message }, { status: 400, headers: { "cache-control": "no-store" } });
  }
}
