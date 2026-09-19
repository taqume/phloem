import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  POSEIDON_DOMAINS,
  addressFields,
  addressFromStrKey,
  bytes32ToLimbs,
  poseidon2Hash3,
  poseidon2HashFields,
} from "@phloem/protocol-types";
import type { Groth16Proof } from "@phloem/treasury-controller-client";

import type { Groth16Witness, LocalGroth16ProofWorker } from "./local-proof-worker.js";
import { EncryptedPrivacyStateStore } from "./privacy-state-store.js";
import { PrivateReservationProofPlanner } from "./reservation-proof-planner.js";
import { PrivateVoucherIssuer, type PrivateRandomSource } from "./voucher-issuer.js";

const NON_PRODUCTION_TEST_KEY = Buffer.alloc(32, 0x61);
const CONTROLLER = "CB23C2OYMIDYC7OG2PK6NJFIVCYONYV43ABREOGVTW2LT4C2G53G2CWU";
const ASSET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const OWNER = "CB2P6OWRQTMIDLN2XSD4PYSRP2P2U5TTR4VNCLEDKMXAQWN7CHWLHI27";
const SESSION_ID = Buffer.alloc(32, 1);
const NODE_ID = Buffer.alloc(32, 2);
const NOTE_ID = Buffer.alloc(32, 3);
const NETWORK_ID = Buffer.alloc(32, 4);
const POLICY_HASH = 101n;

class DeterministicNonProductionRandom implements PrivateRandomSource {
  #counter = 0;

  bytes(length: number): Uint8Array {
    assert.equal(length, 32);
    const digest = createHash("sha256")
      .update(`PHLOEM_NON_PRODUCTION_PLANNER_TEST:${this.#counter++}`, "utf8")
      .digest();
    digest[0] = 0;
    return digest;
  }
}

function contextHash(noteId = NOTE_ID): bigint {
  return poseidon2HashFields([
    1n,
    ...bytes32ToLimbs(NETWORK_ID),
    ...addressFields(addressFromStrKey(CONTROLLER)),
    ...bytes32ToLimbs(SESSION_ID),
    ...bytes32ToLimbs(NODE_ID),
    ...addressFields(addressFromStrKey(OWNER)),
    ...addressFields(addressFromStrKey(ASSET)),
    POLICY_HASH,
    ...bytes32ToLimbs(noteId),
  ], POSEIDON_DOMAINS.contextInit, POSEIDON_DOMAINS.contextFold);
}

function proofWorker(options: { mutatePublic?: boolean } = {}): {
  worker: LocalGroth16ProofWorker;
  witnesses: Groth16Witness[];
} {
  const witnesses: Groth16Witness[] = [];
  const proof: Groth16Proof = { a: Buffer.alloc(64), b: Buffer.alloc(128), c: Buffer.alloc(64) };
  return {
    witnesses,
    worker: {
      prove: async (witness: Groth16Witness) => {
        witnesses.push(witness);
        const names = [
          "inputContextHash",
          "inputCommitment",
          "output1ContextHash",
          "output1Commitment",
          "output1Kind",
          "output2ContextHash",
          "output2Commitment",
          "output2Kind",
        ] as const;
        const publicSignals = names.map((name) => BigInt(witness[name] as string));
        if (options.mutatePublic) publicSignals[0] = publicSignals[0]! + 1n;
        return { proof, publicSignals };
      },
    } as unknown as LocalGroth16ProofWorker,
  };
}

