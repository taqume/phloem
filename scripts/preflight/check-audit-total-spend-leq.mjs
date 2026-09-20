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
const circuit = resolve(root, "circuits/audit-total-spend-leq-v1/AuditTotalSpendLeqV1.circom");
const input = resolve(root, "circuits/audit-total-spend-leq-v1/input.v1.json");
const temporary = await mkdtemp(resolve(tmpdir(), "phloem-audit-total-spend-leq-"));

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
  const generator = resolve(temporary, "AuditTotalSpendLeqV1_js/generate_witness.js");
  const wasm = resolve(temporary, "AuditTotalSpendLeqV1_js/AuditTotalSpendLeqV1.wasm");
  run(process.execPath, [generator, wasm, input, resolve(temporary, "valid.wtns")]);

  const valid = JSON.parse(await readFile(input, "utf8"));
  const reject = async (name, mutated) => {
    const mutation = resolve(temporary, `${name}.json`);
    await writeFile(mutation, JSON.stringify(mutated));
    const result = spawnSync(
      process.execPath,
      [generator, wasm, mutation, resolve(temporary, `${name}.wtns`)],
      { cwd: root, encoding: "utf8" },
    );
    if (result.status === 0) throw new Error(`${name} mutation was accepted`);
  };

  await reject("threshold-below-total", { ...valid, thresholdAtomic: "399999" });
  await reject("wrong-opening", { ...valid, totalSpendAtomic: "399999" });
  await reject("wrong-snapshot", {
    ...valid,
    snapshotLow: (BigInt(valid.snapshotLow) + 1n).toString(),
  });
  await reject("wrong-audit-version", {
    ...valid,
    auditVersion: (BigInt(valid.auditVersion) + 1n).toString(),
  });
  await reject("wrong-statement", {
    ...valid,
    statementHash: (BigInt(valid.statementHash) + 1n).toString(),
  });
  process.stdout.write("AuditTotalSpendLeqV1: PASS; threshold/opening/snapshot/version mutations: REJECTED\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
