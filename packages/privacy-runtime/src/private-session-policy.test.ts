import assert from "node:assert/strict";
import test from "node:test";

import {
  addressFromStrKey,
  deriveId,
  networkId,
  providerPolicyLeaf,
  sessionPolicyHash,
  sha256,
  utf8,
} from "@phloem/protocol-types";
import { Keypair } from "@stellar/stellar-sdk";

import {
  PRIVATE_ALLOWED_ACTIONS_MASK,
  buildPrivateSessionPolicy,
} from "./private-session-policy.js";
import { deriveSppNotePublicKey } from "./treasury-privacy-key.js";

const CONTROLLER = "CBQJEY3J4DDJ4OUGSGHUVLRI2NYOS2XVRZ5V7ACWYPFDGB2IJLSMAS67";
const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

function fixture() {
  const provider = Keypair.fromRawEd25519Seed(sha256(utf8("PHLOEM_NON_SECRET_TEST_KEY:policy-provider")));
  const notePrivateKey = Buffer.alloc(32);
  notePrivateKey[0] = 7;
  return {
    currentLedger: 4_700_000,
    networkId: networkId("Test SDF Network ; September 2015"),
    treasuryController: CONTROLLER,
    asset: ASSET,
    sessionExpiry: 4_710_000,
    provider: {
      providerIdentity: provider.publicKey(),
      providerSppPublicKey: deriveSppNotePublicKey(notePrivateKey),
      serviceIdHash: deriveId("PHLOEM_SERVICE_ID_V1", utf8("research-data-service")),
      categoryId: 2,
    },
  };
}

test("PRIVATE session policy binds the one controlled provider and every hard policy field", () => {
  const input = fixture();
  const prepared = buildPrivateSessionPolicy(input);
  assert.equal(prepared.draftPolicy.policy_hash, prepared.policyHash);
  assert.equal(prepared.draftPolicy.approved_provider_root, prepared.approvedProviderRoot);
  assert.equal(prepared.draftPolicy.allowed_actions_mask, PRIVATE_ALLOWED_ACTIONS_MASK);
  assert.deepEqual(prepared.draftPolicy.settlement_mode, { tag: "Private", values: undefined });
  assert.equal(prepared.provider.allowedSettlementModes, 2);
  assert.equal(
    prepared.approvedProviderRoot,
    providerPolicyLeaf({
      version: 1,
      providerIdentity: addressFromStrKey(input.provider.providerIdentity),
      providerSppPublicKey: input.provider.providerSppPublicKey,
      serviceIdHash: input.provider.serviceIdHash,
      categoryId: 2,
      allowedSettlementModes: 2,
    }),
  );
  assert.equal(
    prepared.policyHash,
    sessionPolicyHash({
      version: 1,
      networkId: input.networkId,
      treasuryController: addressFromStrKey(CONTROLLER),
      asset: addressFromStrKey(ASSET),
      settlementMode: 2,
      approvedProviderRoot: prepared.approvedProviderRoot,
      categorySchemaVersion: 1,
      maxDelegationDepth: 3,
      allowedActionsMask: 7n,
      sessionExpiry: input.sessionExpiry,
    }),
  );
});

test("provider substitution, stale expiry, and non-canonical SPP keys fail closed", () => {
  const input = fixture();
  const original = buildPrivateSessionPolicy(input);
  const substituted = buildPrivateSessionPolicy({
    ...input,
    provider: { ...input.provider, serviceIdHash: deriveId("PHLOEM_SERVICE_ID_V1", utf8("different-service")) },
  });
  assert.notEqual(original.approvedProviderRoot, substituted.approvedProviderRoot);
  assert.notEqual(original.policyHash, substituted.policyHash);
  assert.throws(() => buildPrivateSessionPolicy({ ...input, sessionExpiry: input.currentLedger }), /after the current ledger/);
  assert.throws(
    () => buildPrivateSessionPolicy({ ...input, provider: { ...input.provider, providerSppPublicKey: 0n } }),
    /non-zero canonical/,
  );
});
