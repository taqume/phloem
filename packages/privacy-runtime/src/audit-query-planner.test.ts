import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  POSEIDON_DOMAINS,
  bytes32ToLimbs,
  finalAuditQueryStatementHash,
  poseidon2Hash3,
} from "@phloem/protocol-types";
import type { Groth16Proof } from "@phloem/treasury-controller-client";

import {
  AuditQueryStateError,
  FinalAuditQueryPlanner,
} from "./audit-query-planner.js";
import type {
  Groth16ProvingArtifacts,
  Groth16Witness,
  LocalGroth16ProofWorker,
  LocalProofResult,
} from "./local-proof-worker.js";
import { EncryptedPrivacyStateStore } from "./privacy-state-store.js";

const SESSION_ID = Buffer.alloc(32, 0x31);
const SNAPSHOT_HASH = Buffer.alloc(32, 0x42);
const AUDIT_CONTEXT = 101n;
const TOTAL = 400_000n;
const BLINDING = 103n;
const AUDIT_VERSION = 2;
const THRESHOLD = 500_000n;

const DUMMY_PROOF: Groth16Proof = {
  a: Buffer.alloc(64, 1),
  b: Buffer.alloc(128, 2),
  c: Buffer.alloc(64, 3),
};

class CapturingProofWorker {
  witness: Groth16Witness | undefined;
  expectedSignals: readonly bigint[] = [];

  async prove(witness: Groth16Witness, _artifacts: Groth16ProvingArtifacts): Promise<LocalProofResult> {
    this.witness = witness;
    return { proof: DUMMY_PROOF, publicSignals: this.expectedSignals };
  }
}

function artifacts(): Groth16ProvingArtifacts {
  return {
    wasmPath: "/non-secret/audit.wasm",
    zkeyPath: "/non-secret/audit.zkey",
    verificationKeyPath: "/non-secret/audit-vk.json",
    publicInputCount: 7,
  };
}

function publicInputs(threshold = THRESHOLD): readonly bigint[] {
  const commitment = poseidon2Hash3(AUDIT_CONTEXT, TOTAL, BLINDING, POSEIDON_DOMAINS.auditTotal);
  const [snapshotHigh, snapshotLow] = bytes32ToLimbs(SNAPSHOT_HASH);
  return [
    AUDIT_CONTEXT,
    snapshotHigh,
    snapshotLow,
    commitment,
    threshold,
    BigInt(AUDIT_VERSION),
    finalAuditQueryStatementHash(AUDIT_CONTEXT, SNAPSHOT_HASH, commitment, AUDIT_VERSION),
  ];
}

async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "phloem-audit-query-test-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new EncryptedPrivacyStateStore(join(directory, "state.enc.json"), Buffer.alloc(32, 0x51));
  await store.initialize();
  context.after(() => store.close());
  const commitment = publicInputs()[3]!;
  await store.transaction((state) => {
    state.auditAccumulators.push({
      sessionId: SESSION_ID.toString("hex"),
      auditContextHash: AUDIT_CONTEXT.toString(),
      totalSpendAtomic: TOTAL.toString(),
      blinding: BLINDING.toString(),
      commitment: commitment.toString(),
      auditVersion: AUDIT_VERSION,
    });
  });
  const worker = new CapturingProofWorker();
  const planner = new FinalAuditQueryPlanner({
    store,
    proofWorker: worker as unknown as LocalGroth16ProofWorker,
    artifacts: artifacts(),
  });
  return { planner, worker };
}

test("builds TOTAL_SPEND_LEQ only from the encrypted opening and canonical final statement", async (context) => {
  const { planner, worker } = await fixture(context);
  worker.expectedSignals = publicInputs();

  const bundle = await planner.proveTotalSpendLeq({
    sessionId: SESSION_ID,
    publicInputs: worker.expectedSignals,
  });

  assert.equal(bundle.templateId, "TOTAL_SPEND_LEQ");
  assert.equal(bundle.templateVersion, 1);
  assert.deepEqual(bundle.snapshotHash, SNAPSHOT_HASH);
  assert.equal(bundle.thresholdAtomic, THRESHOLD);
  assert.equal(bundle.auditVersion, AUDIT_VERSION);
  assert.equal(worker.witness?.totalSpendAtomic, TOTAL.toString());
  assert.equal(worker.witness?.totalSpendBlinding, BLINDING.toString());
});

test("fails closed for false predicates and controller/private-state mismatches", async (context) => {
  const { planner, worker } = await fixture(context);
  worker.expectedSignals = publicInputs();

  await assert.rejects(
    planner.proveTotalSpendLeq({ sessionId: SESSION_ID, publicInputs: publicInputs(399_999n) }),
    /predicate is false/u,
  );

  const wrongCommitment = [...publicInputs()];
  wrongCommitment[3] = wrongCommitment[3]! + 1n;
  await assert.rejects(
    planner.proveTotalSpendLeq({ sessionId: SESSION_ID, publicInputs: wrongCommitment }),
    /does not match the encrypted opening/u,
  );

  const wrongSnapshotStatement = [...publicInputs()];
  wrongSnapshotStatement[1] = wrongSnapshotStatement[1]! + 1n;
  await assert.rejects(
    planner.proveTotalSpendLeq({ sessionId: SESSION_ID, publicInputs: wrongSnapshotStatement }),
    /snapshot statement is not canonical/u,
  );
});

test("rejects prover output substitution", async (context) => {
  const { planner, worker } = await fixture(context);
  worker.expectedSignals = [...publicInputs().slice(0, 6), publicInputs()[6]! + 1n];

  await assert.rejects(
    planner.proveTotalSpendLeq({ sessionId: SESSION_ID, publicInputs: publicInputs() }),
    AuditQueryStateError,
  );
});
