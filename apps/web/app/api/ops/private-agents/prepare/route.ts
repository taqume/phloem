import { type NextRequest, NextResponse } from "next/server";

import type { PrivateAgentRole } from "@phloem/privacy-runtime/agent-identities";

import { assertSameOrigin } from "../../../../../lib/server/api-response";
import { preparePrivateAgentDeployment } from "../../../../../lib/server/private-agent-deployment";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const input = (await request.json()) as { company?: unknown; sessionId?: unknown; role?: unknown };
    if (typeof input.company !== "string" || typeof input.sessionId !== "string" || typeof input.role !== "string") {
      throw new TypeError("company, sessionId, and role are required");
    }
    const prepared = await preparePrivateAgentDeployment({
      company: input.company,
      sessionId: input.sessionId,
      role: input.role as PrivateAgentRole,
    });
    return NextResponse.json(prepared, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "AgentAccount preparation failed.";
    return NextResponse.json({ error: message }, { status: 400, headers: { "cache-control": "no-store" } });
  }
}
