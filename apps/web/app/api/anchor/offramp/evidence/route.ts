import { NextResponse } from "next/server";

import { apiError } from "../../../../../lib/server/api-response";
import { loadCanonicalProviderExitEvidence } from "../../../../../lib/server/provider-anchor-offramp";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const providerExit = await loadCanonicalProviderExitEvidence();
    return NextResponse.json({ providerExit }, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    return apiError(reason);
  }
}
