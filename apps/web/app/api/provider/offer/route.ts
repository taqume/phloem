import { NextResponse } from "next/server";

import { latestLedger, loadProviderConfig, signedOffer } from "../../../../lib/server/research-provider";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const config = loadProviderConfig();
    const ledger = await latestLedger();
    return NextResponse.json({ offer: signedOffer(config, ledger) }, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "Provider offer failed.";
    return NextResponse.json({ error: message }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
