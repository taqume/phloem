import { type NextRequest, NextResponse } from "next/server";

import { assertSameOrigin } from "../../../../../lib/server/api-response";
import { prepareSessionFinalization } from "../../../../../lib/server/session-finalization";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const input = await request.json() as { company?: unknown; sessionId?: unknown; action?: unknown };
    const prepared = await prepareSessionFinalization({
      company: input.company,
      sessionId: input.sessionId,
      action: input.action,
    });
    return NextResponse.json(prepared, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "Session finalization preparation failed.";
    return NextResponse.json({ error: message }, { status: 400, headers: { "cache-control": "no-store" } });
  }
}
