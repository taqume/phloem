import { type NextRequest, NextResponse } from "next/server";

import { assertSameOrigin } from "../../../../../../lib/server/api-response";
import { runLiveUnauthorizedBudgetRead } from "../../../../../../lib/server/live-research";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const input = (await request.json()) as { sessionId?: unknown };
    const result = await runLiveUnauthorizedBudgetRead(input.sessionId);
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "live authorization rejection check failed.";
    return NextResponse.json({ error: message }, { status: 400, headers: { "cache-control": "no-store" } });
  }
}
