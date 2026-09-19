import { z } from "zod";

export const bytes32HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);
export const signatureHexSchema = z.string().regex(/^[0-9a-f]{128}$/u);
const BN254_SCALAR_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const U64_LIMIT = 1n << 64n;

export const fieldDecimalSchema = z.string().regex(/^(0|[1-9][0-9]*)$/u).refine(
  (value) => BigInt(value) < BN254_SCALAR_MODULUS,
  "field must be canonical BN254 Fr",
);
export const stellarAddressSchema = z.string().regex(/^[GC][A-Z2-7]{55}$/u);
export const u64DecimalSchema = z.string().regex(/^(0|[1-9][0-9]{0,19})$/u).refine(
  (value) => BigInt(value) < U64_LIMIT,
  "value must fit u64",
);

export const nodePolicySchema = z.object({
  categoryMask: u64DecimalSchema,
  allowedActionsMask: u64DecimalSchema,
  expiry: z.number().int().nonnegative(),
  remainingDelegationDepth: z.number().int().nonnegative(),
}).strict();

export const budgetNodeSchema = z.object({
  id: bytes32HexSchema,
  sessionId: bytes32HexSchema,
  parentNodeId: bytes32HexSchema.optional(),
  owner: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ROOT_COMPANY") }).strict(),
    z.object({ kind: z.literal("AGENT_SMART_ACCOUNT"), address: stellarAddressSchema }).strict(),
  ]),
  depth: z.number().int().nonnegative(),
  nodePolicy: nodePolicySchema,
  branchFrozen: z.boolean(),
  createdAtLedger: z.number().int().nonnegative(),
  state: z.enum(["ACTIVE", "DISABLED"]),
}).strict();

export const budgetNoteSchema = z.object({
  id: bytes32HexSchema,
  sessionId: bytes32HexSchema,
  nodeId: bytes32HexSchema,
  owner: z.union([stellarAddressSchema, z.literal("ROOT_COMPANY")]),
  policyHash: fieldDecimalSchema,
  commitment: fieldDecimalSchema,
  state: z.enum(["ACTIVE", "SPENT"]),
  createdAtLedger: z.number().int().nonnegative(),
  spentAtLedger: z.number().int().nonnegative().optional(),
}).strict();

export const sessionSchema = z.object({
  id: bytes32HexSchema,
  company: stellarAddressSchema,
  lifecycle: z.enum(["DRAFT", "FUNDING", "ACTIVE", "DRAINING", "CLOSED", "CANCELLED"]),
  safety: z.enum(["NORMAL", "FROZEN"]),
  asset: stellarAddressSchema,
  settlementMode: z.enum(["STANDARD", "PRIVATE"]),
  policyHash: fieldDecimalSchema,
  approvedProviderRoot: fieldDecimalSchema,
  categorySchemaVersion: z.number().int().nonnegative(),
  createdProtocolVersion: z.number().int().positive(),
  createdAtLedger: z.number().int().nonnegative(),
  expiresAtLedger: z.number().int().nonnegative(),
  rootBudgetNodeId: bytes32HexSchema.optional(),
  rootBudgetNoteId: bytes32HexSchema.optional(),
  settlementCount: u64DecimalSchema,
  unresolvedReservationCount: u64DecimalSchema,
  auditVersion: z.number().int().positive(),
  auditFinalized: z.boolean(),
  finalAuditSnapshotHash: bytes32HexSchema.optional(),
}).strict();

export const sessionPolicySchema = z.object({
  version: z.number().int().positive(),
  asset: stellarAddressSchema,
  settlementMode: z.enum(["STANDARD", "PRIVATE"]),
  approvedProviderRoot: fieldDecimalSchema,
  categorySchemaVersion: z.number().int().nonnegative(),
  maxDelegationDepth: z.number().int().nonnegative(),
  allowedActionsMask: u64DecimalSchema,
  sessionExpiry: z.number().int().nonnegative(),
  policyHash: fieldDecimalSchema,
}).strict();

export const privatePaymentReservationSchema = z.object({
  id: bytes32HexSchema,
  sessionId: bytes32HexSchema,
  sourceNodeId: bytes32HexSchema,
  sourceAgent: stellarAddressSchema,
  asset: stellarAddressSchema,
  categoryId: z.number().int().nonnegative(),
  offerCommitment: fieldDecimalSchema,
  voucherSignerPublicKey: bytes32HexSchema,
  amountCommitment: fieldDecimalSchema,
  providerCommitment: fieldDecimalSchema,
  approvedProviderRoot: fieldDecimalSchema,
  claimDeadlineLedger: z.number().int().nonnegative(),
  status: z.enum(["OPEN", "SETTLED", "RECLAIMED", "EXPIRED"]),
  createdAtLedger: z.number().int().nonnegative(),
}).strict();

export const serviceOfferSchema = z.object({
  protocolVersion: z.literal(1),
  offerVersion: z.literal(1),
  networkId: bytes32HexSchema,
  treasuryController: stellarAddressSchema,
  providerIdentity: stellarAddressSchema,
  serviceIdHash: bytes32HexSchema,
  categoryId: z.number().int().nonnegative(),
  asset: stellarAddressSchema,
  pricingModel: z.literal("FIXED_REQUEST"),
  fixedPriceAtomic: u64DecimalSchema,
  supportedSettlementModes: z.number().int().min(1).max(3),
  validUntilLedger: z.number().int().nonnegative(),
  offerNonce: bytes32HexSchema,
  providerSignature: signatureHexSchema,
}).strict();

