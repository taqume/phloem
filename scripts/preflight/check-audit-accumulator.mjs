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
const circuit = resolve(root, "circuits/audit-accumulator-v1/AuditAccumulatorV1.circom");
const initInput = resolve(root, "circuits/audit-accumulator-v1/input-init.v1.json");
const updateInput = resolve(root, "circuits/audit-accumulator-v1/input-update.v1.json");
const temporary = await mkdtemp(resolve(tmpdir(), "phloem-audit-accumulator-"));

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
  const generator = resolve(temporary, "AuditAccumulatorV1_js/generate_witness.js");
  const wasm = resolve(temporary, "AuditAccumulatorV1_js/AuditAccumulatorV1.wasm");
  run(process.execPath, [generator, wasm, initInput, resolve(temporary, "init.wtns")]);
  run(process.execPath, [generator, wasm, updateInput, resolve(temporary, "update.wtns")]);

  const validUpdate = JSON.parse(await readFile(updateInput, "utf8"));
  const validInit = JSON.parse(await readFile(initInput, "utf8"));
  const reject = async (name, mutated) => {
    const input = resolve(temporary, `${name}.json`);
    await writeFile(input, JSON.stringify(mutated));
    const result = spawnSync(
      process.execPath,
      [generator, wasm, input, resolve(temporary, `${name}.wtns`)],
      { cwd: root, encoding: "utf8" },
    );
    if (result.status === 0) throw new Error(`${name} mutation was accepted`);
  };

  await reject("wrong-update-total", {
    ...validUpdate,
    newTotal: (BigInt(validUpdate.newTotal) + 1n).toString(),
  });
  await reject("wrong-context", {
    ...validUpdate,
    auditContextHash: (BigInt(validUpdate.auditContextHash) + 1n).toString(),
  });
  await reject("reused-blinding", {
    ...validUpdate,
    newBlinding: validUpdate.oldBlinding,
  });
  await reject("nonempty-init-prior-state", {
    ...validInit,
    oldTotal: "1",
  });
  process.stdout.write("AuditAccumulatorV1 INIT/UPDATE: PASS; total/context/freshness mutations: REJECTED\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
