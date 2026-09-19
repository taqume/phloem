import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const vector = JSON.parse(await readFile(resolve(root, "protocol/test-vectors/v1.json"), "utf8"));

const inputs = [
  ["input-init.v1.json", {
    auditContextHash: vector.expected.publicSignals.auditAccumulatorInitV1[0],
    transitionKind: "0",
    oldCommitment: "0",
    newCommitment: vector.expected.initialAuditTotalCommitment,
    settledAmount: "0",
    oldTotal: "0",
    oldBlinding: "0",
    newTotal: vector.circom.initialAuditTotal,
    newBlinding: vector.circom.initialAuditBlind,
  }],
  ["input-update.v1.json", {
    auditContextHash: vector.expected.publicSignals.auditAccumulatorUpdateV1[0],
    transitionKind: "1",
    oldCommitment: vector.expected.oldAuditTotalCommitment,
    newCommitment: vector.expected.newAuditTotalCommitment,
    settledAmount: vector.fixture.values.claimAmount,
    oldTotal: vector.circom.oldAuditTotal,
    oldBlinding: vector.circom.oldAuditBlind,
    newTotal: vector.circom.newAuditTotal,
    newBlinding: vector.circom.newAuditBlind,
  }],
];

for (const [name, input] of inputs) {
  const target = resolve(root, "circuits/audit-accumulator-v1", name);
  const temporary = `${target}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(input, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
  await rename(temporary, target);
  process.stdout.write(`generated ${target}\n`);
}
