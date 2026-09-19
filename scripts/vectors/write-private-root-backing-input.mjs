import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const vector = JSON.parse(await readFile(resolve(root, "protocol/test-vectors/v1.json"), "utf8"));
const signals = vector.expected.publicSignals.privateRootBackingV1;
const output = {
  rootContextHash: signals[0],
  rootBudgetCommitment: signals[1],
  auditContextHash: signals[2],
  initialAuditTotalCommitment: signals[3],
  treasurySppKeyCommitment: signals[4],
  sppFundingOutputCommitment: signals[5],
  fundingAmount: signals[6],
  rootBudgetBlind: vector.circom.budgetBlind,
  initialAuditBlind: vector.circom.initialAuditBlind,
  treasurySppPublicKey: vector.circom.treasurySppPublicKey,
  treasurySppKeyBlind: vector.circom.treasurySppKeyBlind,
  sppFundingOutputBlind: vector.circom.sppFundingOutputBlind,
};
const target = resolve(root, "circuits/private-root-backing-v1/input.v1.json");
const temporary = `${target}.tmp`;
await mkdir(dirname(target), { recursive: true });
await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
await rename(temporary, target);
process.stdout.write(`generated ${target}\n`);
