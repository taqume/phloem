import assert from "node:assert/strict";
import test from "node:test";

import {
  NativeSppDepositRuntimeBridge,
  PINNED_SPP_POOL,
  PINNED_SPP_SOURCE_REVISION,
  findSppFundingLeafIndex,
  type SppDepositBridgeProcess,
  type SppDepositConfirmationSource,
} from "./native-spp-deposit-bridge.js";

const COMPANY = "GBRFJEDXTYPKMZCQNXQV5LS63YBKRVNTQLE37GKKMQEO3TQ2N6HI4QUC";
const COMMITMENT = 211n;

function response(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    sourceRevision: PINNED_SPP_SOURCE_REVISION,
    network: "testnet",
    operationIdHex: "07".repeat(32),
    assetMovement: false,
    signed: false,
    submitted: false,
    proof: {
      aHex: "0a".repeat(64),
      bHex: "0b".repeat(128),
      cHex: "0c".repeat(64),
      root: "101",
      inputNullifiers: ["0", "0"],
      outputCommitment0: COMMITMENT.toString(),
      outputCommitment1: "223",
      publicAmount: "100000",
      extDataHashHex: "0d".repeat(32),
      aspMembershipRoot: "0",
      aspNonMembershipRoot: "0",
    },
    extData: {
      recipient: PINNED_SPP_POOL,
      extAmount: "100000",
      encryptedOutput0Hex: "0e".repeat(128),
      encryptedOutput1Hex: "0f".repeat(128),
    },
    fundingOutputBlinding: "227",
    safety: { storage: "ephemeral-memory-no-sqlite" },
    ...overrides,
  }));
}

function bridgeFixture(output = response()) {
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
      ledger: 501,
      events: [{
        type: "contract",
        contractId: PINNED_SPP_POOL,
        topics: ["new_commitment_event", COMMITMENT],
        data: { index: 17, encrypted_output: Buffer.alloc(128) },
      }],
    }),
  };
  return {
    bridge: new NativeSppDepositRuntimeBridge({ process, confirmationSource }),
    request: () => ({ body: requestBody, reference: requestReference }),
  };
}

function prepareInput() {
  return {
    sessionId: Buffer.alloc(32, 1),
    fundingSource: COMPANY,
    amountAtomic: 100_000n,
    treasurySppPublicKey: 229n,
    treasuryEncryptionPublicKey: Buffer.alloc(32, 2),
    poolContractId: PINNED_SPP_POOL,
    notePrivateKeyLe: Buffer.alloc(32, 3),
    notePublicKeyLe: Buffer.alloc(32, 4),
    encryptionPrivateKey: Buffer.alloc(32, 5),
    encryptionPublicKey: Buffer.alloc(32, 2),
    membershipBlindingLe: Buffer.alloc(32, 6),
  };
}

test("native deposit bridge parses pinned output and wipes its serialized secret request", async () => {
  const fixture = bridgeFixture();
  const prepared = await fixture.bridge.prepare(prepareInput());
  assert.equal(prepared.operationId.toString("hex"), "07".repeat(32));
  assert.equal(prepared.proof.output_commitment0, COMMITMENT);
  assert.equal(prepared.proof.public_amount, 100_000n);
  assert.equal(prepared.extData.encrypted_output0.length, 128);
  assert.equal(prepared.fundingOutputBlinding, 227n);
  const request = fixture.request();
  assert.equal(request.body?.notePrivateKeyLeHex, "03".repeat(32));
  assert.ok(request.reference?.equals(Buffer.alloc(request.reference.length)));
});

test("native deposit confirmation binds the expected commitment to the exact transaction event", async () => {
  const fixture = bridgeFixture();
  assert.deepEqual(
    await fixture.bridge.confirm(Buffer.alloc(32, 7), Buffer.alloc(32, 8), 501, COMMITMENT),
    { fundingLeafIndex: 17 },
  );
  assert.throws(
    () => findSppFundingLeafIndex([{
      type: "contract",
      contractId: PINNED_SPP_POOL,
      topics: ["new_commitment_event", COMMITMENT + 1n],
      data: { index: 17 },
    }], PINNED_SPP_POOL, COMMITMENT),
    /expected commitment event/u,
  );
});

test("native deposit bridge rejects unauthorized persistence and hidden submission state", async () => {
  for (const altered of [
    response({ safety: { storage: "sqlite" } }),
    response({ submitted: true }),
  ]) {
    const fixture = bridgeFixture(altered);
    await assert.rejects(fixture.bridge.prepare(prepareInput()), /storage mode|submitted state/u);
  }
});
