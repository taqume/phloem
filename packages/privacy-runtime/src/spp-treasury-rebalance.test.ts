import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { POSEIDON_DOMAINS, poseidon2Hash3 } from "@phloem/protocol-types";
import type { Groth16Proof } from "@phloem/treasury-controller-client";

import { EncryptedPrivacyStateStore } from "./privacy-state-store.js";
import type { SppRuntimeBridge } from "./spp-private-transfer-adapter.js";
import { TreasuryPrivacyKeyManager } from "./treasury-privacy-key.js";
import { TreasurySppRebalancePlanner } from "./spp-treasury-rebalance.js";
import type { PrivateRandomSource } from "./voucher-issuer.js";

const POOL = "CC57FDSWPIHALXW2XWVSKEA7FA72Z37Y7AP5ASRY6V3CXAZCWQAOSLB4";
const PROOF: Groth16Proof = { a: Buffer.alloc(64), b: Buffer.alloc(128), c: Buffer.alloc(64) };

class TestRandom implements PrivateRandomSource {
  #counter = 0;
  bytes(length: number): Uint8Array {
    assert.equal(length, 32);
    return createHash("sha256").update(`PHLOEM_NON_PRODUCTION_REBALANCE:${this.#counter++}`).digest();
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "phloem-spp-rebalance-test-"));
  const store = new EncryptedPrivacyStateStore(join(directory, "state.enc.json"), Buffer.alloc(32, 0x71));
  await store.initialize();
  const manager = new TreasuryPrivacyKeyManager(store, new TestRandom());
  const sessionId = Buffer.alloc(32, 0x41);
  const artifacts = await manager.createForSession({
    sessionId,
    auditContextHash: 701n,
    createdAtUnixMs: 1_700_000_000_000,
  });
  const amountAtomic = 1_000_000n;
  const blinding = 709n;
  const inputNoteId = await manager.stageOwnedNote({
    sessionId,
    pool: POOL,
    amountAtomic,
    blinding,
    commitment: poseidon2Hash3(amountAtomic, artifacts.notePublicKey, blinding, POSEIDON_DOMAINS.sppNote),
    createdAtUnixMs: 1_700_000_000_001,
  });
  await manager.confirmOwnedNote({
    noteId: inputNoteId,
    leafIndex: 3,
    transactionHash: Buffer.alloc(32, 0x42),
    ledgerSequence: 100,
  });
  return { artifacts, directory, inputNoteId, manager, sessionId, store };
}

function bridgeFixture(inputNoteId: Buffer, treasuryPublicKey: bigint) {
  const operationId = Buffer.alloc(32, 0x43);
  let aborted = false;
  const bridge: SppRuntimeBridge = {
    prepare: async (input) => {
      assert.equal(input.providerSppPublicKey, treasuryPublicKey);
      assert.ok(input.providerSppEncryptionPublicKey.equals(input.encryptionPublicKey));
      const primaryBlinding = 719n;
      const changeBlinding = 727n;
      return {
        operationId,
        inputNoteIds: [inputNoteId],
        proof: {
          asp_membership_root: 0n,
          asp_non_membership_root: 0n,
          ext_data_hash: Buffer.alloc(32, 0x44),
          input_nullifiers: [733n],
          output_commitment0: poseidon2Hash3(
            input.claimAmountAtomic,
            treasuryPublicKey,
            primaryBlinding,
            POSEIDON_DOMAINS.sppNote,
          ),
          output_commitment1: poseidon2Hash3(
            input.refundAmountAtomic,
            treasuryPublicKey,
            changeBlinding,
            POSEIDON_DOMAINS.sppNote,
          ),
          proof: PROOF,
          public_amount: 0n,
          root: 739n,
        },
        extData: {
          encrypted_output0: Buffer.alloc(96, 0x45),
          encrypted_output1: Buffer.alloc(96, 0x46),
          ext_amount: 0n,
          recipient: POOL,
        },
        providerOutputBlinding: primaryBlinding,
        refundOutputBlinding: changeBlinding,
        unsignedTransactionXdr: "AA==",
        resource: {
          authEntries: 1,
          diskReadBytes: 1,
          envelopeBytes: 1,
          footprintReadOnlyEntries: 1,
          footprintReadWriteEntries: 1,
          instructions: 1,
          latestLedger: 101,
          resourceFeeStroops: "1",
          totalFeeStroops: "2",
          writeBytes: 1,
        },
      };
    },
    abort: async () => { aborted = true; },
    confirm: async () => ({ providerLeafIndex: 4, refundLeafIndex: 5 }),
  };
  return { aborted: () => aborted, bridge, operationId };
}

