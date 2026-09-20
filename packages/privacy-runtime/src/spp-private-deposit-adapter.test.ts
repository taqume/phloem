import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SppProof } from "@phloem/treasury-controller-client";

import { EncryptedPrivacyStateStore } from "./privacy-state-store.js";
import {
  EncryptedSppPrivateDepositPlanner,
  type SppDepositRuntimeBridge,
  type SppDepositRuntimeBridgeInput,
} from "./spp-private-deposit-adapter.js";
import { TreasuryPrivacyKeyManager } from "./treasury-privacy-key.js";
import type { PrivateRandomSource } from "./voucher-issuer.js";

const COMPANY = "GBRFJEDXTYPKMZCQNXQV5LS63YBKRVNTQLE37GKKMQEO3TQ2N6HI4QUC";
const POOL = "CC57FDSWPIHALXW2XWVSKEA7FA72Z37Y7AP5ASRY6V3CXAZCWQAOSLB4";

class TestRandom implements PrivateRandomSource {
  #counter = 0;
  bytes(length: number): Uint8Array {
    assert.equal(length, 32);
    const value = createHash("sha256").update(`PHLOEM_NON_PRODUCTION_DEPOSIT_ADAPTER:${this.#counter++}`).digest();
    value[0] = 0;
    return value;
  }
}

test("deposit adapter lends encrypted treasury ownership transiently and delegates lifecycle", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "phloem-deposit-adapter-test-"));
  const store = new EncryptedPrivacyStateStore(join(directory, "state.enc.json"), Buffer.alloc(32, 0x74));
  await store.initialize();
  context.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const sessionId = Buffer.alloc(32, 1);
  const treasuryKeys = new TreasuryPrivacyKeyManager(store, new TestRandom());
  const artifacts = await treasuryKeys.createForSession({
    sessionId,
    auditContextHash: 101n,
    createdAtUnixMs: 1_700_000_000_000,
  });
  let borrowed: SppDepositRuntimeBridgeInput | undefined;
  let aborted = false;
  let confirmed = false;
  const proof: SppProof = {
    asp_membership_root: 0n,
    asp_non_membership_root: 0n,
    ext_data_hash: Buffer.alloc(32),
    input_nullifiers: [0n, 0n],
    output_commitment0: 103n,
    output_commitment1: 0n,
    proof: { a: Buffer.alloc(64), b: Buffer.alloc(128), c: Buffer.alloc(64) },
    public_amount: 100_000n,
    root: 0n,
  };
  const bridge: SppDepositRuntimeBridge = {
    prepare: async (input) => {
      borrowed = input;
      assert.equal(input.notePrivateKeyLe.length, 32);
      assert.equal(input.encryptionPrivateKey.length, 32);
      return {
        operationId: Buffer.alloc(32, 7),
        proof,
        extData: {
          encrypted_output0: Buffer.alloc(96),
          encrypted_output1: Buffer.alloc(96),
          ext_amount: 100_000n,
          recipient: POOL,
        },
        fundingOutputBlinding: 107n,
      };
    },
    abort: async () => { aborted = true; },
    confirm: async () => {
      confirmed = true;
      return { fundingLeafIndex: 9 };
    },
  };
  const planner = new EncryptedSppPrivateDepositPlanner({ treasuryKeys, bridge });
  const prepared = await planner.prepare({
    sessionId,
    fundingSource: COMPANY,
    amountAtomic: 100_000n,
    treasurySppPublicKey: artifacts.notePublicKey,
    treasuryEncryptionPublicKey: artifacts.encryptionPublicKey,
    sppPool: POOL,
  });
  assert.equal(prepared.proof, proof);
  assert.ok(borrowed);
  for (const key of [
    borrowed.notePrivateKeyLe,
    borrowed.notePublicKeyLe,
    borrowed.encryptionPrivateKey,
    borrowed.encryptionPublicKey,
    borrowed.membershipBlindingLe,
  ]) assert.ok(key.equals(Buffer.alloc(key.length)));

  await planner.abort(prepared.operationId);
  assert.equal(aborted, true);
  assert.deepEqual(await planner.confirm(prepared.operationId, Buffer.alloc(32, 8), 100, 103n), { fundingLeafIndex: 9 });
  assert.equal(confirmed, true);
});
