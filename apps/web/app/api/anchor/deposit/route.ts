import { NextRequest, NextResponse } from "next/server";

import type { AnchorDeposit } from "../../../../lib/anchor-types";
import { PHLOEM_NETWORK } from "../../../../lib/network";
import { anchorJson, assertAccount, bearer, discoverAnchor, parseTryAmount } from "../../../../lib/server/anchor";
import { ANCHOR_SESSION_COOKIE, openAnchorSession } from "../../../../lib/server/anchor-session";
import { apiError, assertSameOrigin } from "../../../../lib/server/api-response";

export const runtime = "nodejs";

interface Sep6Info {
  "deposit-exchange"?: Record<string, {
    enabled?: boolean;
    funding_methods?: string[];
  }>;
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const body = (await request.json()) as { account?: unknown; amount?: unknown; quoteId?: unknown };
    assertAccount(body.account);
    const amount = parseTryAmount(body.amount);
    if (typeof body.quoteId !== "string" || !body.quoteId || body.quoteId.length > 256) {
      return NextResponse.json({ error: "A valid SEP-38 quote id is required." }, { status: 400 });
    }

    const session = openAnchorSession(request.cookies.get(ANCHOR_SESSION_COOKIE)?.value);
    if (session.account !== body.account) {
      return NextResponse.json({ error: "Connected wallet does not match the Anchor session." }, { status: 403 });
    }

    const discovery = await discoverAnchor();
    const info = await anchorJson<Sep6Info>(`${discovery.transferServer}/info`);
    const capability = info["deposit-exchange"]?.[PHLOEM_NETWORK.assetCode];
    if (!capability?.enabled || !capability.funding_methods?.includes("bank_account")) {
      throw new Error("Anchor no longer advertises USDC deposit-exchange via bank_account.");
    }

    const url = new URL(`${discovery.transferServer}/deposit-exchange`);
    url.searchParams.set("destination_asset", PHLOEM_NETWORK.assetCode);
    url.searchParams.set("source_asset", "iso4217:TRY");
    url.searchParams.set("amount", amount);
    url.searchParams.set("funding_method", "bank_account");
    url.searchParams.set("account", body.account);
    url.searchParams.set("quote_id", body.quoteId);
    const deposit = await anchorJson<AnchorDeposit>(url.toString(), { headers: bearer(session.token) });
    if (!deposit.id || !deposit.instructions) throw new Error("Anchor returned incomplete deposit instructions.");
    return NextResponse.json({ deposit }, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    return apiError(reason);
  }
}