test("treasury rebalance creates two treasury-owned denominations and confirms both leaves", async (context) => {
  const f = await fixture();
  context.after(async () => {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  const runtime = bridgeFixture(f.inputNoteId, f.artifacts.notePublicKey);
  const planner = new TreasurySppRebalancePlanner({ treasuryKeys: f.manager, bridge: runtime.bridge });
  const prepared = await planner.prepare({
    sessionId: f.sessionId,
    reservationId: Buffer.alloc(32, 0x47),
    pool: POOL,
    primaryAmountAtomic: 100_000n,
  });
  assert.equal(prepared.primaryAmountAtomic, 100_000n);
  assert.equal(prepared.changeAmountAtomic, 900_000n);

  await planner.confirm({
    operationId: prepared.operationId,
    primaryNoteId: prepared.primaryNoteId,
    transactionHash: Buffer.alloc(32, 0x48),
    ledgerSequence: 102,
    primaryOutputCommitment: prepared.primaryOutputCommitment,
    changeOutputCommitment: prepared.changeOutputCommitment,
  });
  const state = await f.store.readSnapshot();
  assert.equal(state.sppTreasuryNotes.find((note) => note.noteId === f.inputNoteId.toString("hex"))?.status, "SPENT");
  assert.deepEqual(
    state.sppTreasuryNotes.filter((note) => note.status === "ACTIVE").map((note) => note.amountAtomic).toSorted(),
    ["100000", "900000"],
  );
  assert.equal(state.sppSpendOperations[0]?.status, "CONFIRMED");
});

test("treasury rebalance abort restores the input and discards both prepared outputs", async (context) => {
  const f = await fixture();
  context.after(async () => {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  const runtime = bridgeFixture(f.inputNoteId, f.artifacts.notePublicKey);
  const planner = new TreasurySppRebalancePlanner({ treasuryKeys: f.manager, bridge: runtime.bridge });
  const prepared = await planner.prepare({
    sessionId: f.sessionId,
    reservationId: Buffer.alloc(32, 0x49),
    pool: POOL,
    primaryAmountAtomic: 100_000n,
  });
  await planner.abort({ operationId: prepared.operationId, primaryNoteId: prepared.primaryNoteId });
  const state = await f.store.readSnapshot();
  assert.equal(runtime.aborted(), true);
  assert.equal(state.sppSpendOperations.length, 0);
  assert.equal(state.sppTreasuryNotes.length, 1);
  assert.equal(state.sppTreasuryNotes[0]?.status, "ACTIVE");
});

test("treasury rebalance rejects a denomination when no larger owned note exists", async (context) => {
  const f = await fixture();
  context.after(async () => {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  const runtime = bridgeFixture(f.inputNoteId, f.artifacts.notePublicKey);
  const planner = new TreasurySppRebalancePlanner({ treasuryKeys: f.manager, bridge: runtime.bridge });
  await assert.rejects(planner.prepare({
    sessionId: f.sessionId,
    reservationId: Buffer.alloc(32, 0x4a),
    pool: POOL,
    primaryAmountAtomic: 1_000_000n,
  }), /no treasury SPP note can be split/u);
});
