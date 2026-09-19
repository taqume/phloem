import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const localCircom = resolve(root, ".phloem/toolchain/circom/bin/circom");
const historicalCircom = resolve(
  root,
  "../cp0-5-real-zk-validation/cp0-final/final-feasibility/upstream/circom/target/release/circom",
);

async function executable(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error("Circom 2.2.3 not found; run scripts/bootstrap/install-circom.sh or set CIRCOM_BIN");
}

const circom = await executable([process.env.CIRCOM_BIN, localCircom, historicalCircom]);
const circuit = resolve(root, "circuits/private-root-backing-v1/PrivateRootBackingV1.circom");
const input = resolve(root, "circuits/private-root-backing-v1/input.v1.json");
const temporary = await mkdtemp(resolve(tmpdir(), "phloem-private-root-"));

function run(command, args, expectSuccess = true) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if ((result.status === 0) !== expectSuccess) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status ?? "no status"}\n${result.stdout || ""}\n${result.stderr || ""}`,
    );
  }
}

try {
  run(circom, [circuit, "--wasm", "--r1cs", "-l", resolve(root, "node_modules"), "-o", temporary]);
  const generator = resolve(temporary, "PrivateRootBackingV1_js/generate_witness.js");
  const wasm = resolve(temporary, "PrivateRootBackingV1_js/PrivateRootBackingV1.wasm");
  run(process.execPath, [generator, wasm, input, resolve(temporary, "valid.wtns")]);

  const valid = JSON.parse(await readFile(input, "utf8"));
  const reject = async (name, key) => {
    const mutated = { ...valid, [key]: (BigInt(valid[key]) + 1n).toString() };
    const path = resolve(temporary, `${name}.json`);
    await writeFile(path, JSON.stringify(mutated));
    run(process.execPath, [generator, wasm, path, resolve(temporary, `${name}.wtns`)], false);
  };

  await reject("overmint", "fundingAmount");
  await reject("wrong-root", "rootBudgetCommitment");
  await reject("wrong-key", "treasurySppKeyCommitment");
  await reject("wrong-spp-output", "sppFundingOutputCommitment");

  process.stdout.write("PrivateRootBackingV1 valid witness: PASS; overmint/root/key/SPP mutations: REJECTED\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
