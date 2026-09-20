import { type NextRequest, NextResponse } from "next/server";

import { assertSameOrigin } from "../../../../../lib/server/api-response";
import { confirmPrivateRootDelegation } from "../../../../../lib/server/private-root-delegation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const input = (await request.json()) as {
      transactionHash?: unknown;
      operationId?: unknown;
      sessionId?: unknown;
    };
    if (typeof input.transactionHash !== "string"
      || typeof input.operationId !== "string"
      || typeof input.sessionId !== "string") {
      throw new TypeError("transactionHash, operationId and sessionId must be strings");
    }
    const confirmed = await confirmPrivateRootDelegation({
      transactionHash: input.transactionHash,
      operationId: input.operationId,
      sessionId: input.sessionId,
    });
    return NextResponse.json(confirmed, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "PRIVATE root delegation confirmation failed.";
    return NextResponse.json({ error: message }, { status: 400, headers: { "cache-control": "no-store" } });
  }
}
