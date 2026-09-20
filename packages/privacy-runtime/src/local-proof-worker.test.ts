import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LocalGroth16ProofWorker,
  LocalProofGenerationError,
  serializeSnarkJsProof,
} from "./local-proof-worker.js";

const FIXTURE_PROOF = resolve(
  fileURLToPath(new URL("../../../contracts/budget-transition-verifier/test-fixtures/proof.json", import.meta.url)),
);
const FIXTURE_PUBLIC = resolve(
  fileURLToPath(new URL("../../../contracts/budget-transition-verifier/test-fixtures/public.json", import.meta.url)),
);

test("snarkjs affine points serialize to exact Soroban BN254 byte layout", async () => {
  const json = JSON.parse(await readFile(FIXTURE_PROOF, "utf8")) as {
    pi_a: [string, string, string];
    pi_b: [[string, string], [string, string], [string, string]];
    pi_c: [string, string, string];
  };
  const serialized = serializeSnarkJsProof(json);
  assert.equal(serialized.a.length, 64);
  assert.equal(serialized.b.length, 128);
  assert.equal(serialized.c.length, 64);
  assert.equal(serialized.a.subarray(0, 32).toString("hex"), BigInt(json.pi_a[0]).toString(16).padStart(64, "0"));
  assert.equal(serialized.b.subarray(0, 32).toString("hex"), BigInt(json.pi_b[0][1]).toString(16).padStart(64, "0"));
  assert.equal(serialized.b.subarray(32, 64).toString("hex"), BigInt(json.pi_b[0][0]).toString(16).padStart(64, "0"));
});

test("non-affine or non-canonical proof points fail closed", async () => {
  const json = JSON.parse(await readFile(FIXTURE_PROOF, "utf8")) as Record<string, unknown>;
  await assert.rejects(async () => serializeSnarkJsProof({ ...json, pi_a: ["1", "2", "0"] }), LocalProofGenerationError);
  await assert.rejects(
    async () => serializeSnarkJsProof({
      ...json,
      pi_a: [
        "21888242871839275222246405745257275088696311157297823662689037894645226208583",
        "2",
        "1",
      ],
    }),
    LocalProofGenerationError,
  );
});

test("worker redacts subprocess diagnostics and removes raw witness files on failure", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "phloem-proof-worker-test-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const fakeCli = join(directory, "fake-cli.cjs");
  const fakeWasm = join(directory, "circuit.wasm");
  const fakeZkey = join(directory, "circuit.zkey");
  const fakeVerificationKey = join(directory, "verification-key.json");
  await Promise.all([
    writeFile(fakeCli, "process.stderr.write('SECRET_WITNESS_SENTINEL'); process.exit(1);\n", { mode: 0o600 }),
    writeFile(fakeWasm, "fixture", { mode: 0o600 }),
    writeFile(fakeZkey, "fixture", { mode: 0o600 }),
    writeFile(fakeVerificationKey, "fixture", { mode: 0o600 }),
  ]);

  const worker = new LocalGroth16ProofWorker({ snarkJsCli: fakeCli, temporaryRoot: directory });
  await assert.rejects(
    worker.prove(
      { privateAmount: "SECRET_WITNESS_SENTINEL" },
      {
        wasmPath: fakeWasm,
        zkeyPath: fakeZkey,
        verificationKeyPath: fakeVerificationKey,
        publicInputCount: 8,
      },
    ),
    (error: unknown) => {
      assert.equal(error instanceof LocalProofGenerationError, true);
      assert.doesNotMatch((error as Error).message, /SECRET_WITNESS_SENTINEL/u);
      return true;
    },
  );
  const remaining = await import("node:fs/promises").then(({ readdir }) => readdir(directory));
  assert.equal(remaining.some((name) => name.startsWith("phloem-local-proof-")), false);
});

test("worker rejects a verifier that exits zero without reporting OK", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "phloem-proof-worker-verifier-test-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const fakeCli = join(directory, "fake-cli.cjs");
  const fakeWasm = join(directory, "circuit.wasm");
  const fakeZkey = join(directory, "circuit.zkey");
  const fakeVerificationKey = join(directory, "verification-key.json");
  const [proof, publicSignals] = await Promise.all([
    readFile(FIXTURE_PROOF, "utf8"),
    readFile(FIXTURE_PUBLIC, "utf8"),
  ]);
  await Promise.all([
    writeFile(fakeCli, [
      "const { writeFileSync } = require('node:fs');",
      `const proof = ${JSON.stringify(proof)};`,
      `const publicSignals = ${JSON.stringify(publicSignals)};`,
      "if (process.argv[3] === 'fullprove') {",
      "  writeFileSync(process.argv[7], proof);",
      "  writeFileSync(process.argv[8], publicSignals);",
      "} else { process.stdout.write('Invalid proof'); }",
    ].join("\n"), { mode: 0o600 }),
    writeFile(fakeWasm, "fixture", { mode: 0o600 }),
    writeFile(fakeZkey, "fixture", { mode: 0o600 }),
    writeFile(fakeVerificationKey, "fixture", { mode: 0o600 }),
  ]);

  const worker = new LocalGroth16ProofWorker({ snarkJsCli: fakeCli, temporaryRoot: directory });
  await assert.rejects(
    worker.prove(
      { privateAmount: "1" },
      {
        wasmPath: fakeWasm,
        zkeyPath: fakeZkey,
        verificationKeyPath: fakeVerificationKey,
        publicInputCount: 8,
      },
    ),
    LocalProofGenerationError,
  );
});
