import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { BN254_SCALAR_MODULUS } from "@phloem/protocol-types";
import type { Groth16Proof } from "@phloem/treasury-controller-client";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const BN254_BASE_FIELD_MODULUS =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

const decimalSchema = z.string().regex(/^(0|[1-9][0-9]*)$/u);
const snarkJsProofSchema = z.object({
  pi_a: z.tuple([decimalSchema, decimalSchema, decimalSchema]),
  pi_b: z.tuple([
    z.tuple([decimalSchema, decimalSchema]),
    z.tuple([decimalSchema, decimalSchema]),
    z.tuple([decimalSchema, decimalSchema]),
  ]),
  pi_c: z.tuple([decimalSchema, decimalSchema, decimalSchema]),
  protocol: z.literal("groth16"),
  curve: z.literal("bn128"),
}).strict();
const publicSignalsSchema = z.array(decimalSchema);

export type Groth16Witness = Readonly<Record<string, string | number | readonly (string | number)[]>>;

export interface Groth16ProvingArtifacts {
  readonly wasmPath: string;
  readonly zkeyPath: string;
  readonly verificationKeyPath: string;
  readonly publicInputCount: number;
}

export interface LocalProofResult {
  readonly proof: Groth16Proof;
  readonly publicSignals: readonly bigint[];
}

export class LocalProofGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalProofGenerationError";
  }
}

function coordinateBytes(value: string): Buffer {
  const coordinate = BigInt(value);
  if (coordinate < 0n || coordinate >= BN254_BASE_FIELD_MODULUS) {
    throw new LocalProofGenerationError("Groth16 proof contains a non-canonical BN254 coordinate");
  }
  return Buffer.from(coordinate.toString(16).padStart(64, "0"), "hex");
}

export function serializeSnarkJsProof(input: unknown): Groth16Proof {
  const proof = snarkJsProofSchema.parse(input);
  if (proof.pi_a[2] !== "1" || proof.pi_c[2] !== "1" || proof.pi_b[2][0] !== "1" || proof.pi_b[2][1] !== "0") {
    throw new LocalProofGenerationError("Groth16 proof points are not affine");
  }
  return {
    a: Buffer.concat([coordinateBytes(proof.pi_a[0]), coordinateBytes(proof.pi_a[1])]),
    // Soroban's BN254 host encoding is x.c1 || x.c0 || y.c1 || y.c0.
    b: Buffer.concat([
      coordinateBytes(proof.pi_b[0][1]),
      coordinateBytes(proof.pi_b[0][0]),
      coordinateBytes(proof.pi_b[1][1]),
      coordinateBytes(proof.pi_b[1][0]),
    ]),
    c: Buffer.concat([coordinateBytes(proof.pi_c[0]), coordinateBytes(proof.pi_c[1])]),
  };
}

function parsePublicSignals(input: unknown, expectedCount: number): readonly bigint[] {
  const values = publicSignalsSchema.parse(input);
  if (values.length !== expectedCount) {
    throw new LocalProofGenerationError("Groth16 prover returned an unexpected public-input count");
  }
  return values.map((value) => {
    const field = BigInt(value);
    if (field < 0n || field >= BN254_SCALAR_MODULUS) {
      throw new LocalProofGenerationError("Groth16 prover returned a non-canonical public input");
    }
    return field;
  });
}

function defaultSnarkJsCli(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("snarkjs")), "cli.cjs");
}

async function requireRegularFile(path: string, label: string): Promise<void> {
  const metadata = await lstat(path).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new LocalProofGenerationError(`${label} is missing or is not a regular file`);
  }
}

/**
 * Runs snarkjs locally. Raw witnesses are written only to a private temporary
 * directory and neither subprocess diagnostics nor witness values are exposed.
 */
export class LocalGroth16ProofWorker {
  readonly #snarkJsCli: string;
  readonly #temporaryRoot: string;

  constructor(options: { readonly snarkJsCli?: string; readonly temporaryRoot?: string } = {}) {
    this.#snarkJsCli = options.snarkJsCli ?? defaultSnarkJsCli();
    this.#temporaryRoot = options.temporaryRoot ?? tmpdir();
  }

  async prove(witness: Groth16Witness, artifacts: Groth16ProvingArtifacts): Promise<LocalProofResult> {
    if (!Number.isSafeInteger(artifacts.publicInputCount) || artifacts.publicInputCount <= 0) {
      throw new RangeError("public input count must be a positive integer");
    }
    await Promise.all([
      requireRegularFile(this.#snarkJsCli, "snarkjs CLI"),
      requireRegularFile(artifacts.wasmPath, "circuit Wasm"),
      requireRegularFile(artifacts.zkeyPath, "Groth16 proving key"),
      requireRegularFile(artifacts.verificationKeyPath, "Groth16 verification key"),
    ]);

    const temporary = await mkdtemp(join(this.#temporaryRoot, "phloem-local-proof-"));
    await chmod(temporary, PRIVATE_DIRECTORY_MODE);
    const witnessPath = join(temporary, "witness-input.json");
    const proofPath = join(temporary, "proof.json");
    const publicPath = join(temporary, "public.json");
    try {
      await writeFile(witnessPath, JSON.stringify(witness), { encoding: "utf8", mode: PRIVATE_FILE_MODE });
      try {
        await execFileAsync(
          process.execPath,
          [
            this.#snarkJsCli,
            "groth16",
            "fullprove",
            witnessPath,
            artifacts.wasmPath,
            artifacts.zkeyPath,
            proofPath,
            publicPath,
          ],
          { windowsHide: true, maxBuffer: 1024 * 1024 },
        );
        const verification = await execFileAsync(
          process.execPath,
          [this.#snarkJsCli, "groth16", "verify", artifacts.verificationKeyPath, publicPath, proofPath],
          { windowsHide: true, maxBuffer: 1024 * 1024 },
        );
        if (!verification.stdout.includes("OK!")) {
          throw new LocalProofGenerationError("local Groth16 proof verification rejected the generated proof");
        }
      } catch {
        throw new LocalProofGenerationError("local Groth16 proof generation failed");
      }
      const [proofJson, publicJson] = await Promise.all([
        readFile(proofPath, "utf8"),
        readFile(publicPath, "utf8"),
      ]);
      return {
        proof: serializeSnarkJsProof(JSON.parse(proofJson) as unknown),
        publicSignals: parsePublicSignals(JSON.parse(publicJson) as unknown, artifacts.publicInputCount),
      };
    } catch (error: unknown) {
      if (error instanceof LocalProofGenerationError) throw error;
      throw new LocalProofGenerationError("local Groth16 proof output could not be decoded");
    } finally {
      await writeFile(witnessPath, "", { mode: PRIVATE_FILE_MODE }).catch(() => undefined);
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
