import { type NextRequest, NextResponse } from "next/server";

import { assertSameOrigin } from "../../../../../lib/server/api-response";
import { verifySessionFinalization } from "../../../../../lib/server/session-finalization";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const input = await request.json() as { transactionHash?: unknown; sessionId?: unknown; action?: unknown };
    const confirmation = await verifySessionFinalization({
      transactionHash: input.transactionHash,
      sessionId: input.sessionId,
      action: input.action,
    });
    return NextResponse.json(confirmation, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "Session finalization confirmation failed.";
    return NextResponse.json({ error: message }, { status: 400, headers: { "cache-control": "no-store" } });
  }
}
