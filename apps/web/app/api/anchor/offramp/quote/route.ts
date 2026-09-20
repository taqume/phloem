import { type NextRequest, NextResponse } from "next/server";

import type { AnchorQuote } from "../../../../../lib/anchor-types";
import { PHLOEM_NETWORK } from "../../../../../lib/network";
import { anchorJson, assertAccount, bearer, discoverAnchor } from "../../../../../lib/server/anchor";
import { ANCHOR_SESSION_COOKIE, openAnchorSession } from "../../../../../lib/server/anchor-session";
import { apiError, assertSameOrigin } from "../../../../../lib/server/api-response";
import {
  parseUsdcAmount,
  providerSettlementAccount,
  type Sep6Info,
  type Sep38Info,
  validateProviderOfframpCapability,
  validateProviderOfframpQuote,
} from "../../../../../lib/server/provider-anchor-offramp";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const body = (await request.json()) as { account?: unknown; amount?: unknown };
    assertAccount(body.account);
    const amount = parseUsdcAmount(body.amount);
    const providerAccount = providerSettlementAccount();
    if (body.account !== providerAccount) {
      return NextResponse.json({ error: "Connected wallet is not the controlled provider settlement account." }, { status: 403 });
    }
    const session = openAnchorSession(request.cookies.get(ANCHOR_SESSION_COOKIE)?.value);
    if (session.account !== providerAccount) {
      return NextResponse.json({ error: "Provider wallet does not match the Anchor session." }, { status: 403 });
    }

    const discovery = await discoverAnchor();
    const [sep6, sep38] = await Promise.all([
      anchorJson<Sep6Info>(`${discovery.transferServer}/info`),
      anchorJson<Sep38Info>(`${discovery.sep38Server}/info`),
    ]);
    validateProviderOfframpCapability({ providerAccount, sep6, sep38 });
    const stellarAsset = `stellar:${PHLOEM_NETWORK.assetCode}:${PHLOEM_NETWORK.assetIssuer}`;
    const quote = await anchorJson<AnchorQuote>(`${discovery.sep38Server}/quote`, {
      method: "POST",
      headers: { ...bearer(session.token), "content-type": "application/json" },
      body: JSON.stringify({
        buy_asset: "iso4217:TRY",
        buy_delivery_method: "bank_account",
        context: "sep6",
        sell_amount: amount,
        sell_asset: stellarAsset,
      }),
    });
    validateProviderOfframpQuote(quote, amount);
    return NextResponse.json({ quote }, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    return apiError(reason);
  }
}
