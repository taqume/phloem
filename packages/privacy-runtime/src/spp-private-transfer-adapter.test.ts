import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { POSEIDON_DOMAINS, poseidon2Hash3 } from "@phloem/protocol-types";
import type { Groth16Proof, SppProof } from "@phloem/treasury-controller-client";

import { EncryptedPrivacyStateStore } from "./privacy-state-store.js";
import {
  EncryptedSppPrivateTransferPlanner,
  type SppRuntimeBridge,
  type SppRuntimeBridgePrepareInput,
} from "./spp-private-transfer-adapter.js";
import { TreasuryPrivacyKeyManager } from "./treasury-privacy-key.js";
import type { PrivateRandomSource } from "./voucher-issuer.js";

const POOL = "CC57FDSWPIHALXW2XWVSKEA7FA72Z37Y7AP5ASRY6V3CXAZCWQAOSLB4";
const proof: Groth16Proof = { a: Buffer.alloc(64), b: Buffer.alloc(128), c: Buffer.alloc(64) };

class TestRandom implements PrivateRandomSource {
  #counter = 0;
  bytes(length: number): Uint8Array {
    assert.equal(length, 32);
    return createHash("sha256").update(`PHLOEM_NON_PRODUCTION_SPP_ADAPTER:${this.#counter++}`).digest();
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "phloem-spp-adapter-test-"));
  const store = new EncryptedPrivacyStateStore(join(directory, "state.enc.json"), Buffer.alloc(32, 0x61));
  await store.initialize();
  const manager = new TreasuryPrivacyKeyManager(store, new TestRandom());
  const sessionId = Buffer.alloc(32, 0x11);
  const artifacts = await manager.createForSession({
    sessionId,
    auditContextHash: 541n,
    createdAtUnixMs: 1_700_000_000_000,
  });
  const inputAmount = 500_000n;
  const inputBlinding = 547n;
  const inputNoteId = await manager.stageOwnedNote({
    sessionId,
    pool: POOL,
    amountAtomic: inputAmount,
    blinding: inputBlinding,
    commitment: poseidon2Hash3(inputAmount, artifacts.notePublicKey, inputBlinding, POSEIDON_DOMAINS.sppNote),
    createdAtUnixMs: 1_700_000_000_001,
  });
  await manager.confirmOwnedNote({
    noteId: inputNoteId,
    leafIndex: 3,
    transactionHash: Buffer.alloc(32, 0x12),
    ledgerSequence: 100,
  });
  return { artifacts, directory, inputNoteId, manager, sessionId, store };
}

