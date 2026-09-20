import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { POSEIDON_DOMAINS, networkId, poseidon2Hash3 } from "@phloem/protocol-types";
import type { Groth16Proof, SppProof } from "@phloem/treasury-controller-client";

import type { Groth16Witness, LocalGroth16ProofWorker } from "./local-proof-worker.js";
import {
  PrivateSessionActivationPlanner,
  type SppPrivateDepositPlanner,
} from "./private-session-activation.js";
import { EncryptedPrivacyStateStore } from "./privacy-state-store.js";
import { TreasuryPrivacyKeyManager } from "./treasury-privacy-key.js";
import type { PrivateRandomSource } from "./voucher-issuer.js";

const COMPANY = "GBRFJEDXTYPKMZCQNXQV5LS63YBKRVNTQLE37GKKMQEO3TQ2N6HI4QUC";
const CONTROLLER = "CDSG6DMWDPFDIBEXFSNTONEDDJ4CCNP2UJZJUFTRGX63ZDZMRGMZFHAH";
const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const POOL = "CC57FDSWPIHALXW2XWVSKEA7FA72Z37Y7AP5ASRY6V3CXAZCWQAOSLB4";
const NETWORK_ID = Buffer.from(networkId("Test SDF Network ; September 2015"));
const SESSION_ID = Buffer.alloc(32, 1);
const ROOT_NODE_ID = Buffer.alloc(32, 2);
const ROOT_NOTE_ID = Buffer.alloc(32, 3);
const PROOF: Groth16Proof = { a: Buffer.alloc(64), b: Buffer.alloc(128), c: Buffer.alloc(64) };

class TestRandom implements PrivateRandomSource {
  #counter = 0;

  bytes(length: number): Uint8Array {
    assert.equal(length, 32);
    const value = createHash("sha256").update(`PHLOEM_NON_PRODUCTION_ACTIVATION:${this.#counter++}`).digest();
    value[0] = 0;
    return value;
  }
}

function proofWorker(mutatePublic = false): LocalGroth16ProofWorker {
  return {
    prove: async (witness: Groth16Witness) => {
      const names = [
        "rootContextHash",
        "rootBudgetCommitment",
        "auditContextHash",
        "initialAuditTotalCommitment",
        "treasurySppKeyCommitment",
        "sppFundingOutputCommitment",
        "fundingAmount",
      ] as const;
      const publicSignals = names.map((name) => BigInt(witness[name] as string));
      if (mutatePublic) publicSignals[0] = publicSignals[0]! + 1n;
      return { proof: PROOF, publicSignals };
    },
  } as unknown as LocalGroth16ProofWorker;
}

function sppPlanner(tamperOutput = false): {
  planner: SppPrivateDepositPlanner;
  aborted: Buffer[];
  confirmed: Buffer[];
} {
  const aborted: Buffer[] = [];
  const confirmed: Buffer[] = [];
  let preparedFundingCommitment: bigint | undefined;
  return {
    aborted,
    confirmed,
    planner: {
      prepare: async (input) => {
        const blinding = 59n;
        const output = poseidon2Hash3(
          input.amountAtomic,
          input.treasurySppPublicKey,
          blinding,
          POSEIDON_DOMAINS.sppNote,
        );
        preparedFundingCommitment = tamperOutput ? output + 1n : output;
        const proof: SppProof = {
          asp_membership_root: 0n,
          asp_non_membership_root: 0n,
          ext_data_hash: Buffer.alloc(32),
          input_nullifiers: [0n, 0n],
          output_commitment0: preparedFundingCommitment,
          output_commitment1: 0n,
          proof: PROOF,
          public_amount: input.amountAtomic,
          root: 0n,
        };
        return {
          operationId: Buffer.alloc(32, 7),
          proof,
          extData: {
            encrypted_output0: Buffer.alloc(96),
            encrypted_output1: Buffer.alloc(96),
            ext_amount: input.amountAtomic,
            recipient: input.sppPool,
          },
          fundingOutputBlinding: blinding,
        };
      },
      abort: async (operationId) => {
        aborted.push(Buffer.from(operationId));
      },
      confirm: async (operationId, _transactionHash, _ledgerSequence, expectedFundingCommitment) => {
        assert.equal(expectedFundingCommitment, preparedFundingCommitment);
        confirmed.push(Buffer.from(operationId));
        return { fundingLeafIndex: 11 };
      },
    },
  };
}

