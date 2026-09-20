import { type NextRequest, NextResponse } from "next/server";

import type { AnchorQuote, AnchorTransaction } from "../../../../../../lib/anchor-types";
import { PHLOEM_NETWORK } from "../../../../../../lib/network";
import { AnchorRequestError, anchorJson, assertAccount, bearer, discoverAnchor } from "../../../../../../lib/server/anchor";
import { ANCHOR_SESSION_COOKIE, openAnchorSession } from "../../../../../../lib/server/anchor-session";
import { apiError, assertSameOrigin } from "../../../../../../lib/server/api-response";
import {
  assertSignedProviderWithdrawalPayment,
  providerSettlementAccount,
  validateProviderOfframpQuote,
} from "../../../../../../lib/server/provider-anchor-offramp";

export const runtime = "nodejs";

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 256) {
    throw new AnchorRequestError(`${label} is required.`, 400);
  }
  return value;
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const body = (await request.json()) as {
      account?: unknown;
      quoteId?: unknown;
      signedTransactionXdr?: unknown;
      transactionId?: unknown;
    };
    assertAccount(body.account);
    const quoteId = identifier(body.quoteId, "SEP-38 quote id");
    const transactionId = identifier(body.transactionId, "Anchor transaction id");
    if (typeof body.signedTransactionXdr !== "string" || !body.signedTransactionXdr || body.signedTransactionXdr.length > 20_000) {
      throw new AnchorRequestError("A signed withdrawal payment is required.", 400);
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
    const transactionUrl = new URL(`${discovery.transferServer}/transaction`);
    transactionUrl.searchParams.set("id", transactionId);
    const [quote, transactionPayload] = await Promise.all([
      anchorJson<AnchorQuote>(`${discovery.sep38Server}/quote/${encodeURIComponent(quoteId)}`, {
        headers: bearer(session.token),
      }),
      anchorJson<{ transaction?: AnchorTransaction }>(transactionUrl.toString(), {
        headers: bearer(session.token),
      }),
    ]);
    if (!transactionPayload.transaction || transactionPayload.transaction.id !== transactionId) {
      throw new AnchorRequestError("Anchor did not return the requested withdrawal.", 502);
    }
    validateProviderOfframpQuote(quote, transactionPayload.transaction.amount_in ?? "");
    if (quote.id !== quoteId) throw new AnchorRequestError("Anchor returned a different firm quote.", 409);
    const signed = assertSignedProviderWithdrawalPayment({
      providerAccount,
      quote,
      signedTransactionXdr: body.signedTransactionXdr,
      transaction: transactionPayload.transaction,
    });

    const form = new URLSearchParams({ tx: signed.toXDR() });
    const horizonResponse = await fetch(`${PHLOEM_NETWORK.horizonUrl}/transactions`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    const horizonBody = (await horizonResponse.json().catch(() => null)) as { hash?: string; ledger?: number; title?: string } | null;
    if (!horizonResponse.ok || !horizonBody?.hash) {
      throw new AnchorRequestError(horizonBody?.title ?? `Horizon returned HTTP ${horizonResponse.status}.`, 502);
    }
    return NextResponse.json({
      submitted: {
        anchorTransactionId: transactionId,
        ledger: horizonBody.ledger ?? null,
        transactionHash: horizonBody.hash,
      },
    }, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    return apiError(reason);
  }
}
