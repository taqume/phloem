import { bytes32HexSchema, fieldDecimalSchema, u64DecimalSchema } from "@phloem/protocol-types";
import { z } from "zod";

export const PRIVACY_STATE_SCHEMA_VERSION = 3 as const;

const unixMillisecondsSchema = z.number().int().nonnegative();
const contractAddressSchema = z.string().regex(/^C[A-Z2-7]{55}$/u);
const positiveFieldDecimalSchema = fieldDecimalSchema.refine((value) => value !== "0", "field must be non-zero");
const positiveU64DecimalSchema = u64DecimalSchema.refine((value) => value !== "0", "value must be non-zero");

export const budgetNoteOpeningSchema = z.object({
  noteId: bytes32HexSchema,
  sessionId: bytes32HexSchema,
  nodeId: bytes32HexSchema,
  owner: contractAddressSchema,
  asset: contractAddressSchema,
  policyHash: fieldDecimalSchema,
  contextHash: fieldDecimalSchema,
  commitment: fieldDecimalSchema,
  amountAtomic: positiveU64DecimalSchema,
  blinding: positiveFieldDecimalSchema,
  status: z.enum(["ACTIVE", "SPEND_PENDING", "SPENT"]),
  pendingOperationId: bytes32HexSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.status === "SPEND_PENDING") !== (value.pendingOperationId !== undefined)) {
    context.addIssue({ code: "custom", message: "only a pending note may carry a pending operation id" });
  }
});

export const voucherOpeningSchema = z.object({
  sequence: u64DecimalSchema,
  cumulativeAmountAtomic: positiveU64DecimalSchema,
  amountBlinding: positiveFieldDecimalSchema,
  cumulativeAmountCommitment: fieldDecimalSchema,
  usageRoot: fieldDecimalSchema,
  expiryLedger: z.number().int().nonnegative(),
  signatureHex: z.string().regex(/^[0-9a-f]{128}$/u),
}).strict();

export const preparedRemainderOpeningSchema = z.object({
  noteId: bytes32HexSchema,
  contextHash: fieldDecimalSchema,
  amountAtomic: positiveU64DecimalSchema,
  blinding: positiveFieldDecimalSchema,
  commitment: fieldDecimalSchema,
}).strict();

export const chainConfirmationSchema = z.object({
  transactionHash: bytes32HexSchema,
  ledgerSequence: z.number().int().positive(),
}).strict();

export const preparedAuditUpdateSchema = z.object({
  auditContextHash: fieldDecimalSchema,
  totalSpendAtomic: u64DecimalSchema,
  blinding: positiveFieldDecimalSchema,
  commitment: fieldDecimalSchema,
  auditVersion: z.number().int().positive(),
}).strict();

export const preparedPrivateSettlementSchema = z.object({
  operationId: bytes32HexSchema,
  voucherSequence: positiveU64DecimalSchema,
  providerSppOutputCommitment: fieldDecimalSchema,
  sppRefundOutputCommitment: fieldDecimalSchema,
  refundBudgetNote: preparedRemainderOpeningSchema.optional(),
  nextAudit: preparedAuditUpdateSchema,
}).strict();

export const reservationOpeningSchema = z.object({
  reservationId: bytes32HexSchema,
  sessionId: bytes32HexSchema,
  sourceBudgetNoteId: bytes32HexSchema,
  categoryId: z.number().int().nonnegative(),
  networkIdHex: bytes32HexSchema,
  treasuryController: contractAddressSchema,
  reservationContextHash: fieldDecimalSchema,
  approvedProviderRoot: fieldDecimalSchema,
  amountAtomic: positiveU64DecimalSchema,
  amountBlinding: positiveFieldDecimalSchema,
  amountCommitment: fieldDecimalSchema,
  offerReferenceHash: bytes32HexSchema,
  offerBlinding: positiveFieldDecimalSchema,
  offerCommitment: fieldDecimalSchema,
  providerSppPublicKey: positiveFieldDecimalSchema,
  providerBlinding: positiveFieldDecimalSchema,
  providerCommitment: fieldDecimalSchema,
  voucherSignerSeedHex: bytes32HexSchema,
  voucherSignerPublicKeyHex: bytes32HexSchema,
  claimDeadlineLedger: z.number().int().positive(),
  preparedRemainder: preparedRemainderOpeningSchema.optional(),
  status: z.enum(["PREPARED", "OPEN", "SETTLEMENT_PENDING", "SETTLED", "RECLAIMED", "EXPIRED"]),
  openConfirmation: chainConfirmationSchema.optional(),
  settlementConfirmation: chainConfirmationSchema.optional(),
  preparedSettlement: preparedPrivateSettlementSchema.optional(),
  latestVoucher: voucherOpeningSchema.optional(),
  createdAtUnixMs: unixMillisecondsSchema,
}).strict().superRefine((value, context) => {
  if ((value.status === "PREPARED") === (value.openConfirmation !== undefined)) {
    context.addIssue({ code: "custom", message: "only a chain-confirmed reservation may leave PREPARED state" });
  }
  if ((value.status === "SETTLEMENT_PENDING") !== (value.preparedSettlement !== undefined)) {
    context.addIssue({ code: "custom", message: "only a pending settlement may carry prepared settlement state" });
  }
  if ((value.status === "SETTLED") !== (value.settlementConfirmation !== undefined)) {
    context.addIssue({ code: "custom", message: "only a settled reservation may carry settlement confirmation" });
  }
});

export const auditAccumulatorOpeningSchema = z.object({
  sessionId: bytes32HexSchema,
  auditContextHash: fieldDecimalSchema,
  totalSpendAtomic: u64DecimalSchema,
  blinding: positiveFieldDecimalSchema,
  commitment: fieldDecimalSchema,
  auditVersion: z.number().int().positive(),
}).strict();

