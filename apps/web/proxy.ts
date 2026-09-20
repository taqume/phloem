import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const LIVE_OPS_ENABLED = "true";

export function proxy(request: NextRequest) {
  if (!process.env.VERCEL || process.env.PHLOEM_ENABLE_LIVE_OPS === LIVE_OPS_ENABLED) {
    return NextResponse.next();
  }

  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Live operational routes are disabled on this public deployment." },
      { status: 404 },
    );
  }

  return new NextResponse("Not Found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export const config = {
  matcher: [
    "/ops/:path*",
    "/api/anchor/:path*",
    "/api/compatibility",
    "/api/ops/:path*",
    "/api/provider/:path*",
    "/api/stellar/:path*",
  ],
};
