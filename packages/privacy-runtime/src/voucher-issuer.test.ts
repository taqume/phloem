import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  addressFromStrKey,
  encodePrivateVoucher,
  encodeUsageEvidence,
  toHex,
  type UsageEvidence,
  type UsageEvidencePayload,
} from "@phloem/protocol-types";
import { Keypair } from "@stellar/stellar-sdk";

import { EncryptedPrivacyStateStore } from "./privacy-state-store.js";
import {
  p0UsageEvidenceRoot,
  PrivateReservationStateError,
  PrivateVoucherIssuer,
  type PrepareReservationOpeningInput,
  type PrivateRandomSource,
} from "./voucher-issuer.js";
import type { ReservationOpening } from "./state.js";

const NON_PRODUCTION_TEST_KEY = Buffer.alloc(32, 0x51);
const CONTROLLER = "CB23C2OYMIDYC7OG2PK6NJFIVCYONYV43ABREOGVTW2LT4C2G53G2CWU";
const SOURCE_OWNER = "CB2P6OWRQTMIDLN2XSD4PYSRP2P2U5TTR4VNCLEDKMXAQWN7CHWLHI27";
const ASSET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const PROVIDER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x31));
const SERVICE_ID_HASH = Buffer.alloc(32, 7);

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

function signedEvidence(opening: ReservationOpening, overrides: Partial<UsageEvidence> = {}): UsageEvidence {
  const evidence: UsageEvidence = {
    protocolVersion: 1,
    evidenceVersion: 1,
    networkId: opening.networkIdHex,
    treasuryController: opening.treasuryController,
    sessionId: opening.sessionId,
    reservationId: opening.reservationId,
    providerIdentity: PROVIDER.publicKey(),
    serviceIdHash: toHex(SERVICE_ID_HASH),
    categoryId: opening.categoryId,
    requestId: "21".repeat(32),
    requestHash: "22".repeat(32),
    responseHash: "23".repeat(32),
    usageUnits: "1",
    offerCommitment: opening.offerCommitment,
    providerSequence: "1",
    issuedAtLedger: 100,
    validUntilLedger: 200,
    evidenceNonce: "24".repeat(32),
    providerSignature: "00".repeat(64),
    ...overrides,
  };
  const payload: UsageEvidencePayload = {
    protocolVersion: evidence.protocolVersion,
    evidenceVersion: evidence.evidenceVersion,
    networkId: Buffer.from(evidence.networkId, "hex"),
    treasuryController: addressFromStrKey(evidence.treasuryController),
    sessionId: Buffer.from(evidence.sessionId, "hex"),
    reservationId: Buffer.from(evidence.reservationId, "hex"),
    providerIdentity: addressFromStrKey(evidence.providerIdentity),
    serviceIdHash: Buffer.from(evidence.serviceIdHash, "hex"),
    categoryId: evidence.categoryId,
    requestId: Buffer.from(evidence.requestId, "hex"),
    requestHash: Buffer.from(evidence.requestHash, "hex"),
    responseHash: Buffer.from(evidence.responseHash, "hex"),
    usageUnits: BigInt(evidence.usageUnits),
    offerCommitment: BigInt(evidence.offerCommitment),
    providerSequence: BigInt(evidence.providerSequence),
    issuedAtLedger: evidence.issuedAtLedger,
    validUntilLedger: evidence.validUntilLedger,
    evidenceNonce: Buffer.from(evidence.evidenceNonce, "hex"),
  };
  return { ...evidence, providerSignature: toHex(PROVIDER.sign(encodeUsageEvidence(payload))) };
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

test("one signed P0 UsageEvidence leaf is persisted and vouched atomically", async (context) => {
  const { directory, path, store, issuer } = await fixture();
  context.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const artifacts = await issuer.prepareReservation(preparation());
  await issuer.confirmReservationOpen({
    reservationId: artifacts.reservationId,
    transactionHash: Buffer.alloc(32, 15),
    ledgerSequence: 99,
  });
  const opening = (await store.readSnapshot()).reservations[0]!;
  const evidence = signedEvidence(opening);
  const accepted = await issuer.acceptP0UsageEvidence({
    signedUsageEvidence: evidence,
    policy: {
      providerIdentity: PROVIDER.publicKey(),
      serviceIdHash: SERVICE_ID_HASH,
      categoryId: opening.categoryId,
    },
    currentLedger: 110,
    acceptedAtUnixMs: 1_700_000_000_100,
  });
  const expected = p0UsageEvidenceRoot(evidence);
  assert.equal(toHex(accepted.evidenceHash), toHex(expected.evidenceHash));
  assert.equal(accepted.usageRoot, expected.usageRoot);
  assert.equal(accepted.voucher.sequence, 1n);

  const state = await store.readSnapshot();
  assert.equal(state.usageEvidence.length, 1);
  assert.equal(state.usageEvidence[0]!.usageRoot, expected.usageRoot.toString());
  assert.equal(state.reservations[0]!.latestVoucher!.cumulativeAmountAtomic, "500000");
  const rawEnvelope = await readFile(path, "utf8");
  assert.doesNotMatch(rawEnvelope, new RegExp(evidence.responseHash, "u"));
});

test("invalid or replayed UsageEvidence cannot mint another voucher", async (context) => {
  const { directory, store, issuer } = await fixture();
  context.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const artifacts = await issuer.prepareReservation(preparation());
  await issuer.confirmReservationOpen({
    reservationId: artifacts.reservationId,
    transactionHash: Buffer.alloc(32, 16),
    ledgerSequence: 99,
  });
  const opening = (await store.readSnapshot()).reservations[0]!;
  const evidence = signedEvidence(opening);
  const policy = {
    providerIdentity: PROVIDER.publicKey(),
    serviceIdHash: SERVICE_ID_HASH,
    categoryId: opening.categoryId,
  };
  await assert.rejects(issuer.acceptP0UsageEvidence({
    signedUsageEvidence: { ...evidence, responseHash: "ff".repeat(32) },
    policy,
    currentLedger: 110,
    acceptedAtUnixMs: 1_700_000_000_100,
  }), /signature is invalid/u);
  await issuer.acceptP0UsageEvidence({
    signedUsageEvidence: evidence,
    policy,
    currentLedger: 110,
    acceptedAtUnixMs: 1_700_000_000_100,
  });
  await assert.rejects(issuer.acceptP0UsageEvidence({
    signedUsageEvidence: evidence,
    policy,
    currentLedger: 111,
    acceptedAtUnixMs: 1_700_000_000_200,
  }), /replay is not allowed/u);
  assert.equal((await store.readSnapshot()).usageEvidence.length, 1);
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
