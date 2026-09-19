import { NextRequest, NextResponse } from "next/server";

import { anchorJson, assertAccount, discoverAnchor, validateChallenge } from "../../../../lib/server/anchor";
import { apiError } from "../../../../lib/server/api-response";
import { PHLOEM_NETWORK } from "../../../../lib/network";

export const dynamic = "force-dynamic";

interface ChallengeResponse {
  network_passphrase: string;
  transaction: string;
}

export async function GET(request: NextRequest) {
  try {
    const account = request.nextUrl.searchParams.get("account");
    assertAccount(account);
    const discovery = await discoverAnchor();
    const url = new URL(discovery.webAuthEndpoint);
    url.searchParams.set("account", account);
    const challenge = await anchorJson<ChallengeResponse>(url.toString());
    if (challenge.network_passphrase !== PHLOEM_NETWORK.networkPassphrase || typeof challenge.transaction !== "string") {
      throw new Error("Anchor returned an invalid SEP-10 challenge response.");
    }
    validateChallenge(challenge.transaction, account, discovery);
    return NextResponse.json(challenge, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    return apiError(reason);
  }
}
