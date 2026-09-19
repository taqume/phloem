import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const generatedFiles = [
  "protocol/test-vectors/v1.json",
  "circuits/encoding-v1/input.v1.json",
];

function run(command, args, { quiet = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: quiet ? "pipe" : "inherit",
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
  return result;
}

async function digest(path) {
  return createHash("sha256").update(await readFile(resolve(root, path))).digest("hex");
}

for (const path of [
  "protocol/ENCODING.md",
  "protocol/SCHEMAS.md",
  "protocol/INTERFACES.md",
  "config/dependencies.lock.json",
  ...generatedFiles,
]) await readFile(resolve(root, path));

const before = Object.fromEntries(await Promise.all(generatedFiles.map(async (path) => [path, await digest(path)])));
run("pnpm", ["vectors:generate"]);
for (const path of generatedFiles) {
  if (before[path] !== await digest(path)) throw new Error(`${path} was stale before Phase 0 check`);
}

run("pnpm", ["typecheck"]);
run("pnpm", ["test"]);
run("rustup", ["run", "1.91.0", "cargo", "fmt", "--all", "--", "--check"]);
run("rustup", ["run", "1.91.0", "cargo", "test", "--workspace"]);
run(process.execPath, ["scripts/preflight/check-circom-vector.mjs"]);
run("git", ["check-ignore", "-q", "PHLOEM_MASTER_SPEC.md"], { quiet: true });
run("git", ["check-ignore", "-q", ".phloem/private-state.v1.enc"], { quiet: true });

process.stdout.write("Phase 0 protocol freeze checks: PASS\n");
