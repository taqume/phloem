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
import { Keypair } from "@stellar/stellar-sdk";
import type { Groth16Proof, SppProof } from "@phloem/treasury-controller-client";

import type { Groth16Witness, LocalGroth16ProofWorker } from "./local-proof-worker.js";
import {
  PrivateSettlementPlanner,
  type SppPrivateTransferPlanner,
} from "./private-settlement-planner.js";
import { EncryptedPrivacyStateStore } from "./privacy-state-store.js";
import type { SppRuntimeBinding } from "./spp-runtime-binding.js";
import { TreasuryPrivacyKeyManager } from "./treasury-privacy-key.js";
import { PrivateVoucherIssuer, type PrivateRandomSource } from "./voucher-issuer.js";

const CONTROLLER = "CB23C2OYMIDYC7OG2PK6NJFIVCYONYV43ABREOGVTW2LT4C2G53G2CWU";
const ASSET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const OWNER = "CB2P6OWRQTMIDLN2XSD4PYSRP2P2U5TTR4VNCLEDKMXAQWN7CHWLHI27";
const SPP_POOL = "CC57FDSWPIHALXW2XWVSKEA7FA72Z37Y7AP5ASRY6V3CXAZCWQAOSLB4";
const SPP_DEPLOYMENT: SppRuntimeBinding = {
  network: "testnet",
  networkPassphrase: "Test SDF Network ; September 2015",
  sourceRevision: "5f3a5d41f452069caf8d0e1654675bca55cb94d3",
  poolContractId: SPP_POOL,
  tokenContractId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  aspMembershipContractId: "CB6APJ4NHOTHETD4IZERG3CIQMC6YDSSWWCRNN7NG5YZNO5RTMMZ2Z55",
  aspNonMembershipContractId: "CC43C3FITFAECE7FA4YJHMZS2ANHM5O2ZVTXI2F2K5W5V4R35JQUEWHI",
  verifierContractId: "CCLUTVXT4XTE52CMG5W2YUYRR32KVSO5GNOMIL4ZLNFZYDXVPPGGS33A",
  publicKeyRegistryContractId: "CB3OX6UGZCKQZFN3WQHCIBBAMIWIDHLZWC4JS6VYJE4U5WWQN5GFELKT",
  asset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5", decimals: 7 },
  policy: { name: "blocklist", flags: 2, aspLevels: 10, poolLevels: 20, maximumDepositAmount: 1_000_000_000n },
};
const PROVIDER = Keypair.fromRawEd25519Seed(createHash("sha256").update("PHLOEM_NON_PRODUCTION_PROVIDER").digest()).publicKey();
const proof: Groth16Proof = { a: Buffer.alloc(64), b: Buffer.alloc(128), c: Buffer.alloc(64) };

class TestRandom implements PrivateRandomSource {
  #counter = 0;
  bytes(length: number): Uint8Array {
    assert.equal(length, 32);
    const value = createHash("sha256").update(`PHLOEM_NON_PRODUCTION_SETTLEMENT:${this.#counter++}`).digest();
    value[0] = 0;
    return value;
  }
}

function mockWorker(): LocalGroth16ProofWorker {
  return {
    prove: async (witness: Groth16Witness) => {
      const names = [
        "reservationContextHash", "reservationCommitment", "voucherContextHash", "voucherAmountCommitment",
        "providerCommitment", "providerSppOutputCommitment", "treasurySppKeyCommitment", "sppRefundOutputCommitment",
        "refundContextHash", "refundBudgetCommitment", "approvedProviderRoot", "auditContextHash",
        "oldAuditTotalCommitment", "newAuditTotalCommitment", "usageRoot", "offerCommitment",
      ] as const;
      return { proof, publicSignals: names.map((name) => BigInt(witness[name] as string)) };
    },
  } as unknown as LocalGroth16ProofWorker;
}

