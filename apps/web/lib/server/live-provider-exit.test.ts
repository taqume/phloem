import assert from "node:assert/strict";
import test from "node:test";

import { decimalAmountToAtomic } from "./live-provider-exit";

test("parses canonical Stellar balances at seven-decimal asset precision", () => {
  assert.equal(decimalAmountToAtomic("0.0100000"), 100_000n);
  assert.equal(decimalAmountToAtomic("12.3456"), 123_456_000n);
  assert.equal(decimalAmountToAtomic("9"), 90_000_000n);
});

test("rejects lossy or non-canonical provider balance encodings", () => {
  for (const value of ["1.00000001", "01.0", "-1.0", "1e-2", " 1.0", "1."]) {
    assert.throws(() => decimalAmountToAtomic(value), /non-canonical USDC balance/u);
  }
});
