import assert from "node:assert/strict";
import test from "node:test";

import type { NextRequest } from "next/server";

import { assertSameOrigin } from "./api-response";

function request(input: {
  readonly host: string;
  readonly origin: string;
  readonly nextUrlOrigin?: string;
}): NextRequest {
  return {
    headers: new Headers({ host: input.host, origin: input.origin }),
    nextUrl: new URL(input.nextUrlOrigin ?? `http://${input.host}`),
  } as NextRequest;
}

test("accepts the browser origin matching Host when Next canonicalizes nextUrl", () => {
  assert.doesNotThrow(() => assertSameOrigin(request({
    host: "127.0.0.1:3000",
    origin: "http://127.0.0.1:3000",
    nextUrlOrigin: "http://localhost:3000",
  })));
});

test("rejects a browser origin that differs from the actual request Host", () => {
  assert.throws(
    () => assertSameOrigin(request({
      host: "127.0.0.1:3000",
      origin: "https://attacker.example",
      nextUrlOrigin: "http://localhost:3000",
    })),
    /Cross-origin mutations are not allowed/u,
  );
});
