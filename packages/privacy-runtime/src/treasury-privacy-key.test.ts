import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { POSEIDON_DOMAINS, poseidon2Hash3 } from "@phloem/protocol-types";

import { EncryptedPrivacyStateStore } from "./privacy-state-store.js";
import {
  TreasuryPrivacyKeyManager,
  deriveSppNotePublicKey,
  deriveX25519PublicKey,
  type TreasurySppNoteOwnership,
} from "./treasury-privacy-key.js";
import type { PrivateRandomSource } from "./voucher-issuer.js";

const POOL = "CC57FDSWPIHALXW2XWVSKEA7FA72Z37Y7AP5ASRY6V3CXAZCWQAOSLB4";
const NON_PRODUCTION_STORE_KEY = Buffer.alloc(32, 0x51);

class TestRandom implements PrivateRandomSource {
  #counter = 0;

  bytes(length: number): Uint8Array {
    assert.equal(length, 32);
    return createHash("sha256")
      .update(`PHLOEM_NON_PRODUCTION_TREASURY_KEY:${this.#counter++}`)
      .digest();
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "phloem-treasury-key-test-"));
  const path = join(directory, "privacy-state.enc.json");
  const store = new EncryptedPrivacyStateStore(path, NON_PRODUCTION_STORE_KEY);
  await store.initialize();
  const manager = new TreasuryPrivacyKeyManager(store, new TestRandom());
  return { directory, path, store, manager };
}

test("X25519 public derivation matches the RFC 7748 basepoint vector", () => {
  const privateKey = Buffer.from("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a", "hex");
  assert.equal(
    deriveX25519PublicKey(privateKey).toString("hex"),
    "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
  );
});

test("treasury ownership secrets persist only inside the encrypted Phloem store", async (context) => {
  const f = await fixture();
  context.after(async () => {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });

  const sessionId = Buffer.alloc(32, 0x17);
  const auditContextHash = 431n;
  const artifacts = await f.manager.createForSession({
    sessionId,
    auditContextHash,
    createdAtUnixMs: 1_700_000_000_000,
  });
  const snapshot = await f.store.readSnapshot();
  const stored = snapshot.treasuryPrivacyKeys[0]!;
  assert.equal(artifacts.notePublicKey.toString(), stored.notePublicKey);
  assert.equal(artifacts.commitment.toString(), stored.commitment);
  assert.notEqual(artifacts.notePublicKey, artifacts.commitment);
  assert.equal(deriveSppNotePublicKey(Buffer.from(stored.notePrivateKeyLeHex, "hex")), artifacts.notePublicKey);

  const serialized = await readFile(f.path, "utf8");
  for (const secret of [
    stored.notePrivateKeyLeHex,
    stored.encryptionPrivateKeyHex,
    stored.membershipBlinding,
    stored.commitmentBlinding,
  ]) {
    assert.doesNotMatch(serialized, new RegExp(secret, "u"));
  }
  assert.deepEqual(await readdir(f.directory), ["privacy-state.enc.json"]);
});

test("SPP ownership is borrowed transiently, zeroized, and owns persisted note openings", async (context) => {
  const f = await fixture();
  context.after(async () => {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });

  const sessionId = Buffer.alloc(32, 0x23);
  const auditContextHash = 433n;
  const artifacts = await f.manager.createForSession({
    sessionId,
    auditContextHash,
    createdAtUnixMs: 1_700_000_000_000,
  });

  let borrowed: TreasurySppNoteOwnership | undefined;
  let notePrivateKeyCopy: Buffer | undefined;
  await f.manager.withSppNoteOwnership(sessionId, (ownership) => {
    borrowed = ownership;
    notePrivateKeyCopy = Buffer.from(ownership.notePrivateKeyLe);
    assert.equal(deriveSppNotePublicKey(ownership.notePrivateKeyLe), artifacts.notePublicKey);
    assert.equal(ownership.encryptionPublicKey.toString("hex"), artifacts.encryptionPublicKey.toString("hex"));
  });
  assert.ok(borrowed);
  for (const value of Object.values(borrowed)) assert.ok(value.equals(Buffer.alloc(value.length)));
  assert.ok(notePrivateKeyCopy);
  assert.notEqual(notePrivateKeyCopy.toString("hex"), Buffer.alloc(32).toString("hex"));
  notePrivateKeyCopy.fill(0);

  const amountAtomic = 100_000n;
  const blinding = 439n;
  const commitment = poseidon2Hash3(amountAtomic, artifacts.notePublicKey, blinding, POSEIDON_DOMAINS.sppNote);
  const noteId = await f.manager.stageOwnedNote({
    sessionId,
    pool: POOL,
    amountAtomic,
    blinding,
    commitment,
    createdAtUnixMs: 1_700_000_000_001,
  });
  await f.manager.confirmOwnedNote({
    noteId,
    leafIndex: 7,
    transactionHash: Buffer.alloc(32, 0x29),
    ledgerSequence: 4_800_000,
  });
  await f.manager.withSppSpendContext(sessionId, POOL, (contextValue) => {
    assert.equal(contextValue.notes.length, 1);
    assert.equal(contextValue.notes[0]?.amountAtomic, amountAtomic.toString());
    assert.equal(contextValue.notes[0]?.status, "ACTIVE");
  });

  await assert.rejects(f.manager.stageOwnedNote({
    sessionId,
    pool: POOL,
    amountAtomic,
    blinding,
    commitment: commitment + 1n,
    createdAtUnixMs: 1_700_000_000_002,
  }), /does not match treasury ownership/u);
});