async function fixture(tamperSpp = false) {
  const directory = await mkdtemp(join(tmpdir(), "phloem-settlement-planner-test-"));
  const store = new EncryptedPrivacyStateStore(join(directory, "state.enc.json"), Buffer.alloc(32, 0x72));
  await store.initialize();
  const random = new TestRandom();
  const issuer = new PrivateVoucherIssuer(store, random);
  const sessionId = Buffer.alloc(32, 1);
  const sourceNoteId = Buffer.alloc(32, 2);
  const reservationId = Buffer.alloc(32, 3);
  const networkId = Buffer.alloc(32, 4);
  const serviceIdHash = Buffer.alloc(32, 5);
  const providerSppPublicKey = 211n;
  const providerFields = [
    1n,
    ...addressFields(addressFromStrKey(PROVIDER)),
    providerSppPublicKey,
    ...bytes32ToLimbs(serviceIdHash),
    7n,
    2n,
  ];
  const providerRoot = poseidon2HashFields(providerFields, POSEIDON_DOMAINS.providerInit, POSEIDON_DOMAINS.providerFold);
  await store.transaction((state) => {
    state.budgetNotes.push({
      noteId: sourceNoteId.toString("hex"),
      sessionId: sessionId.toString("hex"),
      nodeId: Buffer.alloc(32, 6).toString("hex"),
      owner: OWNER,
      asset: ASSET,
      policyHash: "223",
      contextHash: "227",
      commitment: "229",
      amountAtomic: "500000",
      blinding: "233",
      status: "ACTIVE",
    });
  });
  await issuer.prepareReservation({
    reservationId,
    sessionId,
    sourceBudgetNoteId: sourceNoteId,
    sourceBudgetContextHash: 227n,
    approvedProviderRoot: providerRoot,
    categoryId: 7,
    networkId,
    treasuryController: CONTROLLER,
    amountAtomic: 500_000n,
    offerReferenceHash: Buffer.alloc(32, 7),
    providerSppPublicKey,
    claimDeadlineLedger: 5000,
    createdAtUnixMs: 1_700_000_000_000,
  });
  await issuer.confirmReservationOpen({ reservationId, transactionHash: Buffer.alloc(32, 8), ledgerSequence: 100 });
  await issuer.issueVoucher({
    reservationId,
    sequence: 1n,
    cumulativeAmountAtomic: 100_000n,
    usageRoot: 239n,
    expiryLedger: 4900,
  });
  const auditContextHash = 241n;
  const auditBlind = 251n;
  await store.transaction((state) => {
    state.auditAccumulators.push({
      sessionId: sessionId.toString("hex"),
      auditContextHash: auditContextHash.toString(),
      totalSpendAtomic: "0",
      blinding: auditBlind.toString(),
      commitment: poseidon2Hash3(auditContextHash, 0n, auditBlind, POSEIDON_DOMAINS.auditTotal).toString(),
      auditVersion: 1,
    });
  });
  const treasuryKeys = new TreasuryPrivacyKeyManager(store, new TestRandom());
  await treasuryKeys.createForSession({
    sessionId,
    auditContextHash,
    createdAtUnixMs: 1_700_000_000_001,
  });
  let aborted = false;
  let confirmed = false;
  const spp: SppPrivateTransferPlanner = {
    prepare: async ({ claimAmountAtomic, refundAmountAtomic, treasurySppPublicKey }) => {
      const providerBlind = 269n;
      const refundBlind = 271n;
      const sppProof: SppProof = {
        asp_membership_root: 277n,
        asp_non_membership_root: 281n,
        ext_data_hash: Buffer.alloc(32, 9),
        input_nullifiers: [283n],
        output_commitment0: poseidon2Hash3(claimAmountAtomic, providerSppPublicKey, providerBlind, POSEIDON_DOMAINS.sppNote) + (tamperSpp ? 1n : 0n),
        output_commitment1: poseidon2Hash3(refundAmountAtomic, treasurySppPublicKey, refundBlind, POSEIDON_DOMAINS.sppNote),
        proof,
        public_amount: 0n,
        root: 293n,
      };
      return {
        operationId: Buffer.alloc(32, 10),
        proof: sppProof,
        extData: { encrypted_output0: Buffer.alloc(96, 11), encrypted_output1: Buffer.alloc(96, 12), ext_amount: 0n, recipient: SPP_POOL },
        providerOutputBlinding: providerBlind,
        refundOutputBlinding: refundBlind,
      };
    },
    abort: async () => { aborted = true; },
    confirm: async () => { confirmed = true; },
  };
  const planner = new PrivateSettlementPlanner({
    store,
    proofWorker: mockWorker(),
    bindingArtifacts: { wasmPath: "test", zkeyPath: "test", verificationKeyPath: "test", publicInputCount: 16 },
    spp,
    sppDeployment: SPP_DEPLOYMENT,
    treasuryKeys,
    random,
  });
  return {
    directory, store, planner, reservationId, serviceIdHash, providerSppPublicKey,
    aborted: () => aborted,
    confirmed: () => confirmed,
  };
}