export const treasuryPrivacyKeySchema = z.object({
  sessionId: bytes32HexSchema,
  auditContextHash: fieldDecimalSchema,
  notePrivateKeyLeHex: bytes32HexSchema,
  notePublicKey: positiveFieldDecimalSchema,
  encryptionPrivateKeyHex: bytes32HexSchema,
  encryptionPublicKeyHex: bytes32HexSchema,
  membershipBlinding: positiveFieldDecimalSchema,
  commitmentBlinding: positiveFieldDecimalSchema,
  commitment: fieldDecimalSchema,
  createdAtUnixMs: unixMillisecondsSchema,
}).strict();

export const sppTreasuryNoteOpeningSchema = z.object({
  noteId: bytes32HexSchema,
  sessionId: bytes32HexSchema,
  pool: contractAddressSchema,
  commitment: fieldDecimalSchema,
  amountAtomic: positiveU64DecimalSchema,
  blinding: positiveFieldDecimalSchema,
  leafIndex: z.number().int().nonnegative().optional(),
  status: z.enum(["PREPARED", "ACTIVE", "SPEND_PENDING", "SPENT"]),
  pendingOperationId: bytes32HexSchema.optional(),
  confirmation: chainConfirmationSchema.optional(),
  createdAtUnixMs: unixMillisecondsSchema,
}).strict().superRefine((value, context) => {
  if ((value.status === "PREPARED") === (value.confirmation !== undefined)) {
    context.addIssue({ code: "custom", message: "only a confirmed SPP note may leave PREPARED state" });
  }
  if ((value.status === "PREPARED") !== (value.leafIndex === undefined)) {
    context.addIssue({ code: "custom", message: "only a confirmed SPP note must carry a leaf index" });
  }
  if ((value.status === "SPEND_PENDING") !== (value.pendingOperationId !== undefined)) {
    context.addIssue({ code: "custom", message: "only a pending SPP note may carry an operation id" });
  }
});

export const sppSpendOperationSchema = z.object({
  operationId: bytes32HexSchema,
  sessionId: bytes32HexSchema,
  pool: contractAddressSchema,
  inputNoteIds: z.array(bytes32HexSchema).min(1).max(2),
  refundNoteId: bytes32HexSchema.optional(),
  status: z.enum(["PREPARED", "CONFIRMED"]),
  confirmation: chainConfirmationSchema.optional(),
  createdAtUnixMs: unixMillisecondsSchema,
}).strict().superRefine((value, context) => {
  if ((value.status === "CONFIRMED") !== (value.confirmation !== undefined)) {
    context.addIssue({ code: "custom", message: "only a confirmed SPP spend carries confirmation" });
  }
  if (new Set(value.inputNoteIds).size !== value.inputNoteIds.length) {
    context.addIssue({ code: "custom", message: "SPP spend input note ids must be unique" });
  }
});

export const privacyStateSchema = z.object({
  schemaVersion: z.literal(PRIVACY_STATE_SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  budgetNotes: z.array(budgetNoteOpeningSchema),
  reservations: z.array(reservationOpeningSchema),
  auditAccumulators: z.array(auditAccumulatorOpeningSchema),
  treasuryPrivacyKeys: z.array(treasuryPrivacyKeySchema),
  sppTreasuryNotes: z.array(sppTreasuryNoteOpeningSchema),
  sppSpendOperations: z.array(sppSpendOperationSchema),
}).strict().superRefine((value, context) => {
  for (const [label, values] of [
    ["budget note", value.budgetNotes.map((item) => item.noteId)],
    ["reservation", value.reservations.map((item) => item.reservationId)],
    ["voucher public key", value.reservations.map((item) => item.voucherSignerPublicKeyHex)],
    ["audit session", value.auditAccumulators.map((item) => item.sessionId)],
    ["treasury privacy session", value.treasuryPrivacyKeys.map((item) => item.sessionId)],
    ["SPP treasury note", value.sppTreasuryNotes.map((item) => item.noteId)],
    ["SPP treasury commitment", value.sppTreasuryNotes.map((item) => item.commitment)],
    ["SPP spend operation", value.sppSpendOperations.map((item) => item.operationId)],
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: `duplicate ${label} in privacy state` });
    }
  }
});

export type BudgetNoteOpening = z.infer<typeof budgetNoteOpeningSchema>;
export type ReservationOpening = z.infer<typeof reservationOpeningSchema>;
export type VoucherOpening = z.infer<typeof voucherOpeningSchema>;
export type PreparedRemainderOpening = z.infer<typeof preparedRemainderOpeningSchema>;
export type ChainConfirmation = z.infer<typeof chainConfirmationSchema>;
export type PreparedPrivateSettlement = z.infer<typeof preparedPrivateSettlementSchema>;
export type AuditAccumulatorOpening = z.infer<typeof auditAccumulatorOpeningSchema>;
export type TreasuryPrivacyKeyState = z.infer<typeof treasuryPrivacyKeySchema>;
export type SppTreasuryNoteOpening = z.infer<typeof sppTreasuryNoteOpeningSchema>;
export type SppSpendOperation = z.infer<typeof sppSpendOperationSchema>;
export type PrivacyState = z.infer<typeof privacyStateSchema>;

export function emptyPrivacyState(): PrivacyState {
  return {
    schemaVersion: PRIVACY_STATE_SCHEMA_VERSION,
    revision: 0,
    budgetNotes: [],
    reservations: [],
    auditAccumulators: [],
    treasuryPrivacyKeys: [],
    sppTreasuryNotes: [],
    sppSpendOperations: [],
  };
}
