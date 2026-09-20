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
import {
  PrivateBudgetDelegationProofPlanner,
  PrivateBudgetDelegationStateError,
} from "./private-delegation-proof-planner.js";
import { EncryptedPrivacyStateStore } from "./privacy-state-store.js";
import type { PrivateRandomSource } from "./voucher-issuer.js";

const NON_PRODUCTION_TEST_KEY = Buffer.alloc(32, 0x71);
const CONTROLLER = "CB23C2OYMIDYC7OG2PK6NJFIVCYONYV43ABREOGVTW2LT4C2G53G2CWU";
const ASSET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const SOURCE_OWNER = "CB2P6OWRQTMIDLN2XSD4PYSRP2P2U5TTR4VNCLEDKMXAQWN7CHWLHI27";
const CHILD_OWNER = "CDVATO436WNXJUOGCEFG4I3IHR6K5Y5WMTQREYXE4P53WN2JQOQAC2HE";
const SESSION_ID = Buffer.alloc(32, 1);
const SOURCE_NODE_ID = Buffer.alloc(32, 2);
const SOURCE_NOTE_ID = Buffer.alloc(32, 3);
const NETWORK_ID = Buffer.alloc(32, 4);
const POLICY_HASH = 101n;

class DeterministicNonProductionRandom implements PrivateRandomSource {
  #counter = 0;

  bytes(length: number): Uint8Array {
    assert.equal(length, 32);
    const digest = createHash("sha256")
      .update(`PHLOEM_NON_PRODUCTION_DELEGATION_TEST:${this.#counter++}`, "utf8")
      .digest();
    digest[0] = 0;
    return digest;
  }
}

function sourceContextHash(): bigint {
  return poseidon2HashFields([
    1n,
    ...bytes32ToLimbs(NETWORK_ID),
    ...addressFields(addressFromStrKey(CONTROLLER)),
    ...bytes32ToLimbs(SESSION_ID),
    ...bytes32ToLimbs(SOURCE_NODE_ID),
    ...addressFields(addressFromStrKey(SOURCE_OWNER)),
    ...addressFields(addressFromStrKey(ASSET)),
    POLICY_HASH,
    ...bytes32ToLimbs(SOURCE_NOTE_ID),
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
        if (options.mutatePublic) publicSignals[3] = publicSignals[3]! + 1n;
        return { proof, publicSignals };
      },
    } as unknown as LocalGroth16ProofWorker,
  };
}

async function fixture(options: { mutatePublic?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "phloem-delegation-planner-test-"));
  const store = new EncryptedPrivacyStateStore(join(directory, "state.enc.json"), NON_PRODUCTION_TEST_KEY);
  await store.initialize();
  const amountAtomic = 500_000n;
  const blinding = 103n;
  const contextHash = sourceContextHash();
  await store.transaction((state) => {
    state.budgetNotes.push({
      noteId: SOURCE_NOTE_ID.toString("hex"),
      sessionId: SESSION_ID.toString("hex"),
      nodeId: SOURCE_NODE_ID.toString("hex"),
      owner: SOURCE_OWNER,
      asset: ASSET,
      policyHash: POLICY_HASH.toString(),
      contextHash: contextHash.toString(),
      commitment: poseidon2Hash3(contextHash, amountAtomic, blinding, POSEIDON_DOMAINS.budgetNote).toString(),
      amountAtomic: amountAtomic.toString(),
      blinding: blinding.toString(),
      status: "ACTIVE",
    });
  });
  const proving = proofWorker(options);
  const planner = new PrivateBudgetDelegationProofPlanner({
    store,
    proofWorker: proving.worker,
    artifacts: {
      wasmPath: "private-boundary-test-only",
      zkeyPath: "private-boundary-test-only",
      verificationKeyPath: "private-boundary-test-only",
      publicInputCount: 8,
    },
    random: new DeterministicNonProductionRandom(),
  });
  return { directory, store, planner, witnesses: proving.witnesses };
}

