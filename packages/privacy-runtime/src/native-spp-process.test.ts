import assert from "node:assert/strict";
import test from "node:test";

import { classifyNativeSppFailure } from "./native-spp-deposit-bridge.js";

test("classifies only allowlisted native SPP failure stages", () => {
  assert.equal(
    classifyNativeSppFailure("Error: PHLOEM_STAGE_PROVIDER_EVENT_QUERY\nprivate detail"),
    "native SPP bridge failed during provider event query",
  );
  assert.equal(
    classifyNativeSppFailure("PHLOEM_STAGE_PROVIDER_NOTE_DECRYPT"),
    "native SPP bridge failed during provider note decryption",
  );
  assert.equal(
    classifyNativeSppFailure("PHLOEM_STAGE_TRANSACTION_SIMULATION"),
    "native SPP bridge failed during transaction simulation",
  );
  assert.equal(
    classifyNativeSppFailure("PHLOEM_STAGE_WITHDRAW_PLAN"),
    "native SPP bridge failed during provider withdrawal planning",
  );
  assert.equal(
    classifyNativeSppFailure("PHLOEM_STAGE_PROVIDER_NOTE_RECOVERY"),
    "native SPP bridge failed during provider note recovery",
  );
});

test("does not expose unrecognized native diagnostics", () => {
  const secret = "do-not-leak-this-native-diagnostic";
  const classified = classifyNativeSppFailure(secret);
  assert.equal(classified, "native SPP bridge rejected the request");
  assert.equal(classified.includes(secret), false);
});