test("adapter borrows encrypted ownership, stages exact inputs/refund, and confirms atomically", async (context) => {
  const f = await fixture();
  context.after(async () => {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  const operationId = Buffer.alloc(32, 0x21);
  const providerKey = 557n;
  const providerBlinding = 563n;
  const refundBlinding = 569n;
  let borrowed: SppRuntimeBridgePrepareInput | undefined;
  let confirmed = false;
  const bridge: SppRuntimeBridge = {
    prepare: async (input) => {
      borrowed = input;
      assert.equal(input.availableNotes.length, 1);
      assert.equal(input.availableNotes[0]?.noteId, f.inputNoteId.toString("hex"));
      const sppProof: SppProof = {
        asp_membership_root: 0n,
        asp_non_membership_root: 0n,
        ext_data_hash: Buffer.alloc(32, 0x22),
        input_nullifiers: [571n],
        output_commitment0: poseidon2Hash3(input.claimAmountAtomic, providerKey, providerBlinding, POSEIDON_DOMAINS.sppNote),
        output_commitment1: poseidon2Hash3(input.refundAmountAtomic, input.treasurySppPublicKey, refundBlinding, POSEIDON_DOMAINS.sppNote),
        proof,
        public_amount: 0n,
        root: 577n,
      };
      return {
        operationId,
        inputNoteIds: [f.inputNoteId],
        proof: sppProof,
        extData: {
          encrypted_output0: Buffer.alloc(96, 0x23),
          encrypted_output1: Buffer.alloc(96, 0x24),
          ext_amount: 0n,
          recipient: POOL,
        },
        providerOutputBlinding: providerBlinding,
        refundOutputBlinding: refundBlinding,
      };
    },
    abort: async () => undefined,
    confirm: async () => {
      confirmed = true;
      return { refundLeafIndex: 5 };
    },
  };
  const adapter = new EncryptedSppPrivateTransferPlanner({
    treasuryKeys: f.manager,
    bridge,
    now: () => 1_700_000_000_002,
  });
  await adapter.prepare({
    reservationId: Buffer.alloc(32, 0x25),
    sessionId: f.sessionId,
    claimAmountAtomic: 100_000n,
    refundAmountAtomic: 400_000n,
    providerSppPublicKey: providerKey,
    treasurySppPublicKey: f.artifacts.notePublicKey,
    sppPool: POOL,
  });
  assert.ok(borrowed);
  for (const secret of [
    borrowed.notePrivateKeyLe,
    borrowed.encryptionPrivateKey,
    borrowed.membershipBlindingLe,
  ]) assert.ok(secret.equals(Buffer.alloc(secret.length)));

  const pending = await f.store.readSnapshot();
  assert.equal(pending.sppSpendOperations[0]?.status, "PREPARED");
  assert.equal(pending.sppTreasuryNotes.find((note) => note.noteId === f.inputNoteId.toString("hex"))?.status, "SPEND_PENDING");
  assert.equal(pending.sppTreasuryNotes.find((note) => note.status === "PREPARED")?.amountAtomic, "400000");

  await adapter.confirm(operationId, Buffer.alloc(32, 0x26), 101);
  const completed = await f.store.readSnapshot();
  assert.equal(confirmed, true);
  assert.equal(completed.sppSpendOperations[0]?.status, "CONFIRMED");
  assert.equal(completed.sppTreasuryNotes.find((note) => note.noteId === f.inputNoteId.toString("hex"))?.status, "SPENT");
  assert.equal(completed.sppTreasuryNotes.find((note) => note.status === "ACTIVE")?.leafIndex, 5);
});

test("adapter abort restores inputs and removes an unconfirmed refund note", async (context) => {
  const f = await fixture();
  context.after(async () => {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  const operationId = Buffer.alloc(32, 0x31);
  let aborted = false;
  const bridge: SppRuntimeBridge = {
    prepare: async (input) => ({
      operationId,
      inputNoteIds: [f.inputNoteId],
      proof: {
        asp_membership_root: 0n,
        asp_non_membership_root: 0n,
        ext_data_hash: Buffer.alloc(32),
        input_nullifiers: [587n],
        output_commitment0: poseidon2Hash3(input.claimAmountAtomic, input.providerSppPublicKey, 593n, POSEIDON_DOMAINS.sppNote),
        output_commitment1: poseidon2Hash3(input.refundAmountAtomic, input.treasurySppPublicKey, 599n, POSEIDON_DOMAINS.sppNote),
        proof,
        public_amount: 0n,
        root: 601n,
      },
      extData: { encrypted_output0: Buffer.alloc(96), encrypted_output1: Buffer.alloc(96), ext_amount: 0n, recipient: POOL },
      providerOutputBlinding: 593n,
      refundOutputBlinding: 599n,
    }),
    abort: async () => { aborted = true; },
    confirm: async () => ({}),
  };
  const adapter = new EncryptedSppPrivateTransferPlanner({ treasuryKeys: f.manager, bridge });
  await adapter.prepare({
    reservationId: Buffer.alloc(32, 0x32),
    sessionId: f.sessionId,
    claimAmountAtomic: 100_000n,
    refundAmountAtomic: 400_000n,
    providerSppPublicKey: 607n,
    treasurySppPublicKey: f.artifacts.notePublicKey,
    sppPool: POOL,
  });
  await adapter.abort(operationId);
  const state = await f.store.readSnapshot();
  assert.equal(aborted, true);
  assert.equal(state.sppSpendOperations.length, 0);
  assert.equal(state.sppTreasuryNotes.length, 1);
  assert.equal(state.sppTreasuryNotes[0]?.status, "ACTIVE");
});
