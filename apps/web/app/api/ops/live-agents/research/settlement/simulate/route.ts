import { type NextRequest, NextResponse } from "next/server";

import { assertSameOrigin } from "../../../../../../../lib/server/api-response";
import { simulateLivePrivateSettlement } from "../../../../../../../lib/server/live-private-settlement";

export const runtime = "nodejs";
export const maxDuration = 600;

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const input = (await request.json()) as { sessionId?: unknown; reservationId?: unknown };
    const result = await simulateLivePrivateSettlement({
      sessionId: input.sessionId,
      reservationId: input.reservationId,
    });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "PRIVATE settlement simulation failed.";
    return NextResponse.json({ error: message }, { status: 400, headers: { "cache-control": "no-store" } });
  }
}
