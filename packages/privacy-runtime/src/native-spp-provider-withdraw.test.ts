import assert from "node:assert/strict";
import test from "node:test";

import { BN254_SCALAR_MODULUS } from "@phloem/protocol-types";

import {
  PINNED_SPP_NETWORK,
  PINNED_SPP_SOURCE_REVISION,
  type SppDepositBridgeProcess,
} from "./native-spp-deposit-bridge.js";
import { NativeSppProviderWithdrawBridge } from "./native-spp-provider-withdraw.js";

const SOURCE = "GBRFJEDXTYPKMZCQNXQV5LS63YBKRVNTQLE37GKKMQEO3TQ2N6HI4QUC";
const RECIPIENT = "GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6";
const AMOUNT = 100_000n;

function response(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    sourceRevision: PINNED_SPP_SOURCE_REVISION,
    network: PINNED_SPP_NETWORK,
    operationIdHex: "11".repeat(32),
    inputNoteIdsHex: ["12".repeat(32)],
    assetMovement: true,
    signed: false,
    submitted: false,
    unsignedTransactionXdr: "AA==",
    proof: {
      inputNullifiers: ["13", "0"],
      outputCommitment0: "17",
      outputCommitment1: "19",
      publicAmount: (BN254_SCALAR_MODULUS - AMOUNT).toString(),
    },
    extData: {
      recipient: RECIPIENT,
      extAmount: (-AMOUNT).toString(),
      encryptedOutput0Hex: "00",
      encryptedOutput1Hex: "00",
    },
    resource: {
      authEntries: 0,
      diskReadBytes: 100,
      envelopeBytes: 200,
      footprintReadOnlyEntries: 3,
      footprintReadWriteEntries: 4,
      instructions: 500,
      latestLedger: 600,
      resourceFeeStroops: "700",
      totalFeeStroops: "800",
      writeBytes: 900,
    },
    safety: { storage: "ephemeral-memory-no-sqlite", fullPublicExit: true },
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
  return {
    bridge: new NativeSppProviderWithdrawBridge({ process, simulationSource: SOURCE }),
    request: () => ({ body: requestBody, reference: requestReference }),
  };
}

function input() {
  return {
    sessionId: Buffer.alloc(32, 0x21),
    reservationId: Buffer.alloc(32, 0x22),
    settlementTransactionHash: Buffer.alloc(32, 0x23),
    settlementLedger: 4_770_684,
    expectedProviderOutputCommitment: 307n,
    withdrawalRecipient: RECIPIENT,
    notePrivateKeyLe: Buffer.alloc(32, 0x24),
    notePublicKeyLe: Buffer.alloc(32, 0x25),
    encryptionPrivateKey: Buffer.alloc(32, 0x26),
    encryptionPublicKey: Buffer.alloc(32, 0x27),
    membershipBlindingLe: Buffer.alloc(32, 0x28),
  };
}

test("provider withdrawal recovers one encrypted note and returns only an unsigned full public exit", async () => {
  const f = fixture();
  const prepared = await f.bridge.prepare(input());
  assert.equal(prepared.withdrawalAmountAtomic, AMOUNT);
  assert.equal(prepared.publicAmountField, BN254_SCALAR_MODULUS - AMOUNT);
  assert.equal(prepared.inputNoteId.toString("hex"), "12".repeat(32));
  assert.equal(prepared.resource.instructions, 500);
  const request = f.request();
  assert.equal(request.body?.command, "prepare_provider_withdraw");
  assert.equal(request.body?.withdrawalRecipient, RECIPIENT);
  assert.equal(
    request.body?.expectedProviderOutputCommitment,
    "0x0000000000000000000000000000000000000000000000000000000000000133",
  );
  assert.ok(request.reference?.equals(Buffer.alloc(request.reference.length)));
});

test("provider withdrawal rejects a non-full exit, wrong recipient, or a bridge-side submission", async () => {
  await assert.rejects(
    fixture(response({
      safety: { storage: "ephemeral-memory-no-sqlite", fullPublicExit: false },
    })).bridge.prepare(input()),
    /full public exit/u,
  );
  await assert.rejects(
    fixture(response({
      extData: {
        recipient: SOURCE,
        extAmount: (-AMOUNT).toString(),
        encryptedOutput0Hex: "00",
        encryptedOutput1Hex: "00",
      },
    })).bridge.prepare(input()),
    /recipient/u,
  );
  await assert.rejects(
    fixture(response({ submitted: true })).bridge.prepare(input()),
    /unsafe execution state/u,
  );
});
