import assert from "node:assert/strict";
import test from "node:test";

import { assertCanonicalAgentAccountRule } from "./agent-account-rule";

const expected = {
  controllerId: "CBQJEY3J4DDJ4OUGSGHUVLRI2NYOS2XVRZ5V7ACWYPFDGB2IJLSMAS67",
  verifierId: "CC3HSAEYBR5EHKVFQ2QUYZ3HWFIDDPNEQ2JT5EB2ZXWS3M34ITJ25NRR",
  publicKeyHex: "52b388b0dffe53781641bc785447eeddc421ac6725a5804a6c3c84a964d381b9",
  validUntilLedger: 4_786_378,
} as const;

test("accepts the Uint8Array returned by the live SDK contract query", () => {
  assert.doesNotThrow(() => assertCanonicalAgentAccountRule({
    context_type: { tag: "CallContract", values: [expected.controllerId] },
    signers: [{
      tag: "External",
      values: [expected.verifierId, Uint8Array.from(Buffer.from(expected.publicKeyHex, "hex"))],
    }],
    valid_until: expected.validUntilLedger,
  }, expected));
});

test("rejects a substituted session-bound public key", () => {
  assert.throws(() => assertCanonicalAgentAccountRule({
    context_type: { tag: "CallContract", values: [expected.controllerId] },
    signers: [{ tag: "External", values: [expected.verifierId, new Uint8Array(32)] }],
    valid_until: expected.validUntilLedger,
  }, expected), /differs from the session-bound identity/u);
});