export const usageEvidenceSchema = z.object({
  protocolVersion: z.literal(1),
  evidenceVersion: z.literal(1),
  networkId: bytes32HexSchema,
  treasuryController: stellarAddressSchema,
  sessionId: bytes32HexSchema,
  reservationId: bytes32HexSchema,
  providerIdentity: stellarAddressSchema,
  serviceIdHash: bytes32HexSchema,
  categoryId: z.number().int().nonnegative(),
  requestId: bytes32HexSchema,
  requestHash: bytes32HexSchema,
  responseHash: bytes32HexSchema,
  usageUnits: u64DecimalSchema,
  offerCommitment: fieldDecimalSchema,
  providerSequence: u64DecimalSchema,
  issuedAtLedger: z.number().int().nonnegative(),
  validUntilLedger: z.number().int().nonnegative(),
  evidenceNonce: bytes32HexSchema,
  providerSignature: signatureHexSchema,
}).strict();

export const privateVoucherSchema = z.object({
  protocolVersion: z.literal(1),
  voucherVersion: z.literal(1),
  networkId: bytes32HexSchema,
  treasuryController: stellarAddressSchema,
  sessionId: bytes32HexSchema,
  reservationId: bytes32HexSchema,
  sequence: u64DecimalSchema,
  cumulativeAmountCommitment: fieldDecimalSchema,
  usageRoot: fieldDecimalSchema,
  offerCommitment: fieldDecimalSchema,
  expiryLedger: z.number().int().nonnegative(),
  paymentCommitmentSignature: signatureHexSchema,
}).strict();

export const standardSettlementInputSchema = z.object({
  paymentId: bytes32HexSchema,
  sessionId: bytes32HexSchema,
  sourceBudgetNoteId: bytes32HexSchema,
  amountAtomic: u64DecimalSchema,
  provider: stellarAddressSchema,
  providerSppPublicKey: fieldDecimalSchema,
  serviceIdHash: bytes32HexSchema,
  categoryId: z.number().int().nonnegative(),
  allowedSettlementModes: z.number().int().min(1).max(3),
  usageRoot: fieldDecimalSchema,
  offerReferenceHash: bytes32HexSchema,
  remainderBudgetNoteId: bytes32HexSchema.optional(),
  remainderCommitment: fieldDecimalSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.remainderBudgetNoteId === undefined) !== (value.remainderCommitment === undefined)) {
    context.addIssue({ code: "custom", message: "remainder id and commitment must appear together" });
  }
});

export const paymentRecordSchema = z.object({
  paymentId: bytes32HexSchema,
  sessionId: bytes32HexSchema,
  sourceBudgetNoteId: bytes32HexSchema,
  remainderBudgetNoteId: bytes32HexSchema.optional(),
  amountAtomic: u64DecimalSchema,
  provider: stellarAddressSchema,
  categoryId: z.number().int().nonnegative(),
  usageRoot: fieldDecimalSchema,
  offerReferenceHash: bytes32HexSchema,
  settlementRef: bytes32HexSchema,
  status: z.literal("SETTLED"),
  settledAtLedger: z.number().int().nonnegative(),
}).strict();

export const sessionAuditStateSchema = z.object({
  sessionId: bytes32HexSchema,
  totalSpendCommitment: fieldDecimalSchema,
  settlementCount: u64DecimalSchema,
  unresolvedReservationCount: u64DecimalSchema,
  auditVersion: z.number().int().positive(),
  policyHash: fieldDecimalSchema,
  finalized: z.boolean(),
  finalSnapshotHash: bytes32HexSchema.optional(),
  standardTotalSpendAtomic: u64DecimalSchema.optional(),
}).strict();

export const finalAuditSnapshotSchema = z.object({
  sessionId: bytes32HexSchema,
  settlementMode: z.enum(["STANDARD", "PRIVATE"]),
  totalSpendCommitment: fieldDecimalSchema,
  settlementCount: u64DecimalSchema,
  policyHash: fieldDecimalSchema,
  auditVersion: z.number().int().positive(),
  finalizedAtLedger: z.number().int().nonnegative(),
}).strict();

export type Session = z.infer<typeof sessionSchema>;
export type SessionPolicy = z.infer<typeof sessionPolicySchema>;
export type BudgetNode = z.infer<typeof budgetNodeSchema>;
export type BudgetNote = z.infer<typeof budgetNoteSchema>;
export type PrivatePaymentReservation = z.infer<typeof privatePaymentReservationSchema>;
export type ServiceOffer = z.infer<typeof serviceOfferSchema>;
export type UsageEvidence = z.infer<typeof usageEvidenceSchema>;
export type PrivateVoucher = z.infer<typeof privateVoucherSchema>;
export type StandardSettlementInput = z.infer<typeof standardSettlementInputSchema>;
export type PaymentRecord = z.infer<typeof paymentRecordSchema>;
export type SessionAuditState = z.infer<typeof sessionAuditStateSchema>;
export type FinalAuditSnapshot = z.infer<typeof finalAuditSnapshotSchema>;