function request(delegatedAmountAtomic = 200_000n) {
  return {
    sessionId: SESSION_ID,
    sourceBudgetNoteId: SOURCE_NOTE_ID,
    sourceAgent: SOURCE_OWNER,
    networkId: NETWORK_ID,
    treasuryController: CONTROLLER,
    childOwner: CHILD_OWNER,
    childPolicy: {
      category_mask: 3n,
      allowed_actions_mask: 6n,
      expiry: 5_000_000,
      remaining_delegation_depth: 0,
    },
    delegatedAmountAtomic,
    createdAtUnixMs: 1_700_000_000_000,
  };
}

test("planner stages one hidden delegation and reconciles child plus remainder only after confirmation", async (context) => {
  const { directory, store, planner, witnesses } = await fixture();
  context.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const prepared = await planner.prepare(request());
  assert.equal("delegated_amount" in prepared.delegation, false);
  assert.equal(prepared.delegation.child_owner, CHILD_OWNER);
  assert.equal(prepared.delegation.remainder_note_id?.length, 32);
  assert.equal(witnesses[0]?.inputAmount, "500000");
  assert.equal(witnesses[0]?.output1Amount, "200000");
  assert.equal(witnesses[0]?.output2Amount, "300000");

  const staged = await store.readSnapshot();
  assert.equal(staged.budgetNotes[0]?.status, "SPEND_PENDING");
  assert.equal(staged.budgetNotes[0]?.pendingOperationId, prepared.operationId.toString("hex"));
  assert.equal(staged.privateBudgetDelegations[0]?.status, "PREPARED");
  assert.equal(staged.budgetNotes.length, 1);

  await planner.confirm({
    operationId: prepared.operationId,
    transactionHash: Buffer.alloc(32, 10),
    ledgerSequence: 1234,
  });
  const confirmed = await store.readSnapshot();
  assert.equal(confirmed.budgetNotes.find((note) => note.noteId === SOURCE_NOTE_ID.toString("hex"))?.status, "SPENT");
  assert.equal(confirmed.budgetNotes.find((note) => note.owner === CHILD_OWNER)?.amountAtomic, "200000");
  assert.equal(confirmed.budgetNotes.find((note) => note.owner === SOURCE_OWNER && note.status === "ACTIVE")?.amountAtomic, "300000");
  assert.equal(confirmed.privateBudgetDelegations[0]?.status, "CONFIRMED");
  assert.equal(confirmed.privateBudgetDelegations[0]?.confirmation?.ledgerSequence, 1234);

  await planner.confirm({
    operationId: prepared.operationId,
    transactionHash: Buffer.alloc(32, 10),
    ledgerSequence: 1234,
  });
});

test("full-note delegation uses the canonical NONE remainder", async (context) => {
  const { directory, store, planner, witnesses } = await fixture();
  context.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const prepared = await planner.prepare(request(500_000n));
  assert.equal(prepared.delegation.remainder_note_id, undefined);
  assert.equal(prepared.delegation.remainder_commitment, undefined);
  assert.equal(witnesses[0]?.output2Kind, "0");
  assert.equal(witnesses[0]?.output2Amount, "0");
  assert.equal(witnesses[0]?.output2Blinding, "0");
});

test("abort releases the source and removes every staged output", async (context) => {
  const { directory, store, planner } = await fixture();
  context.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const prepared = await planner.prepare(request());
  await planner.abort(prepared.operationId);
  const state = await store.readSnapshot();
  assert.equal(state.budgetNotes[0]?.status, "ACTIVE");
  assert.equal(state.budgetNotes[0]?.pendingOperationId, undefined);
  assert.deepEqual(state.privateBudgetDelegations, []);
});

test("public-signal substitution aborts the staged delegation and preserves the source", async (context) => {
  const { directory, store, planner } = await fixture({ mutatePublic: true });
  context.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  await assert.rejects(planner.prepare(request()), /public signals do not match/u);
  const state = await store.readSnapshot();
  assert.equal(state.budgetNotes[0]?.status, "ACTIVE");
  assert.deepEqual(state.privateBudgetDelegations, []);
});

test("a held source cannot prepare a concurrent private transition", async (context) => {
  const { directory, store, planner } = await fixture();
  context.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  await planner.prepare(request());
  await assert.rejects(planner.prepare(request(100_000n)), PrivateBudgetDelegationStateError);
});
