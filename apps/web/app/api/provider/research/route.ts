import { NextRequest, NextResponse } from "next/server";

import { apiError, assertSameOrigin } from "../../../../lib/server/api-response";
import {
  ProviderRequestError,
  executeResearch,
  latestLedger,
  loadProviderConfig,
} from "../../../../lib/server/research-provider";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const config = loadProviderConfig();
    const bodyPromise = request.json();
    const ledgerPromise = latestLedger();
    const [body, ledger] = await Promise.all([bodyPromise, ledgerPromise]);
    return NextResponse.json(executeResearch(config, body, ledger), { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    if (reason instanceof ProviderRequestError) {
      return NextResponse.json({ error: reason.message }, { status: reason.status });
    }
    return apiError(reason);
  }
}
