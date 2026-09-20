import { type NextRequest, NextResponse } from "next/server";

import { assertSameOrigin } from "../../../../../lib/server/api-response";
import { abortPrivateActivation } from "../../../../../lib/server/private-activation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const input = (await request.json()) as { operationId?: unknown; sessionId?: unknown };
    if (typeof input.operationId !== "string" || typeof input.sessionId !== "string") {
      throw new TypeError("operationId and sessionId must be strings");
    }
    await abortPrivateActivation({ operationId: input.operationId, sessionId: input.sessionId });
    return NextResponse.json({ discarded: true }, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "PRIVATE activation abort failed.";
    return NextResponse.json({ error: message }, { status: 400, headers: { "cache-control": "no-store" } });
  }
}
