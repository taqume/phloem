import { NextResponse } from "next/server";

import type { CompletedSppDeploymentStep } from "../../../../../lib/spp-deployment-types";
import { recordSppDeploymentProgress } from "../../../../../lib/server/spp-deployment";

export const runtime = "nodejs";

interface ProgressInput {
  address: string;
  results: CompletedSppDeploymentStep[];
}

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as ProgressInput;
    const recorded = await recordSppDeploymentProgress(input.address, input.results);
    return NextResponse.json(recorded, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "SPP deployment progress could not be recorded.";
    return NextResponse.json({ error: message }, { status: 400, headers: { "cache-control": "no-store" } });
  }
}
