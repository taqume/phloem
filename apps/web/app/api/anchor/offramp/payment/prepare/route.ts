import { type NextRequest, NextResponse } from "next/server";

import type { AnchorQuote, AnchorTransaction } from "../../../../../../lib/anchor-types";
import { PHLOEM_NETWORK } from "../../../../../../lib/network";
import { AnchorRequestError, anchorJson, assertAccount, bearer, discoverAnchor } from "../../../../../../lib/server/anchor";
import { ANCHOR_SESSION_COOKIE, openAnchorSession } from "../../../../../../lib/server/anchor-session";
import { apiError, assertSameOrigin } from "../../../../../../lib/server/api-response";
import {
  buildProviderWithdrawalPayment,
  providerSettlementAccount,
  validateProviderOfframpQuote,
} from "../../../../../../lib/server/provider-anchor-offramp";

export const runtime = "nodejs";

interface HorizonAccount {
  account_id: string;
  sequence: string;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 256) {
    throw new AnchorRequestError(`${label} is required.`, 400);
  }
  return value;
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const body = (await request.json()) as { account?: unknown; quoteId?: unknown; transactionId?: unknown };
    assertAccount(body.account);
    const quoteId = identifier(body.quoteId, "SEP-38 quote id");
    const transactionId = identifier(body.transactionId, "Anchor transaction id");
    const providerAccount = providerSettlementAccount();
    if (body.account !== providerAccount) {
      throw new AnchorRequestError("Connected wallet is not the controlled provider settlement account.", 403);
    }
    const session = openAnchorSession(request.cookies.get(ANCHOR_SESSION_COOKIE)?.value);
    if (session.account !== providerAccount) {
      throw new AnchorRequestError("Provider wallet does not match the Anchor session.", 403);
    }

    const discovery = await discoverAnchor();
    const transactionUrl = new URL(`${discovery.transferServer}/transaction`);
    transactionUrl.searchParams.set("id", transactionId);
    const [quote, transactionPayload, accountResponse] = await Promise.all([
      anchorJson<AnchorQuote>(`${discovery.sep38Server}/quote/${encodeURIComponent(quoteId)}`, {
        headers: bearer(session.token),
      }),
      anchorJson<{ transaction?: AnchorTransaction }>(transactionUrl.toString(), {
        headers: bearer(session.token),
      }),
      fetch(`${PHLOEM_NETWORK.horizonUrl}/accounts/${encodeURIComponent(providerAccount)}`, {
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      }),
    ]);
    if (!transactionPayload.transaction || transactionPayload.transaction.id !== transactionId) {
      throw new AnchorRequestError("Anchor did not return the requested withdrawal.", 502);
    }
    if (!accountResponse.ok) {
      throw new AnchorRequestError(`Provider account lookup returned Horizon HTTP ${accountResponse.status}.`, 502);
    }
    const account = (await accountResponse.json()) as HorizonAccount;
    if (account.account_id !== providerAccount || !/^[0-9]+$/u.test(account.sequence)) {
      throw new AnchorRequestError("Horizon returned invalid provider account state.", 502);
    }
    validateProviderOfframpQuote(quote, transactionPayload.transaction.amount_in ?? "");
    if (quote.id !== quoteId) throw new AnchorRequestError("Anchor returned a different firm quote.", 409);

    const payment = buildProviderWithdrawalPayment({
      accountSequence: account.sequence,
      providerAccount,
      quote,
      transaction: transactionPayload.transaction,
    });
    return NextResponse.json({ payment }, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    return apiError(reason);
  }
}
