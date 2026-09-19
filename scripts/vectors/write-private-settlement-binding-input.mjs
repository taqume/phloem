import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const vector = JSON.parse(await readFile(resolve(root, "protocol/test-vectors/v1.json"), "utf8"));
const signals = vector.expected.publicSignals.privateSettlementBindingV1;
const output = {
  reservationContextHash: signals[0],
  reservationCommitment: signals[1],
  voucherContextHash: signals[2],
  voucherAmountCommitment: signals[3],
  providerCommitment: signals[4],
  providerSppOutputCommitment: signals[5],
  treasurySppKeyCommitment: signals[6],
  sppRefundOutputCommitment: signals[7],
  refundContextHash: signals[8],
  refundBudgetCommitment: signals[9],
  approvedProviderRoot: signals[10],
  auditContextHash: signals[11],
  oldAuditTotalCommitment: signals[12],
  newAuditTotalCommitment: signals[13],
  usageRoot: signals[14],
  offerCommitment: signals[15],
  reservationAmount: vector.circom.reservationAmount,
  reservationBlind: vector.circom.reservationBlind,
  voucherSignerPublicKeyFields: vector.circom.voucherSignerPublicKeyFields,
  claimAmount: vector.circom.claimAmount,
  voucherAmountBlind: vector.circom.voucherAmountBlind,
  providerLeafFields: vector.circom.providerLeafFields,
  providerBlind: vector.circom.providerBlind,
  sppProviderOutputBlind: vector.circom.sppOutputBlind,
  treasurySppPublicKey: vector.circom.treasurySppPublicKey,
  treasurySppKeyBlind: vector.circom.treasurySppKeyBlind,
  sppRefundOutputBlind: vector.circom.sppRefundOutputBlind,
  refundAmount: vector.circom.refundAmount,
  refundBlind: vector.circom.refundBlind,
  oldAuditTotal: vector.circom.oldAuditTotal,
  oldAuditBlind: vector.circom.oldAuditBlind,
  newAuditTotal: vector.circom.newAuditTotal,
  newAuditBlind: vector.circom.newAuditBlind,
};
const target = resolve(root, "circuits/private-settlement-binding-v1/input.v1.json");
const temporary = `${target}.tmp`;
await mkdir(dirname(target), { recursive: true });
await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
await rename(temporary, target);
process.stdout.write(`generated ${target}\n`);
