import assert from "node:assert/strict";
import test from "node:test";

import {
  fieldDecimalSchema,
  standardSettlementInputSchema,
  u64DecimalSchema,
} from "./schemas.js";

test("field schema rejects implicit modular reduction", () => {
  assert.equal(fieldDecimalSchema.safeParse("21888242871839275222246405745257275088548364400416034343698204186575808495616").success, true);
  assert.equal(fieldDecimalSchema.safeParse("21888242871839275222246405745257275088548364400416034343698204186575808495617").success, false);
});

test("u64 schema rejects 2^64", () => {
  assert.equal(u64DecimalSchema.safeParse("18446744073709551615").success, true);
  assert.equal(u64DecimalSchema.safeParse("18446744073709551616").success, false);
});

test("STANDARD remainder identifier and commitment are inseparable", () => {
  const common = {
    paymentId: "00".repeat(32),
    sessionId: "01".repeat(32),
    sourceBudgetNoteId: "02".repeat(32),
    amountAtomic: "100000",
    provider: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    providerSppPublicKey: "1",
    serviceIdHash: "05".repeat(32),
    categoryId: 7,
    allowedSettlementModes: 1,
    usageRoot: "1",
    offerReferenceHash: "03".repeat(32),
    newAuditCommitment: "2",
  };
  assert.equal(standardSettlementInputSchema.safeParse(common).success, true);
  assert.equal(standardSettlementInputSchema.safeParse({ ...common, remainderBudgetNoteId: "04".repeat(32) }).success, false);
});
