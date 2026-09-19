import { NextRequest, NextResponse } from "next/server";

import { AnchorRequestError } from "./anchor";

export function assertSameOrigin(request: NextRequest): void {
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) {
    throw new AnchorRequestError("Cross-origin Anchor mutations are not allowed.", 403);
  }
}

export function apiError(reason: unknown): NextResponse {
  const status = reason instanceof AnchorRequestError && reason.status >= 400 && reason.status < 500
    ? reason.status
    : reason instanceof Error && reason.message.includes("authentication")
      ? 401
      : 500;
  const message = reason instanceof Error ? reason.message : "Unexpected request failure.";
  return NextResponse.json({ error: message }, { status });
}
