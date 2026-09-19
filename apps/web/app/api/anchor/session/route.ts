import { NextRequest, NextResponse } from "next/server";

import { anchorJson, assertAccount, bearer, discoverAnchor, validateSignedChallenge } from "../../../../lib/server/anchor";
import {
  ANCHOR_SESSION_COOKIE,
  ANCHOR_SESSION_MAX_AGE_SECONDS,
  anchorSessionCookieOptions,
  sealAnchorSession,
} from "../../../../lib/server/anchor-session";
import { apiError, assertSameOrigin } from "../../../../lib/server/api-response";

export const runtime = "nodejs";

interface AuthResponse {
  token: string;
}

interface CustomerResponse {
  status?: string;
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const body = (await request.json()) as { account?: unknown; transaction?: unknown };
    assertAccount(body.account);
    if (typeof body.transaction !== "string" || body.transaction.length > 20_000) {
      return NextResponse.json({ error: "A signed SEP-10 transaction is required." }, { status: 400 });
    }

    const discovery = await discoverAnchor();
    validateSignedChallenge(body.transaction, body.account, discovery);
    const auth = await anchorJson<AuthResponse>(discovery.webAuthEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transaction: body.transaction }),
    });
    if (typeof auth.token !== "string" || !auth.token) throw new Error("Anchor did not return a SEP-10 token.");

    const customer = await anchorJson<CustomerResponse>(`${discovery.kycServer}/customer`, {
      headers: bearer(auth.token),
    }).catch(() => ({ status: "UNKNOWN" }));

    const response = NextResponse.json({
      account: body.account,
      authenticated: true,
      kycStatus: customer.status ?? "UNKNOWN",
    });
    response.cookies.set(
      ANCHOR_SESSION_COOKIE,
      sealAnchorSession({
        account: body.account,
        expiresAt: Date.now() + ANCHOR_SESSION_MAX_AGE_SECONDS * 1_000,
        token: auth.token,
      }),
      anchorSessionCookieOptions,
    );
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (reason) {
    return apiError(reason);
  }
}
