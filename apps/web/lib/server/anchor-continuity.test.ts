import assert from "node:assert/strict";
import test from "node:test";

import { createDegradedRailReceipt } from "./anchor-continuity.ts";

const input = {
  anchorDomain: "tr-mock-anchor.fly.dev",
  anchorStatus: "pending_anchor",
  anchorTransactionId: "anchor-tx-123",
  observedAt: "2026-09-20T06:00:00.000Z",
  walletAccount: "GBRFJEDXB6D2FAKEFIXTUREONLYN6HI4QUC",
};

test("creates explicit non-attested evidence without asset or protocol mutation", () => {
  const receipt = createDegradedRailReceipt(input);

  assert.equal(receipt.mode, "DEGRADED_DEMO");
  assert.equal(receipt.anchorObservation.reachable, true);
  assert.equal(receipt.anchorObservation.status, "pending_anchor");
  assert.deepEqual(receipt.scope, {
    anchorAttested: false,
    fiatLeg: "SIMULATED_ONLY",
    protocolStateMutation: "NONE",
    stellarAssetMovement: "NONE",
  });
  assert.match(receipt.evidenceDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(receipt.receiptId, /^degraded_rail_[0-9a-f]{24}$/u);
});

test("is deterministic for the same observed evidence", () => {
  assert.deepEqual(createDegradedRailReceipt(input), createDegradedRailReceipt(input));
});

test("refuses to relabel a completed Anchor transaction", () => {
  assert.throws(
    () => createDegradedRailReceipt({ ...input, anchorStatus: "completed" }),
    /cannot be represented as degraded/u,
  );
});

test("represents an unreachable status endpoint without inventing a SEP-6 status", () => {
  const receipt = createDegradedRailReceipt({
    ...input,
    anchorError: "status request timed out",
    anchorStatus: null,
  });

  assert.equal(receipt.anchorObservation.reachable, false);
  assert.equal(receipt.anchorObservation.status, null);
  assert.equal(receipt.anchorObservation.error, "status request timed out");
});