test("settlement planner binds voucher, SPP outputs, refund, and hidden audit update", async (context) => {
  const f = await fixture();
  context.after(async () => { f.store.close(); await rm(f.directory, { recursive: true, force: true }); });
  const prepared = await f.planner.prepare({
    reservationId: f.reservationId,
    provider: {
      providerIdentity: PROVIDER,
      providerSppPublicKey: f.providerSppPublicKey,
      providerSppEncryptionPublicKey: Buffer.alloc(32, 0x31),
      serviceIdHash: f.serviceIdHash,
      categoryId: 7,
      allowedSettlementModes: 2,
    },
  });
  assert.equal(prepared.input.spp_proof.public_amount, 0n);
  assert.equal(prepared.input.spp_ext_data.ext_amount, 0n);
  assert.equal("claim_amount" in prepared.input, false);
  const state = await f.store.readSnapshot();
  assert.equal(state.reservations[0]?.status, "SETTLEMENT_PENDING");
  assert.equal(state.reservations[0]?.preparedSettlement?.refundBudgetNote?.amountAtomic, "400000");
  assert.equal(state.reservations[0]?.preparedSettlement?.nextAudit.totalSpendAtomic, "100000");

  await f.planner.confirm({ operationId: prepared.operationId, transactionHash: Buffer.alloc(32, 13), ledgerSequence: 101 });
  const confirmed = await f.store.readSnapshot();
  assert.equal(f.confirmed(), true);
  assert.equal(confirmed.reservations[0]?.status, "SETTLED");
  assert.equal(confirmed.reservations[0]?.preparedSettlement, undefined);
  assert.equal(confirmed.reservations[0]?.settlementConfirmation?.ledgerSequence, 101);
  assert.equal(confirmed.auditAccumulators[0]?.totalSpendAtomic, "100000");
  assert.equal(confirmed.budgetNotes.find((note) => note.status === "ACTIVE")?.amountAtomic, "400000");
});

test("SPP output substitution aborts the private SPP operation and leaves reservation open", async (context) => {
  const f = await fixture(true);
  context.after(async () => { f.store.close(); await rm(f.directory, { recursive: true, force: true }); });
  await assert.rejects(f.planner.prepare({
    reservationId: f.reservationId,
    provider: {
      providerIdentity: PROVIDER,
      providerSppPublicKey: f.providerSppPublicKey,
      providerSppEncryptionPublicKey: Buffer.alloc(32, 0x32),
      serviceIdHash: f.serviceIdHash,
      categoryId: 7,
      allowedSettlementModes: 2,
    },
  }), /SPP proof outputs/u);
  assert.equal(f.aborted(), true);
  assert.equal((await f.store.readSnapshot()).reservations[0]?.status, "OPEN");
});

test("explicit abort returns a staged settlement to OPEN without advancing audit state", async (context) => {
  const f = await fixture();
  context.after(async () => { f.store.close(); await rm(f.directory, { recursive: true, force: true }); });
  const prepared = await f.planner.prepare({
    reservationId: f.reservationId,
    provider: {
      providerIdentity: PROVIDER,
      providerSppPublicKey: f.providerSppPublicKey,
      providerSppEncryptionPublicKey: Buffer.alloc(32, 0x33),
      serviceIdHash: f.serviceIdHash,
      categoryId: 7,
      allowedSettlementModes: 2,
    },
  });
  await f.planner.abort(prepared.operationId);
  const state = await f.store.readSnapshot();
  assert.equal(f.aborted(), true);
  assert.equal(state.reservations[0]?.status, "OPEN");
  assert.equal(state.auditAccumulators[0]?.totalSpendAtomic, "0");
  assert.equal(state.budgetNotes.some((note) => note.status === "ACTIVE"), false);
});
