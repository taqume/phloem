import { type NextRequest, NextResponse } from "next/server";

import { assertSameOrigin } from "../../../../../lib/server/api-response";
import { runLiveSupervisorDelegations } from "../../../../../lib/server/live-supervisor";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const input = (await request.json()) as { sessionId?: unknown };
    const result = await runLiveSupervisorDelegations(input.sessionId);
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "live Supervisor execution failed.";
    return NextResponse.json({ error: message }, { status: 400, headers: { "cache-control": "no-store" } });
  }
}
