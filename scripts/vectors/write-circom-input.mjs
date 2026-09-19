import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const vector = JSON.parse(await readFile(resolve(root, "protocol/test-vectors/v1.json"), "utf8"));
const domains = vector.circom.domains;
const output = {
  contextFields: vector.circom.contextFields,
  providerLeafFields: vector.circom.providerLeafFields,
  offerCommitmentFields: vector.circom.offerCommitmentFields,
  auditContextFields: vector.circom.auditContextFields,
  budgetAmount: vector.circom.budgetAmount,
  budgetBlind: vector.circom.budgetBlind,
  initialAuditTotal: vector.circom.initialAuditTotal,
  initialAuditBlind: vector.circom.initialAuditBlind,
  oldAuditTotal: vector.circom.oldAuditTotal,
  oldAuditBlind: vector.circom.oldAuditBlind,
  newAuditTotal: vector.circom.newAuditTotal,
  newAuditBlind: vector.circom.newAuditBlind,
  contextInitDomain: domains.contextInit,
  contextFoldDomain: domains.contextFold,
  budgetNoteDomain: domains.budgetNote,
  providerInitDomain: domains.providerInit,
  providerFoldDomain: domains.providerFold,
  offerInitDomain: domains.offerInit,
  offerFoldDomain: domains.offerFold,
  auditContextInitDomain: domains.auditContextInit,
  auditContextFoldDomain: domains.auditContextFold,
  auditTotalDomain: domains.auditTotal,
  expectedContextHash: vector.expected.contextHash,
  expectedBudgetCommitment: vector.expected.budgetCommitment,
  expectedProviderLeaf: vector.expected.providerLeaf,
  expectedOfferCommitment: vector.expected.offerCommitment,
  expectedAuditContextHash: vector.expected.auditContextHash,
  expectedInitialAuditTotalCommitment: vector.expected.initialAuditTotalCommitment,
  expectedOldAuditTotalCommitment: vector.expected.oldAuditTotalCommitment,
  expectedNewAuditTotalCommitment: vector.expected.newAuditTotalCommitment,
};
const target = resolve(root, "circuits/encoding-v1/input.v1.json");
const temporary = `${target}.tmp`;
await mkdir(dirname(target), { recursive: true });
await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
await rename(temporary, target);
process.stdout.write(`generated ${target}\n`);
