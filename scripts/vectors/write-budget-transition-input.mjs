import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const vector = JSON.parse(await readFile(resolve(root, "protocol/test-vectors/v1.json"), "utf8"));
const signals = vector.expected.publicSignals.budgetTransitionV1;
const output = {
  inputContextHash: signals[0],
  inputCommitment: signals[1],
  output1ContextHash: signals[2],
  output1Commitment: signals[3],
  output1Kind: signals[4],
  output2ContextHash: signals[5],
  output2Commitment: signals[6],
  output2Kind: signals[7],
  inputAmount: vector.circom.budgetAmount,
  inputBlinding: vector.circom.budgetBlind,
  output1Amount: vector.circom.transitionOutput1Amount,
  output1Blinding: vector.circom.transitionOutput1Blind,
  output2Amount: vector.circom.transitionOutput2Amount,
  output2Blinding: vector.circom.transitionOutput2Blind,
};
const target = resolve(root, "circuits/budget-transition-v1/input.v1.json");
const temporary = `${target}.tmp`;
await mkdir(dirname(target), { recursive: true });
await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
await rename(temporary, target);
process.stdout.write(`generated ${target}\n`);
