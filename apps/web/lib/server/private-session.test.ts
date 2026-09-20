import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveSppNotePublicKey,
  deriveX25519PublicKey,
} from "@phloem/privacy-runtime/keys";
import { deriveId, sha256, utf8 } from "@phloem/protocol-types";
import { Keypair } from "@stellar/stellar-sdk";

import {
  controlledProviderPublicConfigFromSecrets,
  verifyPrivateSessionCreation,
} from "./private-session";

test("provider custody secrets are reduced to public session-policy artifacts", () => {
  const provider = Keypair.fromRawEd25519Seed(sha256(utf8("PHLOEM_NON_SECRET_TEST_KEY:web-provider")));
  const notePrivateKey = Buffer.alloc(32);
  notePrivateKey[0] = 9;
  const encryptionPrivateKey = Buffer.alloc(32, 0x42);
  const config = controlledProviderPublicConfigFromSecrets({
    providerIdentity: provider.publicKey(),
    notePrivateKeyLeHex: notePrivateKey.toString("hex"),
    encryptionPrivateKeyHex: encryptionPrivateKey.toString("hex"),
    serviceIdHash: deriveId("PHLOEM_SERVICE_ID_V1", utf8("research-data-service")),
    categoryId: 2,
  });

  assert.equal(config.providerSppPublicKey, deriveSppNotePublicKey(notePrivateKey));
  assert.deepEqual(config.providerSppEncryptionPublicKey, deriveX25519PublicKey(encryptionPrivateKey));
  assert.equal(config.providerIdentity, provider.publicKey());
  assert.equal("notePrivateKeyLeHex" in config, false);
  assert.equal("encryptionPrivateKeyHex" in config, false);
});

test("provider public config rejects missing or invalid secret encodings", () => {
  const provider = Keypair.fromRawEd25519Seed(sha256(utf8("PHLOEM_NON_SECRET_TEST_KEY:web-provider")));
  const base = {
    providerIdentity: provider.publicKey(),
    notePrivateKeyLeHex: "01".padEnd(64, "0"),
    encryptionPrivateKeyHex: "02".repeat(32),
    serviceIdHash: deriveId("PHLOEM_SERVICE_ID_V1", utf8("research-data-service")),
    categoryId: 2,
  };
  assert.throws(
    () => controlledProviderPublicConfigFromSecrets({ ...base, notePrivateKeyLeHex: "" }),
    /PROVIDER_SPP_NOTE_PRIVATE_KEY_LE_HEX/,
  );
  assert.throws(
    () => controlledProviderPublicConfigFromSecrets({ ...base, encryptionPrivateKeyHex: "AA".repeat(32) }),
    /PROVIDER_SPP_ENCRYPTION_PRIVATE_KEY_HEX/,
  );
});

test("PRIVATE session confirmation rejects malformed public evidence before RPC access", async () => {
  const canonical = {
    transactionHash: "00".repeat(32),
    sessionId: "11".repeat(32),
    policyHash: "1",
    approvedProviderRoot: "2",
    sessionExpiry: 4_800_000,
  };
  await assert.rejects(
    verifyPrivateSessionCreation({ ...canonical, transactionHash: "AA".repeat(32) }),
    /transaction hash must be 32-byte lowercase hex/,
  );
  await assert.rejects(
    verifyPrivateSessionCreation({ ...canonical, policyHash: "9".repeat(79) }),
    /policy hash must be a canonical decimal field/,
  );
  await assert.rejects(
    verifyPrivateSessionCreation({ ...canonical, sessionExpiry: 2 ** 32 }),
    /session expiry must fit u32/,
  );
});
