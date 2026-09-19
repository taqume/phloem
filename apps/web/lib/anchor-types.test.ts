import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTryAmount } from "./anchor-types.ts";

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
