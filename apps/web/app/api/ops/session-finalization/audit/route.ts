import { type NextRequest, NextResponse } from "next/server";

import { assertSameOrigin } from "../../../../../lib/server/api-response";
import { proveAndVerifyAuditQl } from "../../../../../lib/server/session-finalization";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const input = await request.json() as { sessionId?: unknown; thresholdAtomic?: unknown };
    const result = await proveAndVerifyAuditQl({
      sessionId: input.sessionId,
      thresholdAtomic: input.thresholdAtomic,
    });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "AuditQL proof verification failed.";
    return NextResponse.json({ error: message }, { status: 400, headers: { "cache-control": "no-store" } });
  }
}