async function fixture(options: { mutatePublic?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "phloem-reservation-planner-test-"));
  const store = new EncryptedPrivacyStateStore(join(directory, "state.enc.json"), NON_PRODUCTION_TEST_KEY);
  await store.initialize();
  const sourceContextHash = contextHash();
  const sourceAmount = 500_000n;
  const sourceBlinding = 103n;
  await store.transaction((state) => {
    state.budgetNotes.push({
      noteId: NOTE_ID.toString("hex"),
      sessionId: SESSION_ID.toString("hex"),
      nodeId: NODE_ID.toString("hex"),
      owner: OWNER,
      asset: ASSET,
      policyHash: POLICY_HASH.toString(),
      contextHash: sourceContextHash.toString(),
      commitment: poseidon2Hash3(sourceContextHash, sourceAmount, sourceBlinding, POSEIDON_DOMAINS.budgetNote).toString(),
      amountAtomic: sourceAmount.toString(),
      blinding: sourceBlinding.toString(),
      status: "ACTIVE",
    });
  });
  const random = new DeterministicNonProductionRandom();
  const issuer = new PrivateVoucherIssuer(store, random);
  const proving = proofWorker(options);
  const planner = new PrivateReservationProofPlanner({
    store,
    issuer,
    proofWorker: proving.worker,
    artifacts: {
      wasmPath: "private-boundary-test-only",
      zkeyPath: "private-boundary-test-only",
      verificationKeyPath: "private-boundary-test-only",
      publicInputCount: 8,
    },
    random,
  });
  return { directory, store, issuer, planner, witnesses: proving.witnesses };
}

function request(amountAtomic = 100_000n) {
  return {
    sessionId: SESSION_ID,
    sourceBudgetNoteId: NOTE_ID,
    sourceAgent: OWNER,
    networkId: NETWORK_ID,
    treasuryController: CONTROLLER,
    approvedProviderRoot: 107n,
    categoryId: 7,
    amountAtomic,
    offerReferenceHash: Buffer.alloc(32, 5),
    providerSppPublicKey: 109n,
    claimDeadlineLedger: 5_000_000,
    createdAtUnixMs: 1_700_000_000_000,
  };
}

test("planner proves hidden conservation and stages a reservation-specific key plus remainder", async (context) => {
  const { directory, store, issuer, planner, witnesses } = await fixture();
  context.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const prepared = await planner.prepare(request());
  assert.equal("amount_atomic" in prepared.input, false);
  assert.equal(prepared.input.remainder_budget_note_id?.length, 32);
  assert.equal(witnesses[0]?.inputAmount, "500000");
  assert.equal(witnesses[0]?.output1Amount, "100000");
  assert.equal(witnesses[0]?.output2Amount, "400000");

  const staged = await store.readSnapshot();
  assert.equal(staged.budgetNotes[0]?.status, "ACTIVE");
  assert.equal(staged.reservations[0]?.status, "PREPARED");
  assert.equal(staged.reservations[0]?.preparedRemainder?.amountAtomic, "400000");

  await issuer.confirmReservationOpen({
    reservationId: prepared.input.reservation_id,
    transactionHash: Buffer.alloc(32, 10),
    ledgerSequence: 1234,
  });
  const reconciled = await store.readSnapshot();
  assert.equal(reconciled.budgetNotes.find((note) => note.noteId === NOTE_ID.toString("hex"))?.status, "SPENT");
  assert.equal(reconciled.budgetNotes.find((note) => note.status === "ACTIVE")?.amountAtomic, "400000");
  assert.equal(reconciled.reservations[0]?.status, "OPEN");
  assert.equal(reconciled.reservations[0]?.openConfirmation?.ledgerSequence, 1234);
});

test("full-note reservation uses canonical NONE remainder signals", async (context) => {
  const { directory, store, planner, witnesses } = await fixture();
  context.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const prepared = await planner.prepare(request(500_000n));
  assert.equal(prepared.input.remainder_budget_note_id, undefined);
  assert.equal(prepared.input.remainder_commitment, undefined);
  assert.equal(witnesses[0]?.output2Kind, "0");
  assert.equal(witnesses[0]?.output2Amount, "0");
  assert.equal(witnesses[0]?.output2Blinding, "0");
});

test("public-signal substitution discards staged secrets and preserves the source", async (context) => {
  const { directory, store, planner } = await fixture({ mutatePublic: true });
  context.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await assert.rejects(planner.prepare(request()), /public signals do not match/u);
  const state = await store.readSnapshot();
  assert.equal(state.budgetNotes[0]?.status, "ACTIVE");
  assert.deepEqual(state.reservations, []);
});
