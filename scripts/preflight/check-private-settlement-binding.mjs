import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { bn254 } from "@taceo/poseidon2";

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
const circuit = resolve(root, "circuits/private-settlement-binding-v1/PrivateSettlementBindingV1.circom");
const input = resolve(root, "circuits/private-settlement-binding-v1/input.v1.json");
const temporary = await mkdtemp(resolve(tmpdir(), "phloem-private-binding-"));

function run(command, args, expectSuccess = true) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if ((result.status === 0) !== expectSuccess) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status ?? "no status"}\n${result.stdout || ""}\n${result.stderr || ""}`,
    );
  }
}

function hash3(a, b, c, domain) {
  return bn254.t4.permutation([BigInt(a), BigInt(b), BigInt(c), BigInt(domain)])[0].toString();
}

try {
  run(circom, [circuit, "--wasm", "--r1cs", "-l", resolve(root, "node_modules"), "-o", temporary]);
  const generator = resolve(temporary, "PrivateSettlementBindingV1_js/generate_witness.js");
  const wasm = resolve(temporary, "PrivateSettlementBindingV1_js/PrivateSettlementBindingV1.wasm");
  run(process.execPath, [generator, wasm, input, resolve(temporary, "valid.wtns")]);

  const valid = JSON.parse(await readFile(input, "utf8"));
  const reject = async (name, mutated) => {
    const path = resolve(temporary, `${name}.json`);
    await writeFile(path, JSON.stringify(mutated));
    run(process.execPath, [generator, wasm, path, resolve(temporary, `${name}.wtns`)], false);
  };

  await reject("overclaim", {
    ...valid,
    claimAmount: (BigInt(valid.reservationAmount) + 1n).toString(),
  });
  const wrongProvider = structuredClone(valid);
  wrongProvider.providerLeafFields[4] = (BigInt(wrongProvider.providerLeafFields[4]) + 1n).toString();
  await reject("wrong-provider", wrongProvider);
  await reject("wrong-spp-output", {
    ...valid,
    providerSppOutputCommitment: (BigInt(valid.providerSppOutputCommitment) + 1n).toString(),
  });
  await reject("wrong-treasury-remainder", {
    ...valid,
    treasurySppPublicKey: (BigInt(valid.treasurySppPublicKey) + 1n).toString(),
  });
  await reject("wrong-voucher-key", {
    ...valid,
    voucherSignerPublicKeyFields: [
      (BigInt(valid.voucherSignerPublicKeyFields[0]) + 1n).toString(),
      valid.voucherSignerPublicKeyFields[1],
    ],
  });
  await reject("wrong-audit-total", {
    ...valid,
    newAuditTotal: (BigInt(valid.newAuditTotal) + 1n).toString(),
  });

  const vector = JSON.parse(await readFile(resolve(root, "protocol/test-vectors/v1.json"), "utf8"));
  const domains = vector.circom.domains;
  const exactClaim = structuredClone(valid);
  exactClaim.claimAmount = exactClaim.reservationAmount;
  exactClaim.refundAmount = "0";
  exactClaim.refundContextHash = "0";
  exactClaim.refundBudgetCommitment = "0";
  exactClaim.voucherAmountCommitment = hash3(
    exactClaim.voucherContextHash,
    exactClaim.claimAmount,
    exactClaim.voucherAmountBlind,
    domains.voucherAmount,
  );
  exactClaim.providerSppOutputCommitment = hash3(
    exactClaim.claimAmount,
    exactClaim.providerLeafFields[4],
    exactClaim.sppProviderOutputBlind,
    domains.sppNote,
  );
  exactClaim.sppRefundOutputCommitment = hash3(
    0,
    exactClaim.providerLeafFields[4],
    exactClaim.sppRefundOutputBlind,
    domains.sppNote,
  );
  exactClaim.newAuditTotal = (BigInt(exactClaim.oldAuditTotal) + BigInt(exactClaim.claimAmount)).toString();
  exactClaim.newAuditTotalCommitment = hash3(
    exactClaim.auditContextHash,
    exactClaim.newAuditTotal,
    exactClaim.newAuditBlind,
    domains.auditTotal,
  );
  const exactClaimPath = resolve(temporary, "exact-claim.json");
  await writeFile(exactClaimPath, JSON.stringify(exactClaim));
  run(process.execPath, [generator, wasm, exactClaimPath, resolve(temporary, "exact-claim.wtns")]);

  process.stdout.write(
    "PrivateSettlementBindingV1 partial/exact witnesses: PASS; overclaim/provider/SPP/refund/voucher/audit mutations: REJECTED\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
