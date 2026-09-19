import { NextResponse } from "next/server";

import { prepareSppDeploymentStep, type PrepareSppDeploymentInput } from "../../../../../lib/server/spp-deployment";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as PrepareSppDeploymentInput;
    const prepared = await prepareSppDeploymentStep(input);
    return NextResponse.json(prepared, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "SPP deployment preparation failed.";
    return NextResponse.json({ error: message }, { status: 400, headers: { "cache-control": "no-store" } });
  }
}
