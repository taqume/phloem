import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  EncryptedPrivacyStateStore,
  PrivacyStateIntegrityError,
  PrivacyStateStoreClosedError,
} from "./privacy-state-store.js";

const NON_PRODUCTION_TEST_KEY = Buffer.alloc(32, 0x41);

async function fixture(): Promise<{ directory: string; path: string; store: EncryptedPrivacyStateStore }> {
  const directory = await mkdtemp(join(tmpdir(), "phloem-private-state-test-"));
  const path = join(directory, "state.enc.json");
  const store = new EncryptedPrivacyStateStore(path, NON_PRODUCTION_TEST_KEY);
  await store.initialize();
  return { directory, path, store };
}

test("state is authenticated, encrypted, atomic, and owner-readable only", async (context) => {
  const { directory, path, store } = await fixture();
  context.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const secretAmount = "987654321";
  const secretBlinding = "123456789";
  await store.transaction((state) => {
    state.auditAccumulators.push({
      sessionId: "01".repeat(32),
      auditContextHash: "11",
      totalSpendAtomic: secretAmount,
      blinding: secretBlinding,
      commitment: "13",
      auditVersion: 1,
    });
  });

  const serialized = await readFile(path, "utf8");
  assert.doesNotMatch(serialized, new RegExp(secretAmount, "u"));
  assert.doesNotMatch(serialized, new RegExp(secretBlinding, "u"));
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  const snapshot = await store.readSnapshot();
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.auditAccumulators[0]?.totalSpendAtomic, secretAmount);

  const wrongKeyStore = new EncryptedPrivacyStateStore(path, Buffer.alloc(32, 0x42));
  await assert.rejects(wrongKeyStore.readSnapshot(), PrivacyStateIntegrityError);
  wrongKeyStore.close();
});

test("failed transactions leave the prior encrypted revision intact", async (context) => {
  const { directory, store } = await fixture();
  context.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  await assert.rejects(
    store.transaction((state) => {
      state.revision = 900;
      throw new Error("intentional test rollback");
    }),
    /intentional test rollback/u,
  );
  assert.equal((await store.readSnapshot()).revision, 0);
});

test("clean reset requires the explicit sentinel and closing zeroizes future access", async (context) => {
  const { directory, store } = await fixture();
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  await store.transaction((state) => {
    state.auditAccumulators.push({
      sessionId: "02".repeat(32),
      auditContextHash: "17",
      totalSpendAtomic: "0",
      blinding: "19",
      commitment: "23",
      auditVersion: 1,
    });
  });
  await store.resetClean("RESET_PRIVATE_STATE");
  const reset = await store.readSnapshot();
  assert.equal(reset.revision, 0);
  assert.deepEqual(reset.auditAccumulators, []);

  store.close();
  await assert.rejects(store.readSnapshot(), PrivacyStateStoreClosedError);
});
