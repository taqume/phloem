import { type NextRequest, NextResponse } from "next/server";

import {
  latestLedger,
  loadProviderConfig,
  signedOffer,
  signedOfferAtReference,
  signedOfferUntil,
} from "../../../../lib/server/research-provider";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const config = loadProviderConfig();
    const ledger = await latestLedger();
    const requestedValidity = request.nextUrl.searchParams.get("validUntilLedger");
    const requestedReference = request.nextUrl.searchParams.get("referenceHash");
    let offer;
    if (requestedValidity !== null && requestedReference !== null) {
      return NextResponse.json({ error: "request one historical offer selector at a time." }, { status: 400 });
    }
    if (requestedReference !== null) {
      offer = signedOfferAtReference(config, requestedReference, ledger);
      if (!offer) {
        return NextResponse.json({ error: "the requested offer reference is not live." }, { status: 404 });
      }
    } else if (requestedValidity === null) {
      offer = signedOffer(config, ledger);
    } else {
      if (!/^[1-9][0-9]*$/u.test(requestedValidity)) {
        return NextResponse.json({ error: "validUntilLedger must be a positive integer." }, { status: 400 });
      }
      const validUntilLedger = Number(requestedValidity);
      if (!Number.isSafeInteger(validUntilLedger) || validUntilLedger <= ledger) {
        return NextResponse.json({ error: "the requested historical offer is no longer live." }, { status: 409 });
      }
      offer = signedOfferUntil(config, validUntilLedger);
    }
    return NextResponse.json({ offer }, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "Provider offer failed.";
    return NextResponse.json({ error: message }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
