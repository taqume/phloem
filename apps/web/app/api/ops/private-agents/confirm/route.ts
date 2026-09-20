import { type NextRequest, NextResponse } from "next/server";

import type { PrivateAgentDeploymentConfirmationInput } from "../../../../../lib/private-agent-types";
import { assertSameOrigin } from "../../../../../lib/server/api-response";
import { verifyPrivateAgentDeployment } from "../../../../../lib/server/private-agent-deployment";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const confirmation = await verifyPrivateAgentDeployment(
      (await request.json()) as PrivateAgentDeploymentConfirmationInput,
    );
    return NextResponse.json(confirmation, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "AgentAccount confirmation failed.";
    return NextResponse.json({ error: message }, { status: 400, headers: { "cache-control": "no-store" } });
  }
}
