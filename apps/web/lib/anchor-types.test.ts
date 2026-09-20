import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTryAmount, normalizeUsdcAmount } from "./anchor-types.ts";

test("normalizes TRY amounts to two decimals", () => {
  assert.equal(normalizeTryAmount("150"), "150.00");
  assert.equal(normalizeTryAmount(" 50.5 "), "50.50");
  assert.equal(normalizeTryAmount("0.01"), "0.01");
});

test("rejects invalid TRY amounts before an Anchor request", () => {
  for (const value of ["", "0", "-1", "1.001", "01", "1,00", "abc"]) {
    assert.throws(() => normalizeTryAmount(value));
  }
});

test("normalizes USDC values to Stellar precision", () => {
  assert.equal(normalizeUsdcAmount("1"), "1.0000000");
  assert.equal(normalizeUsdcAmount("0.01"), "0.0100000");
  assert.equal(normalizeUsdcAmount("12.3456789"), "12.3456789");
  assert.throws(() => normalizeUsdcAmount("0"), /greater than zero/u);
  assert.throws(() => normalizeUsdcAmount("1.00000001"), /at most seven/u);
});
