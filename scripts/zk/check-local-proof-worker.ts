import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  POSEIDON_DOMAINS,
  addressFields,
  addressFromStrKey,
  bytes32ToLimbs,
  poseidon2Hash3,
  poseidon2HashFields,
} from "../../packages/protocol-types/src/index.js";
import {
  EncryptedPrivacyStateStore,
  LocalGroth16ProofWorker,
  PrivateReservationProofPlanner,
  PrivateVoucherIssuer,
  type Groth16Witness,
  type PrivateRandomSource,
} from "../../packages/privacy-runtime/src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const setup = resolve(root, ".phloem/budget-transition-setup");
const artifacts = {
  wasmPath: resolve(setup, "BudgetTransitionV1_js/BudgetTransitionV1.wasm"),
  zkeyPath: resolve(setup, "budget_transition_final.zkey"),
  verificationKeyPath: resolve(setup, "verification_key.json"),
  publicInputCount: 8,
} as const;
const witness = JSON.parse(await readFile(
  resolve(root, "circuits/budget-transition-v1/input-reservation.v1.json"),
  "utf8",
)) as Groth16Witness;
const expectedPublic = JSON.parse(await readFile(resolve(setup, "reservation-public.json"), "utf8")) as string[];

const result = await new LocalGroth16ProofWorker().prove(witness, {
  ...artifacts,
});

assert.deepEqual(result.publicSignals.map(String), expectedPublic);
assert.equal(result.proof.a.length, 64);
assert.equal(result.proof.b.length, 128);
assert.equal(result.proof.c.length, 64);

class DeterministicNonProductionRandom implements PrivateRandomSource {
  #counter = 0;

  bytes(length: number): Uint8Array {
    assert.equal(length, 32);
    const value = createHash("sha256")
      .update(`PHLOEM_NON_PRODUCTION_LOCAL_PROVER_CHECK:${this.#counter++}`, "utf8")
      .digest();
    value[0] = 0;
    return value;
  }
}

const CONTROLLER = "CB23C2OYMIDYC7OG2PK6NJFIVCYONYV43ABREOGVTW2LT4C2G53G2CWU";
const ASSET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const OWNER = "CB2P6OWRQTMIDLN2XSD4PYSRP2P2U5TTR4VNCLEDKMXAQWN7CHWLHI27";
const sessionId = Buffer.alloc(32, 31);
const nodeId = Buffer.alloc(32, 32);
const noteId = Buffer.alloc(32, 33);
const networkId = Buffer.alloc(32, 34);
const policyHash = 211n;
const sourceContextHash = poseidon2HashFields([
  1n,
  ...bytes32ToLimbs(networkId),
  ...addressFields(addressFromStrKey(CONTROLLER)),
  ...bytes32ToLimbs(sessionId),
  ...bytes32ToLimbs(nodeId),
  ...addressFields(addressFromStrKey(OWNER)),
  ...addressFields(addressFromStrKey(ASSET)),
  policyHash,
  ...bytes32ToLimbs(noteId),
], POSEIDON_DOMAINS.contextInit, POSEIDON_DOMAINS.contextFold);
const sourceAmount = 500_000n;
const sourceBlinding = 223n;
const privateDirectory = await mkdtemp(resolve(tmpdir(), "phloem-real-planner-check-"));
const store = new EncryptedPrivacyStateStore(
  resolve(privateDirectory, "state.enc.json"),
  Buffer.alloc(32, 0x71),
);
try {
  await store.initialize();
  await store.transaction((state) => {
    state.budgetNotes.push({
      noteId: noteId.toString("hex"),
      sessionId: sessionId.toString("hex"),
      nodeId: nodeId.toString("hex"),
      owner: OWNER,
      asset: ASSET,
      policyHash: policyHash.toString(),
      contextHash: sourceContextHash.toString(),
      commitment: poseidon2Hash3(sourceContextHash, sourceAmount, sourceBlinding, POSEIDON_DOMAINS.budgetNote).toString(),
      amountAtomic: sourceAmount.toString(),
      blinding: sourceBlinding.toString(),
      status: "ACTIVE",
    });
  });
  const random = new DeterministicNonProductionRandom();
  const issuer = new PrivateVoucherIssuer(store, random);
  const planner = new PrivateReservationProofPlanner({
    store,
    issuer,
    proofWorker: new LocalGroth16ProofWorker(),
    artifacts,
    random,
  });
  const prepared = await planner.prepare({
    sessionId,
    sourceBudgetNoteId: noteId,
    sourceAgent: OWNER,
    networkId,
    treasuryController: CONTROLLER,
    approvedProviderRoot: 227n,
    categoryId: 7,
    amountAtomic: 100_000n,
    offerReferenceHash: Buffer.alloc(32, 35),
    providerSppPublicKey: 229n,
    claimDeadlineLedger: 5_000_000,
    createdAtUnixMs: 1_700_000_000_000,
  });
  await issuer.confirmReservationOpen({
    reservationId: prepared.input.reservation_id,
    transactionHash: Buffer.alloc(32, 36),
    ledgerSequence: 4_900_000,
  });
  const privateState = await store.readSnapshot();
  assert.equal(privateState.reservations[0]?.status, "OPEN");
  assert.equal(privateState.budgetNotes.find((note) => note.status === "ACTIVE")?.amountAtomic, "400000");
} finally {
  store.close();
  await rm(privateDirectory, { recursive: true, force: true });
}

process.stdout.write("LocalProofWorker and PRIVATE reservation planner generated and verified live proofs: PASS\n");
