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
  rpc,
  xdr,
} from "@stellar/stellar-sdk";

import { RpcTransactionResourceAssembler } from "./stellar-submission.js";

const TREASURY = StrKey.encodeContract(Buffer.alloc(32, 11));
const AGENT = StrKey.encodeContract(Buffer.alloc(32, 12));
const SOURCE = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 13)).publicKey();
const METHOD = "delegate_private_budget";

function invocation(): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(TREASURY).toScAddress(),
        functionName: METHOD,
        args: [],
      }),
    ),
    subInvocations: [],
  });
}

test("resource assembly preserves signed AgentAccount auth and replaces only simulation resources", async () => {
  const authEntry = await authorizeInvocation({
    signer: async () => ({ signatureScVal: xdr.ScVal.scvBytes(Buffer.alloc(64, 7)) }),
    validUntilLedgerSeq: 200,
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
      auth: [authEntry],
    }))
    .setSorobanData(new SorobanDataBuilder()
      .setResources(100, 10, 20)
      .setResourceFee("123")
      .build())
    .setTimeout(300)
    .build();
  const nextData = new SorobanDataBuilder()
    .setResources(50_000, 400, 500)
    .setResourceFee("4321");
  const simulation = {
    _parsed: true as const,
    id: "simulation-id",
    latestLedger: 100,
    events: [],
    minResourceFee: "4321",
    transactionData: nextData,
    cost: { cpuInsns: "50000", memBytes: "500" },
    result: { auth: [], retval: xdr.ScVal.scvVoid() },
  } as Awaited<ReturnType<rpc.Server["simulateTransaction"]>>;
  let simulatedAuth = "";
  const assembler = new RpcTransactionResourceAssembler({
    server: {
      simulateTransaction: async (input) => {
        const operation = input.operations[0];
        if (!operation || operation.type !== "invokeHostFunction") throw new Error("missing invoke operation");
        simulatedAuth = operation.auth?.[0]?.toXDR("base64") ?? "";
        return simulation;
      },
    },
    networkPassphrase: Networks.TESTNET,
    sourcePublicKey: SOURCE,
    treasuryControllerId: TREASURY,
  });

  const assembledXdr = await assembler.assemble(transaction.toXDR());
  const assembled = TransactionBuilder.fromXDR(assembledXdr, Networks.TESTNET);
  assert.ok(assembled instanceof Transaction);
  const operation = assembled.operations[0];
  assert.equal(operation?.type, "invokeHostFunction");
  if (!operation || operation.type !== "invokeHostFunction") throw new Error("missing invoke operation");
  assert.equal(simulatedAuth, authEntry.toXDR("base64"));
  assert.equal(operation.auth?.[0]?.toXDR("base64"), authEntry.toXDR("base64"));
  assert.equal(assembled.signatures.length, 0);
  assert.equal(assembled.fee, "4421");
  const extension = assembled.toEnvelope().value.tx.ext;
  assert.equal(extension.type, "sorobanData");
  assert.equal(extension.value.toXDR("base64"), nextData.build().toXDR("base64"));
});
