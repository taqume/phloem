import { StrKey } from "@stellar/stellar-sdk";
import { NextRequest, NextResponse } from "next/server";

import type { AccountReadiness } from "../../../../lib/anchor-types";
import { PHLOEM_NETWORK } from "../../../../lib/network";

export const dynamic = "force-dynamic";

interface HorizonBalance {
  asset_code?: string;
  asset_issuer?: string;
  asset_type: string;
  balance: string;
}

interface HorizonAccount {
  account_id: string;
  balances: HorizonBalance[];
}

export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get("address") ?? "";
  if (!StrKey.isValidEd25519PublicKey(address)) {
    return NextResponse.json({ error: "A valid Stellar G-address is required." }, { status: 400 });
  }

  const response = await fetch(`${PHLOEM_NETWORK.horizonUrl}/accounts/${encodeURIComponent(address)}`, {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) {
    const result: AccountReadiness = {
      address,
      exists: false,
      usdcBalance: null,
      usdcTrustline: false,
      xlmBalance: null,
    };
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  }
  if (!response.ok) {
    return NextResponse.json({ error: `Horizon returned HTTP ${response.status}.` }, { status: 502 });
  }

  const account = (await response.json()) as HorizonAccount;
  const native = account.balances.find((balance) => balance.asset_type === "native");
  const usdc = account.balances.find(
    (balance) => balance.asset_code === PHLOEM_NETWORK.assetCode && balance.asset_issuer === PHLOEM_NETWORK.assetIssuer,
  );
  const result: AccountReadiness = {
    address: account.account_id,
    exists: true,
    usdcBalance: usdc?.balance ?? null,
    usdcTrustline: Boolean(usdc),
    xlmBalance: native?.balance ?? null,
  };
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}
