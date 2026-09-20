import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Keypair, StrKey } from "@stellar/stellar-sdk";

import { AgentIdentityVault } from "./agent-identity-vault.js";
import { EncryptedPrivacyStateStore } from "./privacy-state-store.js";

const STORE_KEY = Buffer.alloc(32, 0x51);
const AGENT_SEED = Buffer.alloc(32, 0x52);
const SESSION_ID = "53".repeat(32);
const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M";
const OTHER_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 2));

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "phloem-agent-identity-test-"));
  const path = join(directory, "private-state.enc");
  const store = new EncryptedPrivacyStateStore(path, STORE_KEY);
  await store.initialize();
  const vault = new AgentIdentityVault(store, () => Buffer.from(AGENT_SEED));
  return { directory, path, store, vault };
}

test("agent seeds stay encrypted and identity preparation is idempotent", async (context) => {
  const { directory, path, store, vault } = await fixture();
  context.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const first = await vault.prepare({
    sessionId: SESSION_ID,
    role: "RESEARCH",
    validUntilLedger: 50_000,
    createdAtUnixMs: 1_000,
  });
  const again = await vault.prepare({
    sessionId: SESSION_ID,
    role: "RESEARCH",
    validUntilLedger: 50_000,
    createdAtUnixMs: 2_000,
  });

  assert.deepEqual(again, first);
  assert.equal((await store.readSnapshot()).agentIdentities.length, 1);
  const serialized = await readFile(path, "utf8");
  assert.doesNotMatch(serialized, new RegExp(AGENT_SEED.toString("hex"), "u"));
  assert.equal("seedHex" in first, false);
});

test("only a confirmed deployed identity can sign for its exact contract", async (context) => {
  const { directory, store, vault } = await fixture();
  context.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  await vault.prepare({ sessionId: SESSION_ID, role: "SUPERVISOR", validUntilLedger: 60_000 });
  await assert.rejects(vault.signForContract(CONTRACT_ID, Buffer.alloc(32, 1)), /no deployed encrypted agent/u);
  const deployed = await vault.confirmDeployment({
    sessionId: SESSION_ID,
    role: "SUPERVISOR",
    contractId: CONTRACT_ID,
    confirmation: { transactionHash: "54".repeat(32), ledgerSequence: 12_345 },
  });
  assert.equal(deployed.contractId, CONTRACT_ID);

  const digest = Buffer.alloc(32, 0x55);
  const signed = await vault.signForContract(CONTRACT_ID, digest);
  assert.equal(signed.publicKeyHex, Buffer.from(Keypair.fromRawEd25519Seed(AGENT_SEED).rawPublicKey()).toString("hex"));
  assert.equal(Keypair.fromRawEd25519Seed(AGENT_SEED).verify(digest, signed.signature), true);
  await assert.rejects(
    vault.signForContract(OTHER_CONTRACT_ID, digest),
    /no deployed encrypted agent/u,
  );
});
