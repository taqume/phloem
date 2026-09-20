import { randomBytes, createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const privateRoot = resolve(root, ".phloem");
const destination = resolve(privateRoot, "audit-total-spend-leq-setup");
const fixtureDestination = resolve(root, "contracts/audit-total-spend-leq-verifier/test-fixtures");
const circuit = resolve(root, "circuits/audit-total-spend-leq-v1/AuditTotalSpendLeqV1.circom");
const input = resolve(root, "circuits/audit-total-spend-leq-v1/input.v1.json");
const snarkjs = resolve(root, "node_modules/.bin/snarkjs");

async function firstExisting(candidates, label) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through deterministic local candidates.
    }
  }
  throw new Error(`${label} not found`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.quiet ? "pipe" : "inherit",
  });
  if (result.status !== 0) throw new Error(`${options.label ?? command} failed`);
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

await mkdir(privateRoot, { recursive: true, mode: 0o700 });
try {
  await access(destination);
  throw new Error(`refusing to replace existing setup: ${destination}`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const circom = await firstExisting([
  process.env.CIRCOM_BIN,
  resolve(root, ".phloem/toolchain/circom/bin/circom"),
  resolve(root, "../cp0-5-real-zk-validation/cp0-final/final-feasibility/upstream/circom/target/release/circom"),
], "Circom 2.2.3");
const ptau = await firstExisting([
  process.env.PHLOEM_PTAU_PATH,
  resolve(root, ".phloem/private-binding-setup/pot15_final.ptau"),
], "phase-2 prepared powers-of-tau file");
await access(snarkjs);

const temporary = await mkdtemp(resolve(privateRoot, "audit-total-spend-leq-setup.tmp-"));
try {
  run(circom, [circuit, "--r1cs", "--wasm", "--sym", "-l", resolve(root, "node_modules"), "-o", temporary]);
  const r1cs = resolve(temporary, "AuditTotalSpendLeqV1.r1cs");
  const wasm = resolve(temporary, "AuditTotalSpendLeqV1_js/AuditTotalSpendLeqV1.wasm");
  const initialZkey = resolve(temporary, "audit_total_spend_leq_0000.zkey");
  const finalZkey = resolve(temporary, "audit_total_spend_leq_final.zkey");
  const verificationKey = resolve(temporary, "verification_key.json");
  const proof = resolve(temporary, "proof.json");
  const publicSignals = resolve(temporary, "public.json");

  run(snarkjs, ["groth16", "setup", r1cs, ptau, initialZkey]);
  run(snarkjs, [
    "zkey",
    "contribute",
    initialZkey,
    finalZkey,
    "--name=Phloem AuditTotalSpendLeqV1 local development contribution",
    `-e=${randomBytes(64).toString("hex")}`,
  ], { quiet: true, label: "phase-2 contribution" });
  await unlink(initialZkey);
  run(snarkjs, ["zkey", "verify", r1cs, ptau, finalZkey]);
  run(snarkjs, ["zkey", "export", "verificationkey", finalZkey, verificationKey]);
  run(snarkjs, ["groth16", "fullprove", input, wasm, finalZkey, proof, publicSignals], {
    quiet: true,
    label: "TOTAL_SPEND_LEQ proof",
  });
  run(snarkjs, ["groth16", "verify", verificationKey, publicSignals, proof]);

  const manifest = {
    schemaVersion: 1,
    circuit: "AuditTotalSpendLeqV1",
    purpose: "LOCAL_TESTNET_DEVELOPMENT_ONLY",
    productionReady: false,
    setup: "single local phase-2 contributor; production requires a recorded multi-party ceremony",
    circomVersion: "2.2.3",
    snarkjsVersion: "0.7.6",
    publicInputCount: 7,
    constraints: 4750,
    artifacts: {
      circuitSha256: await sha256(circuit),
      r1csSha256: await sha256(r1cs),
      wasmSha256: await sha256(wasm),
      zkeySha256: await sha256(finalZkey),
      verificationKeySha256: await sha256(verificationKey),
      inputSha256: await sha256(input),
      proofSha256: await sha256(proof),
      publicSha256: await sha256(publicSignals),
    },
  };
  await writeFile(resolve(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await mkdir(fixtureDestination, { recursive: true });
  await writeFile(resolve(fixtureDestination, "verification_key.json"), await readFile(verificationKey));
  await writeFile(resolve(fixtureDestination, "proof.json"), await readFile(proof));
  await writeFile(resolve(fixtureDestination, "public.json"), await readFile(publicSignals));
  await rename(temporary, destination);
  process.stdout.write(`AuditTotalSpendLeqV1 local proving setup verified at ${destination}\n`);
} catch (error) {
  await rm(temporary, { recursive: true, force: true });
  throw error;
}
