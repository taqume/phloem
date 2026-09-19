import { NextResponse } from "next/server";

import { loadProviderConfig } from "../../../../lib/server/research-provider";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  try {
    const config = loadProviderConfig();
    return NextResponse.json({
      service: "research-data-service",
      version: 1,
      ready: true,
      providerIdentity: config.signingKey.publicKey(),
    }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({
      service: "research-data-service",
      version: 1,
      ready: false,
    }, { headers: { "cache-control": "no-store" } });
  }
}
