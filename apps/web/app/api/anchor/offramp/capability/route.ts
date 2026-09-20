import { NextResponse } from "next/server";

import { anchorJson, discoverAnchor } from "../../../../../lib/server/anchor";
import { apiError } from "../../../../../lib/server/api-response";
import {
  providerSettlementAccount,
  type Sep6Info,
  type Sep38Info,
  validateProviderOfframpCapability,
} from "../../../../../lib/server/provider-anchor-offramp";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const providerAccount = providerSettlementAccount();
    const discovery = await discoverAnchor();
    const [sep6, sep38] = await Promise.all([
      anchorJson<Sep6Info>(`${discovery.transferServer}/info`),
      anchorJson<Sep38Info>(`${discovery.sep38Server}/info`),
    ]);
    const capability = validateProviderOfframpCapability({ providerAccount, sep6, sep38 });
    return NextResponse.json({ capability }, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    return apiError(reason);
  }
}
