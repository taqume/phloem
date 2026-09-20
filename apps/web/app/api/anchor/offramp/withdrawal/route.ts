import { type NextRequest, NextResponse } from "next/server";

import type { AnchorQuote, AnchorWithdrawal } from "../../../../../lib/anchor-types";
import { PHLOEM_NETWORK } from "../../../../../lib/network";
import { AnchorRequestError, anchorJson, assertAccount, bearer, discoverAnchor } from "../../../../../lib/server/anchor";
import { ANCHOR_SESSION_COOKIE, openAnchorSession } from "../../../../../lib/server/anchor-session";
import { apiError, assertSameOrigin } from "../../../../../lib/server/api-response";
import {
  parseUsdcAmount,
  providerSettlementAccount,
  type Sep6Info,
  type Sep38Info,
  validateProviderOfframpCapability,
  validateProviderOfframpQuote,
  validateProviderWithdrawal,
} from "../../../../../lib/server/provider-anchor-offramp";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const body = (await request.json()) as { account?: unknown; amount?: unknown; quoteId?: unknown };
    assertAccount(body.account);
    const amount = parseUsdcAmount(body.amount);
    if (typeof body.quoteId !== "string" || !body.quoteId || body.quoteId.length > 256) {
      throw new AnchorRequestError("A valid SEP-38 quote id is required.", 400);
    }
    const providerAccount = providerSettlementAccount();
    if (body.account !== providerAccount) {
      throw new AnchorRequestError("Connected wallet is not the controlled provider settlement account.", 403);
    }
    const session = openAnchorSession(request.cookies.get(ANCHOR_SESSION_COOKIE)?.value);
    if (session.account !== providerAccount) {
      throw new AnchorRequestError("Provider wallet does not match the Anchor session.", 403);
    }

    const discovery = await discoverAnchor();
    const [sep6, sep38, quote] = await Promise.all([
      anchorJson<Sep6Info>(`${discovery.transferServer}/info`),
      anchorJson<Sep38Info>(`${discovery.sep38Server}/info`),
      anchorJson<AnchorQuote>(`${discovery.sep38Server}/quote/${encodeURIComponent(body.quoteId)}`, {
        headers: bearer(session.token),
      }),
    ]);
    validateProviderOfframpCapability({ providerAccount, sep6, sep38 });
    validateProviderOfframpQuote(quote, amount);
    if (quote.id !== body.quoteId) throw new AnchorRequestError("Anchor returned a different firm quote.", 409);

    const url = new URL(`${discovery.transferServer}/withdraw-exchange`);
    url.searchParams.set("source_asset", PHLOEM_NETWORK.assetCode);
    url.searchParams.set("destination_asset", "iso4217:TRY");
    url.searchParams.set("amount", quote.sell_amount);
    url.searchParams.set("funding_method", "bank_account");
    url.searchParams.set("account", providerAccount);
    url.searchParams.set("quote_id", quote.id);
    const withdrawal = validateProviderWithdrawal(await anchorJson<AnchorWithdrawal>(url.toString(), {
      headers: bearer(session.token),
    }));
    return NextResponse.json({ withdrawal }, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    return apiError(reason);
  }
}
