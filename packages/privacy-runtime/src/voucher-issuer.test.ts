import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { encodePrivateVoucher, toHex } from "@phloem/protocol-types";
import { Keypair } from "@stellar/stellar-sdk";

import { EncryptedPrivacyStateStore } from "./privacy-state-store.js";
import {
  PrivateReservationStateError,
  PrivateVoucherIssuer,
  type PrepareReservationOpeningInput,
  type PrivateRandomSource,
} from "./voucher-issuer.js";

const NON_PRODUCTION_TEST_KEY = Buffer.alloc(32, 0x51);
const CONTROLLER = "CB23C2OYMIDYC7OG2PK6NJFIVCYONYV43ABREOGVTW2LT4C2G53G2CWU";
const SOURCE_OWNER = "CB2P6OWRQTMIDLN2XSD4PYSRP2P2U5TTR4VNCLEDKMXAQWN7CHWLHI27";
const ASSET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

class DeterministicNonProductionRandom implements PrivateRandomSource {
  #counter = 0;

  bytes(length: number): Uint8Array {
    assert.equal(length, 32);
    const digest = createHash("sha256")
      .update(`PHLOEM_NON_PRODUCTION_TEST_RANDOM:${this.#counter++}`, "utf8")
      .digest();
    digest[0] = 0;
    return digest;
  }
}

class ConstantNonProductionRandom implements PrivateRandomSource {
  bytes(length: number): Uint8Array {
    assert.equal(length, 32);
    return Buffer.alloc(32, 1);
  }
}

function preparation(overrides: Partial<PrepareReservationOpeningInput> = {}): PrepareReservationOpeningInput {
  return {
    reservationId: Buffer.alloc(32, 1),
    sessionId: Buffer.alloc(32, 2),
    sourceBudgetNoteId: Buffer.alloc(32, 3),
    sourceBudgetContextHash: 103n,
    approvedProviderRoot: 103n,
    categoryId: 7,
    networkId: Buffer.alloc(32, 4),
    treasuryController: CONTROLLER,
    amountAtomic: 500_000n,
    offerReferenceHash: Buffer.alloc(32, 5),
    providerSppPublicKey: 107n,
    claimDeadlineLedger: 5_000_000,
    createdAtUnixMs: 1_700_000_000_000,
    ...overrides,
  };
}

async function fixture(random: PrivateRandomSource = new DeterministicNonProductionRandom()) {
  const directory = await mkdtemp(join(tmpdir(), "phloem-voucher-test-"));
  const path = join(directory, "state.enc.json");
  const store = new EncryptedPrivacyStateStore(path, NON_PRODUCTION_TEST_KEY);
  await store.initialize();
  await store.transaction((state) => {
    state.budgetNotes.push({
      noteId: Buffer.alloc(32, 3).toString("hex"),
      sessionId: Buffer.alloc(32, 2).toString("hex"),
      nodeId: Buffer.alloc(32, 6).toString("hex"),
      owner: SOURCE_OWNER,
      asset: ASSET,
      policyHash: "101",
      contextHash: "103",
      commitment: "107",
      amountAtomic: "500000",
      blinding: "109",
      status: "ACTIVE",
    });
  });
  return { directory, path, store, issuer: new PrivateVoucherIssuer(store, random) };
}

test("reservation preparation persists one encrypted ephemeral payment key and returns only public artifacts", async (context) => {
  const { directory, path, store, issuer } = await fixture();
  context.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const artifacts = await issuer.prepareReservation(preparation());
  assert.deepEqual(Object.keys(artifacts).sort(), [
    "amountCommitment",
    "offerCommitment",
    "providerCommitment",
    "reservationContextHash",
    "reservationId",
    "voucherSignerPublicKey",
  ]);
  const state = await store.readSnapshot();
  const opening = state.reservations[0]!;
  assert.equal(opening.status, "PREPARED");
  assert.equal(state.budgetNotes[0]?.status, "SPEND_PENDING");
  assert.equal(state.budgetNotes[0]?.pendingOperationId, opening.reservationId);
  assert.equal(opening.voucherSignerPublicKeyHex, toHex(artifacts.voucherSignerPublicKey));
  assert.notEqual(opening.voucherSignerSeedHex, opening.voucherSignerPublicKeyHex);
  const rawEnvelope = await readFile(path, "utf8");
  assert.doesNotMatch(rawEnvelope, new RegExp(opening.voucherSignerSeedHex, "u"));
  assert.doesNotMatch(rawEnvelope, /500000/u);
});