async function fixture(options: { mutatePublic?: boolean; tamperOutput?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "phloem-activation-test-"));
  const store = new EncryptedPrivacyStateStore(join(directory, "state.enc.json"), Buffer.alloc(32, 0x63));
  await store.initialize();
  const random = new TestRandom();
  const treasuryKeys = new TreasuryPrivacyKeyManager(store, random);
  const spp = sppPlanner(options.tamperOutput);
  const planner = new PrivateSessionActivationPlanner({
    store,
    treasuryKeys,
    proofWorker: proofWorker(options.mutatePublic),
    rootBackingArtifacts: {
      wasmPath: "private-boundary-test-only",
      zkeyPath: "private-boundary-test-only",
      verificationKeyPath: "private-boundary-test-only",
      publicInputCount: 7,
    },
    spp: spp.planner,
    sppPool: POOL,
    random,
  });
  return { directory, store, planner, spp };
}

const request = {
  sessionId: SESSION_ID,
  company: COMPANY,
  networkId: NETWORK_ID,
  treasuryController: CONTROLLER,
  asset: ASSET,
  policyHash: 101n,
  rootNodeId: ROOT_NODE_ID,
  rootNoteId: ROOT_NOTE_ID,
  fundingAmountAtomic: 1_000_000n,
  createdAtUnixMs: 1_700_000_000_000,
} as const;

test("PRIVATE activation remains staged until its atomic Testnet call is confirmed", async (context) => {
  const f = await fixture();
  context.after(async () => {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });

  const prepared = await f.planner.prepare(request);
  assert.equal(prepared.input.funding_amount, request.fundingAmountAtomic);
  assert.equal(prepared.input.spp_proof.output_commitment0, prepared.publicSignals[5]);
  assert.equal(prepared.input.root_note.commitment, prepared.publicSignals[1]);

  const staged = await f.store.readSnapshot();
  assert.equal(staged.treasuryPrivacyKeys.length, 1);
  assert.equal(staged.privateSessionActivations.length, 1);
  assert.equal(staged.budgetNotes.length, 0);
  assert.equal(staged.auditAccumulators.length, 0);
  assert.equal(staged.sppTreasuryNotes.length, 0);

  await f.planner.confirm({
    operationId: prepared.operationId,
    transactionHash: Buffer.alloc(32, 8),
    ledgerSequence: 4_900_000,
  });
  const confirmed = await f.store.readSnapshot();
  assert.equal(confirmed.privateSessionActivations.length, 0);
  assert.equal(confirmed.budgetNotes[0]?.status, "ACTIVE");
  assert.equal(confirmed.budgetNotes[0]?.owner, COMPANY);
  assert.equal(confirmed.auditAccumulators[0]?.totalSpendAtomic, "0");
  assert.equal(confirmed.sppTreasuryNotes[0]?.status, "ACTIVE");
  assert.equal(confirmed.sppTreasuryNotes[0]?.leafIndex, 11);
  assert.equal(f.spp.confirmed.length, 1);
});

test("aborting a prepared PRIVATE activation never exposes active authority", async (context) => {
  const f = await fixture();
  context.after(async () => {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });

  const prepared = await f.planner.prepare(request);
  await f.planner.abort(prepared.operationId);
  const state = await f.store.readSnapshot();
  assert.equal(state.privateSessionActivations.length, 0);
  assert.equal(state.budgetNotes.length, 0);
  assert.equal(state.auditAccumulators.length, 0);
  assert.equal(state.sppTreasuryNotes.length, 0);
  assert.equal(state.treasuryPrivacyKeys.length, 1);
  assert.equal(f.spp.aborted.length, 1);
});

test("SPP output or root-proof signal substitution aborts before state staging", async (context) => {
  for (const options of [{ tamperOutput: true }, { mutatePublic: true }]) {
    const f = await fixture(options);
    context.after(async () => {
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    });
    await assert.rejects(f.planner.prepare(request), /SPP funding output|public signals/u);
    assert.equal((await f.store.readSnapshot()).privateSessionActivations.length, 0);
    assert.equal(f.spp.aborted.length, 1);
  }
});
