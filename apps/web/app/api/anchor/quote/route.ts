import { NextRequest, NextResponse } from "next/server";

import type { AnchorQuote } from "../../../../lib/anchor-types";
import { PHLOEM_NETWORK } from "../../../../lib/network";
import { anchorJson, assertAccount, bearer, discoverAnchor, parseTryAmount } from "../../../../lib/server/anchor";
import { ANCHOR_SESSION_COOKIE, openAnchorSession } from "../../../../lib/server/anchor-session";
import { apiError, assertSameOrigin } from "../../../../lib/server/api-response";

export const runtime = "nodejs";

interface Sep38Info {
  assets?: Array<{ asset?: string; sell_delivery_methods?: Array<{ name?: string }> }>;
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const body = (await request.json()) as { account?: unknown; amount?: unknown };
    assertAccount(body.account);
    const amount = parseTryAmount(body.amount);
    const session = openAnchorSession(request.cookies.get(ANCHOR_SESSION_COOKIE)?.value);
    if (session.account !== body.account) {
      return NextResponse.json({ error: "Connected wallet does not match the Anchor session." }, { status: 403 });
    }

    const discovery = await discoverAnchor();
    const stellarAsset = `stellar:${PHLOEM_NETWORK.assetCode}:${PHLOEM_NETWORK.assetIssuer}`;
    const info = await anchorJson<Sep38Info>(`${discovery.sep38Server}/info`);
    const tryAsset = info.assets?.find((asset) => asset.asset === "iso4217:TRY");
    const supportsPair = info.assets?.some((asset) => asset.asset === stellarAsset) &&
      tryAsset?.sell_delivery_methods?.some((method) => method.name === "bank_account");
    if (!supportsPair) throw new Error("Anchor no longer advertises the TRY/bank_account to USDC quote path.");

    const quote = await anchorJson<AnchorQuote>(`${discovery.sep38Server}/quote`, {
      method: "POST",
      headers: {
        ...bearer(session.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        buy_asset: stellarAsset,
        context: "sep6",
        sell_amount: amount,
        sell_asset: "iso4217:TRY",
        sell_delivery_method: "bank_account",
      }),
    });
    if (!quote.id || !quote.sell_amount || !quote.buy_amount || !quote.expires_at) {
      throw new Error("Anchor returned an incomplete SEP-38 quote.");
    }
    return NextResponse.json({ quote }, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    return apiError(reason);
  }
}
