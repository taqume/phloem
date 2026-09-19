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
  budgetAmount: vector.circom.budgetAmount,
  budgetBlind: vector.circom.budgetBlind,
  contextInitDomain: domains.contextInit,
  contextFoldDomain: domains.contextFold,
  budgetNoteDomain: domains.budgetNote,
  providerInitDomain: domains.providerInit,
  providerFoldDomain: domains.providerFold,
  offerInitDomain: domains.offerInit,
  offerFoldDomain: domains.offerFold,
  expectedContextHash: vector.expected.contextHash,
  expectedBudgetCommitment: vector.expected.budgetCommitment,
  expectedProviderLeaf: vector.expected.providerLeaf,
  expectedOfferCommitment: vector.expected.offerCommitment,
};
const target = resolve(root, "circuits/encoding-v1/input.v1.json");
const temporary = `${target}.tmp`;
await mkdir(dirname(target), { recursive: true });
await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
await rename(temporary, target);
process.stdout.write(`generated ${target}\n`);
