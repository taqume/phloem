import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BN254_SCALAR_MODULUS,
  addressFromStrKey,
  auditContextHash,
  fieldToBytes,
  networkId,
  providerPolicyLeaf,
  sessionPolicyHash,
  sha256,
  utf8,
} from "./encoding.js";
import { buildProtocolVectorV1, verifyVectorSignatures } from "./vectors.js";

const vectorPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../protocol/test-vectors/v1.json");

test("checked-in vector equals the TypeScript reference", async () => {
  const checkedIn = JSON.parse(await readFile(vectorPath, "utf8")) as unknown;
  assert.deepEqual(checkedIn, buildProtocolVectorV1());
});

test("fixture signatures verify under their scoped keys", () => {
  assert.equal(verifyVectorSignatures(buildProtocolVectorV1()), true);
});

test("a payload mutation changes the signing digest", () => {
  const vector = buildProtocolVectorV1();
  const signing = vector.signing as Record<string, { bytesHex: string; digestHex: string }>;
  const bytes = new Uint8Array(Buffer.from(signing.serviceOffer!.bytesHex, "hex"));
  const finalIndex = bytes.length - 1;
  bytes[finalIndex] = bytes[finalIndex]! ^ 1;
  assert.notEqual(Buffer.from(sha256(bytes)).toString("hex"), signing.serviceOffer!.digestHex);
});

test("non-canonical field elements are rejected rather than reduced", () => {
  assert.throws(() => fieldToBytes(BN254_SCALAR_MODULUS), /not canonical/u);
  assert.doesNotThrow(() => fieldToBytes(BN254_SCALAR_MODULUS - 1n));
});

test("audit context binds settlement mode and rejects a non-canonical policy hash", () => {
  const base = {
    protocolVersion: 1,
    networkId: networkId("Test SDF Network ; September 2015"),
    treasuryController: addressFromStrKey("CB23C2OYMIDYC7OG2PK6NJFIVCYONYV43ABREOGVTW2LT4C2G53G2CWU"),
    sessionId: sha256(utf8("PHLOEM_NON_SECRET_TEST_SESSION")),
    asset: addressFromStrKey("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"),
    policyHash: 23n,
  } as const;

  assert.notEqual(
    auditContextHash({ ...base, settlementMode: 1 }),
    auditContextHash({ ...base, settlementMode: 2 }),
  );
  assert.throws(
    () => auditContextHash({ ...base, settlementMode: 1, policyHash: BN254_SCALAR_MODULUS }),
    /not canonical/u,
  );
});

test("provider leaf and session policy hash bind the controlled PRIVATE configuration", () => {
  const network = networkId("Test SDF Network ; September 2015");
  const controller = addressFromStrKey("CB23C2OYMIDYC7OG2PK6NJFIVCYONYV43ABREOGVTW2LT4C2G53G2CWU");
  const asset = addressFromStrKey("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC");
  const provider = addressFromStrKey("GDDOPVIIK6PKY6URWPGRIWCO5W34AGOJFXCAYLZTDBP4Z6MVB3DHG5AD");
  const serviceIdHash = sha256(utf8("research-data-service"));
  const providerRoot = providerPolicyLeaf({
    version: 1,
    providerIdentity: provider,
    providerSppPublicKey: 17n,
    serviceIdHash,
    categoryId: 2,
    allowedSettlementModes: 2,
  });
  const policy = {
    version: 1,
    networkId: network,
    treasuryController: controller,
    asset,
    settlementMode: 2 as const,
    approvedProviderRoot: providerRoot,
    categorySchemaVersion: 1,
    maxDelegationDepth: 3,
    allowedActionsMask: 7n,
    sessionExpiry: 5_000_000,
  };
  assert.notEqual(
    providerRoot,
    providerPolicyLeaf({
      version: 1,
      providerIdentity: provider,
      providerSppPublicKey: 19n,
      serviceIdHash,
      categoryId: 2,
      allowedSettlementModes: 2,
    }),
  );
  assert.notEqual(
    sessionPolicyHash(policy),
    sessionPolicyHash({ ...policy, sessionExpiry: policy.sessionExpiry + 1 }),
  );
});

test("fixture key material is explicitly non-production", () => {
  const vector = buildProtocolVectorV1();
  assert.equal(vector.metadata.containsProductionSecrets, false);
  assert.notEqual(Buffer.from(sha256(utf8("PHLOEM_NON_SECRET_TEST_KEY:provider"))).length, 0);
});
