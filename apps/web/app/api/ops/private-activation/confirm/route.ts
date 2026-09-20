import { type NextRequest, NextResponse } from "next/server";

import type { PrivateActivationConfirmationInput } from "../../../../../lib/private-activation-types";
import { assertSameOrigin } from "../../../../../lib/server/api-response";
import { confirmPrivateActivation } from "../../../../../lib/server/private-activation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const input = (await request.json()) as PrivateActivationConfirmationInput;
    const confirmed = await confirmPrivateActivation(input);
    return NextResponse.json(confirmed, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "PRIVATE activation confirmation failed.";
    return NextResponse.json({ error: message }, { status: 400, headers: { "cache-control": "no-store" } });
  }
}
