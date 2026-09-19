import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const historicalCircom = resolve(root, "../cp0-5-real-zk-validation/cp0-final/final-feasibility/upstream/circom/target/release/circom");
const localCircom = resolve(root, ".phloem/toolchain/circom/bin/circom");
async function executable(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next deterministic location.
    }
  }
  throw new Error("Circom 2.2.3 not found; run scripts/bootstrap/install-circom.sh or set CIRCOM_BIN");
}
const circom = await executable([process.env.CIRCOM_BIN, localCircom, historicalCircom]);
const circuit = resolve(root, "circuits/encoding-v1/EncodingVectorV1.circom");
const input = resolve(root, "circuits/encoding-v1/input.v1.json");
const temporary = await mkdtemp(resolve(tmpdir(), "phloem-circom-"));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    throw new Error(`${command} exited with ${result.status ?? "no status"}`);
  }
  return result;
}

try {
  run(circom, [circuit, "--r1cs", "--wasm", "--sym", "-l", resolve(root, "node_modules"), "-o", temporary]);
  const witnessGenerator = resolve(temporary, "EncodingVectorV1_js/generate_witness.js");
  const witnessWasm = resolve(temporary, "EncodingVectorV1_js/EncodingVectorV1.wasm");
  run(process.execPath, [witnessGenerator, witnessWasm, input, resolve(temporary, "encoding-vector-v1.wtns")]);

  const mutated = JSON.parse(await readFile(input, "utf8"));
  mutated.expectedContextHash = (BigInt(mutated.expectedContextHash) + 1n).toString();
  const badInput = resolve(temporary, "bad-input.json");
  await writeFile(badInput, JSON.stringify(mutated));
  const rejection = spawnSync(
    process.execPath,
    [witnessGenerator, witnessWasm, badInput, resolve(temporary, "bad.wtns")],
    { cwd: root, encoding: "utf8" },
  );
  if (rejection.status === 0) throw new Error("mutated expectedContextHash was accepted");
  process.stdout.write("Circom parity vector: PASS; one-field mutation: REJECTED\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
