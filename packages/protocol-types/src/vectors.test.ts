import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BN254_SCALAR_MODULUS, fieldToBytes, sha256, utf8 } from "./encoding.js";
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

test("fixture key material is explicitly non-production", () => {
  const vector = buildProtocolVectorV1();
  assert.equal(vector.metadata.containsProductionSecrets, false);
  assert.notEqual(Buffer.from(sha256(utf8("PHLOEM_NON_SECRET_TEST_KEY:provider"))).length, 0);
});
