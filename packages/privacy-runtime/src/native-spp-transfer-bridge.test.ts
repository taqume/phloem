import assert from "node:assert/strict";
import test from "node:test";

import {
  PINNED_SPP_POOL,
  PINNED_SPP_SOURCE_REVISION,
  type SppDepositBridgeProcess,
  type SppDepositConfirmationSource,
} from "./native-spp-deposit-bridge.js";
import { NativeSppTransferRuntimeBridge } from "./native-spp-transfer-bridge.js";

const COMPANY = "GBRFJEDXTYPKMZCQNXQV5LS63YBKRVNTQLE37GKKMQEO3TQ2N6HI4QUC";
const PROVIDER_COMMITMENT = 307n;
const REFUND_COMMITMENT = 311n;

function response(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    sourceRevision: PINNED_SPP_SOURCE_REVISION,
    network: "testnet",
    operationIdHex: "17".repeat(32),
    inputNoteIdsHex: ["18".repeat(32)],
    assetMovement: false,
    signed: false,
    submitted: false,
    proof: {
      aHex: "1a".repeat(64),
      bHex: "1b".repeat(128),
      cHex: "1c".repeat(64),
      root: "301",
      inputNullifiers: ["303", "0"],
      outputCommitment0: PROVIDER_COMMITMENT.toString(),
      outputCommitment1: REFUND_COMMITMENT.toString(),
      publicAmount: "0",
      extDataHashHex: "1d".repeat(32),
      aspMembershipRoot: "0",
      aspNonMembershipRoot: "0",
    },
    extData: {
      recipient: PINNED_SPP_POOL,
      extAmount: "0",
      encryptedOutput0Hex: "1e".repeat(120),
      encryptedOutput1Hex: "1f".repeat(120),
    },
    providerOutputBlinding: "313",
    refundOutputBlinding: "317",
    safety: { storage: "ephemeral-memory-no-sqlite" },
    ...overrides,
  }));
}

function fixture(output = response()) {
  let requestReference: Buffer | undefined;
  let requestBody: Record<string, unknown> | undefined;
  const process: SppDepositBridgeProcess = {
    run: async (request) => {
      requestReference = request;
      requestBody = JSON.parse(request.toString("utf8")) as Record<string, unknown>;
      return Buffer.from(output);
    },
  };
  const confirmationSource: SppDepositConfirmationSource = {
    load: async () => ({
      status: "SUCCESS",
      ledger: 601,
      events: [
        {
          type: "contract",
          contractId: PINNED_SPP_POOL,
          topics: ["new_commitment_event", PROVIDER_COMMITMENT],
          data: { index: 20 },
        },
        {
          type: "contract",
          contractId: PINNED_SPP_POOL,
          topics: ["new_commitment_event", REFUND_COMMITMENT],
          data: { index: 21 },
        },
      ],
    }),
  };
  return {
    bridge: new NativeSppTransferRuntimeBridge({ process, simulationSource: COMPANY, confirmationSource }),
    request: () => ({ body: requestBody, reference: requestReference }),
  };
}

function prepareInput() {
  return {
    reservationId: Buffer.alloc(32, 0x10),
    sessionId: Buffer.alloc(32, 0x11),
    claimAmountAtomic: 100_000n,
    refundAmountAtomic: 400_000n,
    providerSppPublicKey: 1n,
    providerSppEncryptionPublicKey: Buffer.alloc(32, 0x12),
    treasurySppPublicKey: 2n,
    poolContractId: PINNED_SPP_POOL,
    availableNotes: [{
      noteId: "18".repeat(32),
      sessionId: "11".repeat(32),
      pool: PINNED_SPP_POOL,
      commitment: "19",
      amountAtomic: "500000",
      blinding: "23",
      leafIndex: 4,
      status: "ACTIVE" as const,
      confirmation: { transactionHash: "20".repeat(32), ledgerSequence: 500 },
      createdAtUnixMs: 1_700_000_000_000,
    }],
    notePrivateKeyLe: Buffer.alloc(32, 0x13),
    notePublicKeyLe: Buffer.alloc(32, 0x14),
    encryptionPrivateKey: Buffer.alloc(32, 0x15),
    encryptionPublicKey: Buffer.alloc(32, 0x16),
    membershipBlindingLe: Buffer.alloc(32, 0x17),
  };
}

test("native transfer bridge parses a zero-public-amount proof and wipes its request", async () => {
  const f = fixture();
  const prepared = await f.bridge.prepare(prepareInput());
  assert.equal(prepared.inputNoteIds[0]?.toString("hex"), "18".repeat(32));
  assert.equal(prepared.proof.output_commitment0, PROVIDER_COMMITMENT);
  assert.equal(prepared.proof.public_amount, 0n);
  assert.equal(prepared.providerOutputBlinding, 313n);
  assert.equal(prepared.refundOutputBlinding, 317n);
  const request = f.request();
  assert.equal(request.body?.providerNotePublicKeyLeHex, "01" + "00".repeat(31));
  assert.ok(request.reference?.equals(Buffer.alloc(request.reference.length)));
});

test("native transfer confirmation resolves both exact output events and only activates a real refund", async () => {
  const f = fixture();
  assert.deepEqual(await f.bridge.confirm(
    Buffer.alloc(32, 0x17),
    Buffer.alloc(32, 0x21),
    601,
    PROVIDER_COMMITMENT,
    REFUND_COMMITMENT,
    true,
  ), { refundLeafIndex: 21 });
  assert.deepEqual(await f.bridge.confirm(
    Buffer.alloc(32, 0x17),
    Buffer.alloc(32, 0x21),
    601,
    PROVIDER_COMMITMENT,
    REFUND_COMMITMENT,
    false,
  ), {});
});

test("native transfer bridge rejects unauthorized persistence or note selection", async () => {
  await assert.rejects(
    fixture(response({ safety: { storage: "sqlite" } })).bridge.prepare(prepareInput()),
    /storage mode/u,
  );
  await assert.rejects(
    fixture(response({ inputNoteIdsHex: ["99".repeat(32)] })).bridge.prepare(prepareInput()),
    /unauthorized treasury note/u,
  );
});
