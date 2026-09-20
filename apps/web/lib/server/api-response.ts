import { NextRequest, NextResponse } from "next/server";

import { AnchorRequestError } from "./anchor";

function firstForwardedValue(value: string | null): string | null {
  return value?.split(",", 1)[0]?.trim() || null;
}

function actualRequestOrigin(request: NextRequest): string {
  const host = request.headers.get("host")
    ?? firstForwardedValue(request.headers.get("x-forwarded-host"));
  const protocol = firstForwardedValue(request.headers.get("x-forwarded-proto"))
    ?? request.nextUrl.protocol.replace(/:$/u, "");
  if (!host || (protocol !== "http" && protocol !== "https")) {
    throw new AnchorRequestError("Invalid request origin metadata.", 403);
  }
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    throw new AnchorRequestError("Invalid request origin metadata.", 403);
  }
}

export function assertSameOrigin(request: NextRequest): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  let normalizedOrigin: string;
  try {
    normalizedOrigin = new URL(origin).origin;
  } catch {
    throw new AnchorRequestError("Invalid request origin metadata.", 403);
  }
  if (normalizedOrigin !== actualRequestOrigin(request)) {
    throw new AnchorRequestError("Cross-origin mutations are not allowed.", 403);
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
