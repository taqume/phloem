import assert from "node:assert/strict";
import test from "node:test";

import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  TransactionBuilder,
  authorizeInvocation,
  buildAuthorizationEntryPreimage,
  hash,
  inspectAuthEntry,
  xdr,
} from "@stellar/stellar-sdk";

import {
  StellarAgentAccountAuthorizer,
  agentAccountSigningDigest,
  encodeAgentAccountAuthPayload,
} from "./agent-account-authorizer.js";

const TREASURY = StrKey.encodeContract(Buffer.alloc(32, 1));
const AGENT = StrKey.encodeContract(Buffer.alloc(32, 2));
const VERIFIER = StrKey.encodeContract(Buffer.alloc(32, 3));
const SOURCE = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4)).publicKey();
const PUBLIC_KEY = Buffer.alloc(32, 7);
const SIGNATURE = Buffer.alloc(64, 1);
const METHOD = "delegate_private_budget";

const PINNED_AUTH_PAYLOAD_BASE64 = "AAAAEQAAAAEAAAACAAAADwAAABBjb250ZXh0X3J1bGVfaWRzAAAAEAAAAAEAAAABAAAAAwAAAAAAAAAPAAAAB3NpZ25lcnMAAAAAEQAAAAEAAAABAAAAEAAAAAEAAAADAAAADwAAAAhFeHRlcm5hbAAAABIAAAABAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMAAAANAAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHAAAADQAAAEABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB";

function invocation(): xdr.SorobanAuthorizedInvocation {
  const contractCall = new xdr.InvokeContractArgs({
    contractAddress: new Address(TREASURY).toScAddress(),
    functionName: METHOD,
    args: [],
  });
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(contractCall),
    subInvocations: [],
  });
}

test("AgentAccount AuthPayload encoding stays byte-identical to the pinned WASM contract types", () => {
  const encoded = encodeAgentAccountAuthPayload({
    ed25519VerifierId: VERIFIER,
    publicKey: PUBLIC_KEY,
    signature: SIGNATURE,
    contextCount: 1,
  });
  assert.equal(encoded.toXDR("base64"), PINNED_AUTH_PAYLOAD_BASE64);
});

test("authorizer binds rule zero, exact AgentAccount, controller call, and session expiry", async () => {
  const unsignedEntry = await authorizeInvocation({
    signer: async () => ({ signatureScVal: xdr.ScVal.scvVoid() }),
    validUntilLedgerSeq: 101,
    invocation: invocation(),
    networkPassphrase: Networks.TESTNET,
    publicKey: AGENT,
  });
  const transaction = new TransactionBuilder(new Account(SOURCE, "0"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.invokeContractFunction({
      contract: TREASURY,
      function: METHOD,
      args: [],
      auth: [unsignedEntry],
    }))
    .setSorobanData(new SorobanDataBuilder()
      .setResources(12_345, 678, 90)
      .setResourceFee("4321")
      .build())
    .setTimeout(300)
    .build();
  const originalExtension = transaction.toEnvelope().value.tx.ext;
  assert.equal(originalExtension.type, "sorobanData");
  let capturedDigest: Buffer | undefined;
  const authorizer = new StellarAgentAccountAuthorizer({
    networkPassphrase: Networks.TESTNET,
    treasuryControllerId: TREASURY,
    ed25519VerifierId: VERIFIER,
    latestLedger: async () => 100,
    authority: {
      resolveContract: async (contractId) => ({
        sessionId: "05".repeat(32),
        role: "SUPERVISOR",
        publicKeyHex: PUBLIC_KEY.toString("hex"),
        validUntilLedger: 150,
        status: "DEPLOYED",
        contractId,
        deploymentConfirmation: { transactionHash: "06".repeat(32), ledgerSequence: 99 },
      }),
      signForContract: async (contractId, digest) => {
        assert.equal(contractId, AGENT);
        capturedDigest = Buffer.from(digest);
        return { publicKeyHex: PUBLIC_KEY.toString("hex"), signature: SIGNATURE };
      },
    },
  });

  const signedXdr = await authorizer.authorize(JSON.stringify({ method: METHOD, tx: transaction.toXDR() }), {
    kind: "AGENT_SMART_ACCOUNT",
    identity: AGENT,
  });
  const signed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
  assert.ok(signed instanceof Transaction);
  const signedExtension = signed.toEnvelope().value.tx.ext;
  assert.equal(signedExtension.type, "sorobanData");
  assert.equal(signedExtension.value.toXdr("base64"), originalExtension.value.toXdr("base64"));
  assert.equal(signed.fee, transaction.fee);
  const operation = signed.operations[0];
  assert.equal(operation?.type, "invokeHostFunction");
  if (!operation || operation.type !== "invokeHostFunction") throw new Error("missing invoke operation");
  const entry = operation.auth?.[0];
  if (!entry) throw new Error("missing signed auth entry");
  const inspected = inspectAuthEntry(entry);
  assert.equal(inspected.address, AGENT);
  assert.equal(inspected.signatureExpirationLedger, 150);
  assert.equal(inspected.signers[0]?.rawSignature.toXDR("base64"), PINNED_AUTH_PAYLOAD_BASE64);

  const payload = hash(buildAuthorizationEntryPreimage(entry, 150, Networks.TESTNET).toXDR());
  assert.deepEqual(capturedDigest, agentAccountSigningDigest(payload, 1));
});

test("authorizer rejects a transaction whose required identity is absent", async () => {
  const anotherAgent = StrKey.encodeContract(Buffer.alloc(32, 9));
  const entry = await authorizeInvocation({
    signer: async () => ({ signatureScVal: xdr.ScVal.scvVoid() }),
    validUntilLedgerSeq: 101,
    invocation: invocation(),
    networkPassphrase: Networks.TESTNET,
    publicKey: anotherAgent,
  });
  const transaction = new TransactionBuilder(new Account(SOURCE, "0"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  }).addOperation(Operation.invokeContractFunction({
    contract: TREASURY,
    function: METHOD,
    args: [],
    auth: [entry],
  })).setTimeout(300).build();
  const authorizer = new StellarAgentAccountAuthorizer({
    networkPassphrase: Networks.TESTNET,
    treasuryControllerId: TREASURY,
    ed25519VerifierId: VERIFIER,
    latestLedger: async () => 100,
    authority: {
      resolveContract: async () => { throw new Error("must not resolve"); },
      signForContract: async () => { throw new Error("must not sign"); },
    },
  });
  await assert.rejects(
    authorizer.authorize(JSON.stringify({ method: METHOD, tx: transaction.toXDR() }), {
      kind: "AGENT_SMART_ACCOUNT",
      identity: AGENT,
    }),
    /one exact smart-account authorization/u,
  );
});