test("an open reservation issues a canonical signed cumulative voucher without exposing its opening", async (context) => {
  const { directory, store, issuer } = await fixture();
  context.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const artifacts = await issuer.prepareReservation(preparation());
  await issuer.confirmReservationOpen({ reservationId: artifacts.reservationId, transactionHash: Buffer.alloc(32, 12), ledgerSequence: 100 });
  const issued = await issuer.issueVoucher({
    reservationId: artifacts.reservationId,
    sequence: 1n,
    cumulativeAmountAtomic: 100_000n,
    usageRoot: 109n,
    expiryLedger: 4_999_999,
  });

  assert.equal("cumulativeAmountAtomic" in issued.voucher, false);
  assert.equal("amountBlinding" in issued.voucher, false);
  assert.equal(issued.voucher.cumulativeAmountCommitment > 0n, true);
  const signer = Keypair.fromPublicKey(Keypair.fromRawEd25519Seed(
    Buffer.from((await store.readSnapshot()).reservations[0]!.voucherSignerSeedHex, "hex"),
  ).publicKey());
  assert.equal(signer.verify(encodePrivateVoucher(issued.voucher), issued.signature), true);

  const stored = (await store.readSnapshot()).reservations[0]!.latestVoucher!;
  assert.equal(stored.cumulativeAmountAtomic, "100000");
  assert.equal(stored.cumulativeAmountCommitment, issued.voucher.cumulativeAmountCommitment.toString());
});

test("voucher authority is bounded, monotonic, and reservation-specific", async (context) => {
  const { directory, store, issuer } = await fixture();
  context.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const artifacts = await issuer.prepareReservation(preparation());
  await issuer.confirmReservationOpen({ reservationId: artifacts.reservationId, transactionHash: Buffer.alloc(32, 13), ledgerSequence: 101 });
  await issuer.issueVoucher({
    reservationId: artifacts.reservationId,
    sequence: 1n,
    cumulativeAmountAtomic: 100_000n,
    usageRoot: 109n,
    expiryLedger: 4_999_999,
  });

  await assert.rejects(issuer.issueVoucher({
    reservationId: artifacts.reservationId,
    sequence: 1n,
    cumulativeAmountAtomic: 200_000n,
    usageRoot: 113n,
    expiryLedger: 4_999_999,
  }), /sequence must increase/u);
  await assert.rejects(issuer.issueVoucher({
    reservationId: artifacts.reservationId,
    sequence: 2n,
    cumulativeAmountAtomic: 600_000n,
    usageRoot: 113n,
    expiryLedger: 4_999_999,
  }), /exceeds reservation authority/u);
  assert.equal((await store.readSnapshot()).reservations[0]!.latestVoucher!.sequence, "1");
});

test("the same payment public key cannot be bound to two reservations", async (context) => {
  const { directory, store, issuer } = await fixture(new ConstantNonProductionRandom());
  context.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await issuer.prepareReservation(preparation());
  await assert.rejects(
    issuer.prepareReservation(preparation({ reservationId: Buffer.alloc(32, 9) })),
    PrivateReservationStateError,
  );
  assert.equal((await store.readSnapshot()).reservations.length, 1);
});

test("only unsubmitted prepared reservations can be discarded", async (context) => {
  const { directory, store, issuer } = await fixture();
  context.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const prepared = await issuer.prepareReservation(preparation());
  await issuer.discardPreparedReservation(prepared.reservationId);
  assert.deepEqual((await store.readSnapshot()).reservations, []);
  assert.equal((await store.readSnapshot()).budgetNotes[0]?.status, "ACTIVE");

  const next = await issuer.prepareReservation(preparation({ reservationId: Buffer.alloc(32, 8) }));
  await issuer.confirmReservationOpen({ reservationId: next.reservationId, transactionHash: Buffer.alloc(32, 14), ledgerSequence: 102 });
  await assert.rejects(issuer.discardPreparedReservation(next.reservationId), /only a prepared reservation/u);
});
