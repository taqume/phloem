import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}




export const Errors = {
  1: {message:"SessionNotFound"},
  2: {message:"InvalidExpiry"},
  3: {message:"InvalidPolicy"},
  4: {message:"NonCanonicalField"},
  5: {message:"AssetNotAllowed"},
  6: {message:"InvalidLifecycle"},
  7: {message:"WrongSettlementMode"},
  8: {message:"SessionFrozen"},
  9: {message:"SessionExpired"},
  10: {message:"InvalidAmount"},
  11: {message:"IdentifierAlreadyUsed"},
  12: {message:"CounterOverflow"},
  13: {message:"BudgetNoteNotFound"},
  14: {message:"BudgetNodeNotFound"},
  15: {message:"InvalidBudgetOwner"},
  16: {message:"BudgetNoteSpent"},
  17: {message:"InvalidNodeState"},
  18: {message:"BranchFrozen"},
  19: {message:"InvalidChildPolicy"},
  20: {message:"InvalidConservation"},
  21: {message:"InvalidAgentAccount"},
  22: {message:"BudgetStateMismatch"},
  23: {message:"InvalidAddressEncoding"},
  24: {message:"InvalidProof"},
  25: {message:"AuditStateNotFound"},
  26: {message:"PaymentAlreadySettled"},
  27: {message:"ProviderNotApproved"},
  28: {message:"CategoryNotAllowed"},
  29: {message:"ActionNotAllowed"},
  30: {message:"AuditStateMismatch"},
  31: {message:"ReservationNotFound"},
  32: {message:"ReservationAlreadyExists"},
  33: {message:"VoucherKeyAlreadyUsed"},
  34: {message:"InvalidReservation"},
  35: {message:"InvalidVoucher"},
  36: {message:"InvalidPrivateSettlement"}
}








export interface Session {
  approved_provider_root: u256;
  asset: string;
  audit_finalized: boolean;
  audit_version: u32;
  category_schema_version: u32;
  company: string;
  created_at_ledger: u32;
  created_protocol_version: u32;
  expires_at_ledger: u32;
  final_audit_snapshot_hash: Option<Buffer>;
  id: Buffer;
  lifecycle: SessionLifecycle;
  policy_hash: u256;
  root_budget_node_id: Option<Buffer>;
  root_budget_note_id: Option<Buffer>;
  safety: SafetyState;
  settlement_count: u64;
  settlement_mode: SettlementMode;
  treasury_spp_key_commitment: Option<u256>;
  unresolved_reservation_count: u64;
}


export interface SppProof {
  asp_membership_root: u256;
  asp_non_membership_root: u256;
  ext_data_hash: Buffer;
  input_nullifiers: Array<u256>;
  output_commitment0: u256;
  output_commitment1: u256;
  proof: Groth16Proof;
  public_amount: u256;
  root: u256;
}


export interface BudgetNode {
  branch_frozen: boolean;
  created_at_ledger: u32;
  depth: u32;
  id: Buffer;
  node_policy: NodePolicy;
  owner: BudgetNodeOwner;
  parent_node_id: Option<Buffer>;
  session_id: Buffer;
  state: BudgetNodeState;
}


export interface NodePolicy {
  allowed_actions_mask: u64;
  category_mask: u64;
  expiry: u32;
  remaining_delegation_depth: u32;
}


export interface SppExtData {
  encrypted_output0: Buffer;
  encrypted_output1: Buffer;
  ext_amount: i256;
  recipient: string;
}

export type SafetyState = {tag: "Normal", values: void} | {tag: "Frozen", values: void};


export interface Groth16Proof {
  a: Buffer;
  b: Buffer;
  c: Buffer;
}


export interface PaymentRecord {
  amount_atomic: u64;
  category_id: u32;
  offer_reference_hash: Buffer;
  payment_id: Buffer;
  provider: string;
  remainder_budget_note_id: Option<Buffer>;
  session_id: Buffer;
  settled_at_ledger: u32;
  settlement_ref: Buffer;
  source_budget_note_id: Buffer;
  status: PaymentStatus;
  usage_root: u256;
}

export type PaymentStatus = {tag: "Settled", values: void};


export interface SessionPolicy {
  allowed_actions_mask: u64;
  approved_provider_root: u256;
  asset: string;
  category_schema_version: u32;
  max_delegation_depth: u32;
  policy_hash: u256;
  session_expiry: u32;
  settlement_mode: SettlementMode;
  version: u32;
}


export interface PrivateVoucher {
  cumulative_amount_commitment: u256;
  expiry_ledger: u32;
  network_id: Buffer;
  offer_commitment: u256;
  protocol_version: u32;
  reservation_id: Buffer;
  sequence: u64;
  session_id: Buffer;
  treasury_controller: string;
  usage_root: u256;
  voucher_version: u32;
}

export type SettlementMode = {tag: "Standard", values: void} | {tag: "Private", values: void};

export type BudgetNodeOwner = {tag: "RootCompany", values: void} | {tag: "AgentSmartAccount", values: readonly [string]};

export type BudgetNodeState = {tag: "Active", values: void} | {tag: "Disabled", values: void};


export interface BudgetNoteState {
  commitment: u256;
  created_at_ledger: u32;
  id: Buffer;
  node_id: Buffer;
  owner: BudgetNodeOwner;
  policy_hash: u256;
  session_id: Buffer;
  spent_at_ledger: Option<u32>;
  state: BudgetNoteStatus;
}

export type BudgetNoteStatus = {tag: "Active", values: void} | {tag: "Spent", values: void};

export type SessionLifecycle = {tag: "Draft", values: void} | {tag: "Funding", values: void} | {tag: "Active", values: void} | {tag: "Draining", values: void} | {tag: "Closed", values: void} | {tag: "Cancelled", values: void};


export interface SessionAuditState {
  audit_version: u32;
  final_snapshot_hash: Option<Buffer>;
  finalized: boolean;
  policy_hash: u256;
  session_id: Buffer;
  settlement_count: u64;
  standard_total_spend_atomic: Option<u64>;
  total_spend_commitment: u256;
  unresolved_reservation_count: u64;
}


export interface RootBudgetNoteInput {
  commitment: u256;
  node_id: Buffer;
  note_id: Buffer;
}


export interface PrivatePaymentRecord {
  audit_total_commitment: u256;
  provider_spp_output_commitment: u256;
  refund_budget_note_id: Option<Buffer>;
  reservation_id: Buffer;
  session_id: Buffer;
  settled_at_ledger: u32;
  settlement_ref: Buffer;
  spp_refund_output_commitment: u256;
  status: PaymentStatus;
  usage_root: u256;
  voucher_sequence: u64;
}


export interface PrivateSettlementInput {
  binding_proof: Groth16Proof;
  new_audit_total_commitment: u256;
  refund_budget_commitment: Option<u256>;
  refund_budget_note_id: Option<Buffer>;
  spp_ext_data: SppExtData;
  spp_proof: SppProof;
  voucher: PrivateVoucher;
  voucher_signature: Buffer;
}


export interface PrivateReservationInput {
  amount_commitment: u256;
  category_id: u32;
  claim_deadline_ledger: u32;
  offer_commitment: u256;
  provider_commitment: u256;
  remainder_budget_note_id: Option<Buffer>;
  remainder_commitment: Option<u256>;
  reservation_id: Buffer;
  session_id: Buffer;
  source_budget_note_id: Buffer;
  voucher_signer_public_key: Buffer;
}


export interface StandardDelegationInput {
  child_commitment: u256;
  child_node_id: Buffer;
  child_note_id: Buffer;
  child_owner: string;
  child_policy: NodePolicy;
  delegated_amount: u64;
  remainder_commitment: Option<u256>;
  remainder_note_id: Option<Buffer>;
}


export interface StandardSettlementInput {
  allowed_settlement_modes: u32;
  amount_atomic: u64;
  category_id: u32;
  offer_reference_hash: Buffer;
  payment_id: Buffer;
  provider: string;
  provider_spp_public_key: u256;
  remainder_budget_note_id: Option<Buffer>;
  remainder_commitment: Option<u256>;
  service_id_hash: Buffer;
  session_id: Buffer;
  source_budget_note_id: Buffer;
  usage_root: u256;
}

export type PrivateReservationStatus = {tag: "Open", values: void} | {tag: "Settled", values: void} | {tag: "Reclaimed", values: void} | {tag: "Expired", values: void};


export interface PrivatePaymentReservation {
  amount_commitment: u256;
  approved_provider_root: u256;
  asset: string;
  category_id: u32;
  claim_deadline_ledger: u32;
  created_at_ledger: u32;
  id: Buffer;
  offer_commitment: u256;
  provider_commitment: u256;
  reservation_context_hash: u256;
  session_id: Buffer;
  source_agent: string;
  source_node_id: Buffer;
  status: PrivateReservationStatus;
  voucher_signer_public_key: Buffer;
}

export interface Client {
  /**
   * Construct and simulate a get_session transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_session: ({session_id}: {session_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Option<Session>>>

  /**
   * Construct and simulate a get_spp_pool transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_spp_pool: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a create_session transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  create_session: ({company, asset, settlement_mode, draft_policy, expires_at}: {company: string, asset: string, settlement_mode: SettlementMode, draft_policy: SessionPolicy, expires_at: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Buffer>>

  /**
   * Construct and simulate a get_audit_state transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_audit_state: ({session_id}: {session_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Option<SessionAuditState>>>

  /**
   * Construct and simulate a get_budget_node transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_budget_node: ({node_id}: {node_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Option<BudgetNode>>>

  /**
   * Construct and simulate a get_budget_note transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_budget_note: ({note_id}: {note_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Option<BudgetNoteState>>>

  /**
   * Construct and simulate a get_payment_record transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_payment_record: ({payment_id}: {payment_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Option<PaymentRecord>>>

  /**
   * Construct and simulate a get_session_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_session_policy: ({session_id}: {session_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Option<SessionPolicy>>>

  /**
   * Construct and simulate a get_standard_asset transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_standard_asset: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a delegate_standard_root transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  delegate_standard_root: ({session_id, source_note_id, delegation}: {session_id: Buffer, source_note_id: Buffer, delegation: StandardDelegationInput}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a get_audit_context_hash transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_audit_context_hash: ({session_id}: {session_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<u256>>

  /**
   * Construct and simulate a settle_private_payment transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  settle_private_payment: ({input}: {input: PrivateSettlementInput}, options?: MethodOptions) => Promise<AssembledTransaction<PrivatePaymentRecord>>

  /**
   * Construct and simulate a verify_private_voucher transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  verify_private_voucher: ({voucher, signature}: {voucher: PrivateVoucher, signature: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a get_private_reservation transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_private_reservation: ({reservation_id}: {reservation_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Option<PrivatePaymentReservation>>>

  /**
   * Construct and simulate a settle_standard_payment transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  settle_standard_payment: ({input}: {input: StandardSettlementInput}, options?: MethodOptions) => Promise<AssembledTransaction<PaymentRecord>>

  /**
   * Construct and simulate a delegate_standard_budget transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  delegate_standard_budget: ({session_id, source_note_id, delegation}: {session_id: Buffer, source_note_id: Buffer, delegation: StandardDelegationInput}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a get_provider_policy_leaf transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_provider_policy_leaf: ({provider_identity, provider_spp_public_key, service_id_hash, category_id, allowed_settlement_modes}: {provider_identity: string, provider_spp_public_key: u256, service_id_hash: Buffer, category_id: u32, allowed_settlement_modes: u32}, options?: MethodOptions) => Promise<AssembledTransaction<u256>>

  /**
   * Construct and simulate a get_standard_note_amount transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_standard_note_amount: ({note_id}: {note_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Option<u64>>>

  /**
   * Construct and simulate a open_private_reservation transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  open_private_reservation: ({input, proof}: {input: PrivateReservationInput, proof: Groth16Proof}, options?: MethodOptions) => Promise<AssembledTransaction<PrivatePaymentReservation>>

  /**
   * Construct and simulate a activate_standard_session transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  activate_standard_session: ({session_id, root_note, funding_amount}: {session_id: Buffer, root_note: RootBudgetNoteInput, funding_amount: u64}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a get_private_payment_record transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_private_payment_record: ({reservation_id}: {reservation_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Option<PrivatePaymentRecord>>>

  /**
   * Construct and simulate a get_agent_account_wasm_hash transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_agent_account_wasm_hash: (options?: MethodOptions) => Promise<AssembledTransaction<Buffer>>

  /**
   * Construct and simulate a get_budget_note_context_hash transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_budget_note_context_hash: ({note_id}: {note_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<u256>>

  /**
   * Construct and simulate a get_private_binding_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_private_binding_verifier: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a get_budget_transition_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_budget_transition_verifier: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {standard_asset, agent_account_wasm_hash, budget_transition_verifier, private_binding_verifier, spp_pool}: {standard_asset: string, agent_account_wasm_hash: Buffer, budget_transition_verifier: string, private_binding_verifier: string, spp_pool: string},
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy({standard_asset, agent_account_wasm_hash, budget_transition_verifier, private_binding_verifier, spp_pool}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAAAAAAAAAAALZ2V0X3Nlc3Npb24AAAAAAQAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAD7gAAACAAAAABAAAD6AAAB9AAAAAHU2Vzc2lvbgA=",
        "AAAAAAAAAAAAAAAMZ2V0X3NwcF9wb29sAAAAAAAAAAEAAAAT",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAUAAAAAAAAADnN0YW5kYXJkX2Fzc2V0AAAAAAATAAAAAAAAABdhZ2VudF9hY2NvdW50X3dhc21faGFzaAAAAAPuAAAAIAAAAAAAAAAaYnVkZ2V0X3RyYW5zaXRpb25fdmVyaWZpZXIAAAAAABMAAAAAAAAAGHByaXZhdGVfYmluZGluZ192ZXJpZmllcgAAABMAAAAAAAAACHNwcF9wb29sAAAAEwAAAAA=",
        "AAAAAAAAAAAAAAAOY3JlYXRlX3Nlc3Npb24AAAAAAAUAAAAAAAAAB2NvbXBhbnkAAAAAEwAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAAAAAA9zZXR0bGVtZW50X21vZGUAAAAH0AAAAA5TZXR0bGVtZW50TW9kZQAAAAAAAAAAAAxkcmFmdF9wb2xpY3kAAAfQAAAADVNlc3Npb25Qb2xpY3kAAAAAAAAAAAAACmV4cGlyZXNfYXQAAAAAAAQAAAABAAAD7gAAACA=",
        "AAAAAAAAAAAAAAAPZ2V0X2F1ZGl0X3N0YXRlAAAAAAEAAAAAAAAACnNlc3Npb25faWQAAAAAA+4AAAAgAAAAAQAAA+gAAAfQAAAAEVNlc3Npb25BdWRpdFN0YXRlAAAA",
        "AAAAAAAAAAAAAAAPZ2V0X2J1ZGdldF9ub2RlAAAAAAEAAAAAAAAAB25vZGVfaWQAAAAD7gAAACAAAAABAAAD6AAAB9AAAAAKQnVkZ2V0Tm9kZQAA",
        "AAAAAAAAAAAAAAAPZ2V0X2J1ZGdldF9ub3RlAAAAAAEAAAAAAAAAB25vdGVfaWQAAAAD7gAAACAAAAABAAAD6AAAB9AAAAAPQnVkZ2V0Tm90ZVN0YXRlAA==",
        "AAAAAAAAAAAAAAASZ2V0X3BheW1lbnRfcmVjb3JkAAAAAAABAAAAAAAAAApwYXltZW50X2lkAAAAAAPuAAAAIAAAAAEAAAPoAAAH0AAAAA1QYXltZW50UmVjb3JkAAAA",
        "AAAAAAAAAAAAAAASZ2V0X3Nlc3Npb25fcG9saWN5AAAAAAABAAAAAAAAAApzZXNzaW9uX2lkAAAAAAPuAAAAIAAAAAEAAAPoAAAH0AAAAA1TZXNzaW9uUG9saWN5AAAA",
        "AAAAAAAAAAAAAAASZ2V0X3N0YW5kYXJkX2Fzc2V0AAAAAAAAAAAAAQAAABM=",
        "AAAAAAAAAAAAAAAWZGVsZWdhdGVfc3RhbmRhcmRfcm9vdAAAAAAAAwAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAD7gAAACAAAAAAAAAADnNvdXJjZV9ub3RlX2lkAAAAAAPuAAAAIAAAAAAAAAAKZGVsZWdhdGlvbgAAAAAH0AAAABdTdGFuZGFyZERlbGVnYXRpb25JbnB1dAAAAAAA",
        "AAAAAAAAAAAAAAAWZ2V0X2F1ZGl0X2NvbnRleHRfaGFzaAAAAAAAAQAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAD7gAAACAAAAABAAAADA==",
        "AAAAAAAAAAAAAAAWc2V0dGxlX3ByaXZhdGVfcGF5bWVudAAAAAAAAQAAAAAAAAAFaW5wdXQAAAAAAAfQAAAAFlByaXZhdGVTZXR0bGVtZW50SW5wdXQAAAAAAAEAAAfQAAAAFFByaXZhdGVQYXltZW50UmVjb3Jk",
        "AAAAAAAAAAAAAAAWdmVyaWZ5X3ByaXZhdGVfdm91Y2hlcgAAAAAAAgAAAAAAAAAHdm91Y2hlcgAAAAfQAAAADlByaXZhdGVWb3VjaGVyAAAAAAAAAAAACXNpZ25hdHVyZQAAAAAAA+4AAABAAAAAAQAAAAE=",
        "AAAAAAAAAAAAAAAXZ2V0X3ByaXZhdGVfcmVzZXJ2YXRpb24AAAAAAQAAAAAAAAAOcmVzZXJ2YXRpb25faWQAAAAAA+4AAAAgAAAAAQAAA+gAAAfQAAAAGVByaXZhdGVQYXltZW50UmVzZXJ2YXRpb24AAAA=",
        "AAAAAAAAAAAAAAAXc2V0dGxlX3N0YW5kYXJkX3BheW1lbnQAAAAAAQAAAAAAAAAFaW5wdXQAAAAAAAfQAAAAF1N0YW5kYXJkU2V0dGxlbWVudElucHV0AAAAAAEAAAfQAAAADVBheW1lbnRSZWNvcmQAAAA=",
        "AAAAAAAAAAAAAAAYZGVsZWdhdGVfc3RhbmRhcmRfYnVkZ2V0AAAAAwAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAD7gAAACAAAAAAAAAADnNvdXJjZV9ub3RlX2lkAAAAAAPuAAAAIAAAAAAAAAAKZGVsZWdhdGlvbgAAAAAH0AAAABdTdGFuZGFyZERlbGVnYXRpb25JbnB1dAAAAAAA",
        "AAAAAAAAAAAAAAAYZ2V0X3Byb3ZpZGVyX3BvbGljeV9sZWFmAAAABQAAAAAAAAARcHJvdmlkZXJfaWRlbnRpdHkAAAAAAAATAAAAAAAAABdwcm92aWRlcl9zcHBfcHVibGljX2tleQAAAAAMAAAAAAAAAA9zZXJ2aWNlX2lkX2hhc2gAAAAD7gAAACAAAAAAAAAAC2NhdGVnb3J5X2lkAAAAAAQAAAAAAAAAGGFsbG93ZWRfc2V0dGxlbWVudF9tb2RlcwAAAAQAAAABAAAADA==",
        "AAAAAAAAAAAAAAAYZ2V0X3N0YW5kYXJkX25vdGVfYW1vdW50AAAAAQAAAAAAAAAHbm90ZV9pZAAAAAPuAAAAIAAAAAEAAAPoAAAABg==",
        "AAAAAAAAAAAAAAAYb3Blbl9wcml2YXRlX3Jlc2VydmF0aW9uAAAAAgAAAAAAAAAFaW5wdXQAAAAAAAfQAAAAF1ByaXZhdGVSZXNlcnZhdGlvbklucHV0AAAAAAAAAAAFcHJvb2YAAAAAAAfQAAAADEdyb3RoMTZQcm9vZgAAAAEAAAfQAAAAGVByaXZhdGVQYXltZW50UmVzZXJ2YXRpb24AAAA=",
        "AAAAAAAAAAAAAAAZYWN0aXZhdGVfc3RhbmRhcmRfc2Vzc2lvbgAAAAAAAAMAAAAAAAAACnNlc3Npb25faWQAAAAAA+4AAAAgAAAAAAAAAAlyb290X25vdGUAAAAAAAfQAAAAE1Jvb3RCdWRnZXROb3RlSW5wdXQAAAAAAAAAAA5mdW5kaW5nX2Ftb3VudAAAAAAABgAAAAA=",
        "AAAAAAAAAAAAAAAaZ2V0X3ByaXZhdGVfcGF5bWVudF9yZWNvcmQAAAAAAAEAAAAAAAAADnJlc2VydmF0aW9uX2lkAAAAAAPuAAAAIAAAAAEAAAPoAAAH0AAAABRQcml2YXRlUGF5bWVudFJlY29yZA==",
        "AAAAAAAAAAAAAAAbZ2V0X2FnZW50X2FjY291bnRfd2FzbV9oYXNoAAAAAAAAAAABAAAD7gAAACA=",
        "AAAAAAAAAAAAAAAcZ2V0X2J1ZGdldF9ub3RlX2NvbnRleHRfaGFzaAAAAAEAAAAAAAAAB25vdGVfaWQAAAAD7gAAACAAAAABAAAADA==",
        "AAAAAAAAAAAAAAAcZ2V0X3ByaXZhdGVfYmluZGluZ192ZXJpZmllcgAAAAAAAAABAAAAEw==",
        "AAAAAAAAAAAAAAAeZ2V0X2J1ZGdldF90cmFuc2l0aW9uX3ZlcmlmaWVyAAAAAAAAAAAAAQAAABM=",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAJAAAAAAAAAAPU2Vzc2lvbk5vdEZvdW5kAAAAAAEAAAAAAAAADUludmFsaWRFeHBpcnkAAAAAAAACAAAAAAAAAA1JbnZhbGlkUG9saWN5AAAAAAAAAwAAAAAAAAARTm9uQ2Fub25pY2FsRmllbGQAAAAAAAAEAAAAAAAAAA9Bc3NldE5vdEFsbG93ZWQAAAAABQAAAAAAAAAQSW52YWxpZExpZmVjeWNsZQAAAAYAAAAAAAAAE1dyb25nU2V0dGxlbWVudE1vZGUAAAAABwAAAAAAAAANU2Vzc2lvbkZyb3plbgAAAAAAAAgAAAAAAAAADlNlc3Npb25FeHBpcmVkAAAAAAAJAAAAAAAAAA1JbnZhbGlkQW1vdW50AAAAAAAACgAAAAAAAAAVSWRlbnRpZmllckFscmVhZHlVc2VkAAAAAAAACwAAAAAAAAAPQ291bnRlck92ZXJmbG93AAAAAAwAAAAAAAAAEkJ1ZGdldE5vdGVOb3RGb3VuZAAAAAAADQAAAAAAAAASQnVkZ2V0Tm9kZU5vdEZvdW5kAAAAAAAOAAAAAAAAABJJbnZhbGlkQnVkZ2V0T3duZXIAAAAAAA8AAAAAAAAAD0J1ZGdldE5vdGVTcGVudAAAAAAQAAAAAAAAABBJbnZhbGlkTm9kZVN0YXRlAAAAEQAAAAAAAAAMQnJhbmNoRnJvemVuAAAAEgAAAAAAAAASSW52YWxpZENoaWxkUG9saWN5AAAAAAATAAAAAAAAABNJbnZhbGlkQ29uc2VydmF0aW9uAAAAABQAAAAAAAAAE0ludmFsaWRBZ2VudEFjY291bnQAAAAAFQAAAAAAAAATQnVkZ2V0U3RhdGVNaXNtYXRjaAAAAAAWAAAAAAAAABZJbnZhbGlkQWRkcmVzc0VuY29kaW5nAAAAAAAXAAAAAAAAAAxJbnZhbGlkUHJvb2YAAAAYAAAAAAAAABJBdWRpdFN0YXRlTm90Rm91bmQAAAAAABkAAAAAAAAAFVBheW1lbnRBbHJlYWR5U2V0dGxlZAAAAAAAABoAAAAAAAAAE1Byb3ZpZGVyTm90QXBwcm92ZWQAAAAAGwAAAAAAAAASQ2F0ZWdvcnlOb3RBbGxvd2VkAAAAAAAcAAAAAAAAABBBY3Rpb25Ob3RBbGxvd2VkAAAAHQAAAAAAAAASQXVkaXRTdGF0ZU1pc21hdGNoAAAAAAAeAAAAAAAAABNSZXNlcnZhdGlvbk5vdEZvdW5kAAAAAB8AAAAAAAAAGFJlc2VydmF0aW9uQWxyZWFkeUV4aXN0cwAAACAAAAAAAAAAFVZvdWNoZXJLZXlBbHJlYWR5VXNlZAAAAAAAACEAAAAAAAAAEkludmFsaWRSZXNlcnZhdGlvbgAAAAAAIgAAAAAAAAAOSW52YWxpZFZvdWNoZXIAAAAAACMAAAAAAAAAGEludmFsaWRQcml2YXRlU2V0dGxlbWVudAAAACQ=",
        "AAAABQAAAAAAAAAAAAAAClJvb3RGdW5kZWQAAAAAAAIAAAAGcGhsb2VtAAAAAAALcm9vdF9mdW5kZWQAAAAABAAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAD7gAAACAAAAABAAAAAAAAAAxyb290X25vZGVfaWQAAAPuAAAAIAAAAAAAAAAAAAAADHJvb3Rfbm90ZV9pZAAAA+4AAAAgAAAAAAAAAAAAAAAOZnVuZGluZ19hbW91bnQAAAAAAAYAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADlBheW1lbnRTZXR0bGVkAAAAAAACAAAABnBobG9lbQAAAAAAD3BheW1lbnRfc2V0dGxlZAAAAAAJAAAAAAAAAApwYXltZW50X2lkAAAAAAPuAAAAIAAAAAEAAAAAAAAACnNlc3Npb25faWQAAAAAA+4AAAAgAAAAAQAAAAAAAAAVc291cmNlX2J1ZGdldF9ub3RlX2lkAAAAAAAD7gAAACAAAAAAAAAAAAAAABhyZW1haW5kZXJfYnVkZ2V0X25vdGVfaWQAAAPoAAAD7gAAACAAAAAAAAAAAAAAAA1hbW91bnRfYXRvbWljAAAAAAAABgAAAAAAAAAAAAAACHByb3ZpZGVyAAAAEwAAAAAAAAAAAAAAC2NhdGVnb3J5X2lkAAAAAAQAAAAAAAAAAAAAAA5zZXR0bGVtZW50X3JlZgAAAAAD7gAAACAAAAAAAAAAAAAAAAZzdGF0dXMAAAAAB9AAAAANUGF5bWVudFN0YXR1cwAAAAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADlByaXZhdGVTZXR0bGVkAAAAAAACAAAABnBobG9lbQAAAAAAD3ByaXZhdGVfc2V0dGxlZAAAAAAKAAAAAAAAAA5yZXNlcnZhdGlvbl9pZAAAAAAD7gAAACAAAAABAAAAAAAAAApzZXNzaW9uX2lkAAAAAAPuAAAAIAAAAAEAAAAAAAAAFXJlZnVuZF9idWRnZXRfbm90ZV9pZAAAAAAAA+gAAAPuAAAAIAAAAAAAAAAAAAAAEHZvdWNoZXJfc2VxdWVuY2UAAAAGAAAAAAAAAAAAAAAKdXNhZ2Vfcm9vdAAAAAAADAAAAAAAAAAAAAAAHnByb3ZpZGVyX3NwcF9vdXRwdXRfY29tbWl0bWVudAAAAAAADAAAAAAAAAAAAAAAHHNwcF9yZWZ1bmRfb3V0cHV0X2NvbW1pdG1lbnQAAAAMAAAAAAAAAAAAAAAabmV3X2F1ZGl0X3RvdGFsX2NvbW1pdG1lbnQAAAAAAAwAAAAAAAAAAAAAAA5zZXR0bGVtZW50X3JlZgAAAAAD7gAAACAAAAAAAAAAAAAAAAZzdGF0dXMAAAAAB9AAAAANUGF5bWVudFN0YXR1cwAAAAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADlNlc3Npb25DcmVhdGVkAAAAAAACAAAABnBobG9lbQAAAAAAD3Nlc3Npb25fY3JlYXRlZAAAAAAFAAAAAAAAAApzZXNzaW9uX2lkAAAAAAPuAAAAIAAAAAEAAAAAAAAAB2NvbXBhbnkAAAAAEwAAAAEAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAAAAAAAAAAAD3NldHRsZW1lbnRfbW9kZQAAAAfQAAAADlNldHRsZW1lbnRNb2RlAAAAAAAAAAAAAAAAABFleHBpcmVzX2F0X2xlZGdlcgAAAAAAAAQAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAD0J1ZGdldERlbGVnYXRlZAAAAAACAAAABnBobG9lbQAAAAAAEGJ1ZGdldF9kZWxlZ2F0ZWQAAAAGAAAAAAAAAApzZXNzaW9uX2lkAAAAAAPuAAAAIAAAAAEAAAAAAAAADWNoaWxkX25vZGVfaWQAAAAAAAPuAAAAIAAAAAEAAAAAAAAADnNvdXJjZV9ub3RlX2lkAAAAAAPuAAAAIAAAAAAAAAAAAAAADWNoaWxkX25vdGVfaWQAAAAAAAPuAAAAIAAAAAAAAAAAAAAAEXJlbWFpbmRlcl9ub3RlX2lkAAAAAAAD6AAAA+4AAAAgAAAAAAAAAAAAAAAQZGVsZWdhdGVkX2Ftb3VudAAAAAYAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAD1ByaXZhdGVSZXNlcnZlZAAAAAACAAAABnBobG9lbQAAAAAAEHByaXZhdGVfcmVzZXJ2ZWQAAAAHAAAAAAAAAA5yZXNlcnZhdGlvbl9pZAAAAAAD7gAAACAAAAABAAAAAAAAAApzZXNzaW9uX2lkAAAAAAPuAAAAIAAAAAEAAAAAAAAAFXNvdXJjZV9idWRnZXRfbm90ZV9pZAAAAAAAA+4AAAAgAAAAAAAAAAAAAAAYcmVtYWluZGVyX2J1ZGdldF9ub3RlX2lkAAAD6AAAA+4AAAAgAAAAAAAAAAAAAAALY2F0ZWdvcnlfaWQAAAAABAAAAAAAAAAAAAAAFWNsYWltX2RlYWRsaW5lX2xlZGdlcgAAAAAAAAQAAAAAAAAAAAAAAAZzdGF0dXMAAAAAB9AAAAAYUHJpdmF0ZVJlc2VydmF0aW9uU3RhdHVzAAAAAAAAAAI=",
        "AAAAAQAAAAAAAAAAAAAAB1Nlc3Npb24AAAAAFAAAAAAAAAAWYXBwcm92ZWRfcHJvdmlkZXJfcm9vdAAAAAAADAAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAAAAAA9hdWRpdF9maW5hbGl6ZWQAAAAAAQAAAAAAAAANYXVkaXRfdmVyc2lvbgAAAAAAAAQAAAAAAAAAF2NhdGVnb3J5X3NjaGVtYV92ZXJzaW9uAAAAAAQAAAAAAAAAB2NvbXBhbnkAAAAAEwAAAAAAAAARY3JlYXRlZF9hdF9sZWRnZXIAAAAAAAAEAAAAAAAAABhjcmVhdGVkX3Byb3RvY29sX3ZlcnNpb24AAAAEAAAAAAAAABFleHBpcmVzX2F0X2xlZGdlcgAAAAAAAAQAAAAAAAAAGWZpbmFsX2F1ZGl0X3NuYXBzaG90X2hhc2gAAAAAAAPoAAAD7gAAACAAAAAAAAAAAmlkAAAAAAPuAAAAIAAAAAAAAAAJbGlmZWN5Y2xlAAAAAAAH0AAAABBTZXNzaW9uTGlmZWN5Y2xlAAAAAAAAAAtwb2xpY3lfaGFzaAAAAAAMAAAAAAAAABNyb290X2J1ZGdldF9ub2RlX2lkAAAAA+gAAAPuAAAAIAAAAAAAAAATcm9vdF9idWRnZXRfbm90ZV9pZAAAAAPoAAAD7gAAACAAAAAAAAAABnNhZmV0eQAAAAAH0AAAAAtTYWZldHlTdGF0ZQAAAAAAAAAAEHNldHRsZW1lbnRfY291bnQAAAAGAAAAAAAAAA9zZXR0bGVtZW50X21vZGUAAAAH0AAAAA5TZXR0bGVtZW50TW9kZQAAAAAAAAAAABt0cmVhc3VyeV9zcHBfa2V5X2NvbW1pdG1lbnQAAAAD6AAAAAwAAAAAAAAAHHVucmVzb2x2ZWRfcmVzZXJ2YXRpb25fY291bnQAAAAG",
        "AAAAAQAAAAAAAAAAAAAACFNwcFByb29mAAAACQAAAAAAAAATYXNwX21lbWJlcnNoaXBfcm9vdAAAAAAMAAAAAAAAABdhc3Bfbm9uX21lbWJlcnNoaXBfcm9vdAAAAAAMAAAAAAAAAA1leHRfZGF0YV9oYXNoAAAAAAAD7gAAACAAAAAAAAAAEGlucHV0X251bGxpZmllcnMAAAPqAAAADAAAAAAAAAASb3V0cHV0X2NvbW1pdG1lbnQwAAAAAAAMAAAAAAAAABJvdXRwdXRfY29tbWl0bWVudDEAAAAAAAwAAAAAAAAABXByb29mAAAAAAAH0AAAAAxHcm90aDE2UHJvb2YAAAAAAAAADXB1YmxpY19hbW91bnQAAAAAAAAMAAAAAAAAAARyb290AAAADA==",
        "AAAAAQAAAAAAAAAAAAAACkJ1ZGdldE5vZGUAAAAAAAkAAAAAAAAADWJyYW5jaF9mcm96ZW4AAAAAAAABAAAAAAAAABFjcmVhdGVkX2F0X2xlZGdlcgAAAAAAAAQAAAAAAAAABWRlcHRoAAAAAAAABAAAAAAAAAACaWQAAAAAA+4AAAAgAAAAAAAAAAtub2RlX3BvbGljeQAAAAfQAAAACk5vZGVQb2xpY3kAAAAAAAAAAAAFb3duZXIAAAAAAAfQAAAAD0J1ZGdldE5vZGVPd25lcgAAAAAAAAAADnBhcmVudF9ub2RlX2lkAAAAAAPoAAAD7gAAACAAAAAAAAAACnNlc3Npb25faWQAAAAAA+4AAAAgAAAAAAAAAAVzdGF0ZQAAAAAAB9AAAAAPQnVkZ2V0Tm9kZVN0YXRlAA==",
        "AAAAAQAAAAAAAAAAAAAACk5vZGVQb2xpY3kAAAAAAAQAAAAAAAAAFGFsbG93ZWRfYWN0aW9uc19tYXNrAAAABgAAAAAAAAANY2F0ZWdvcnlfbWFzawAAAAAAAAYAAAAAAAAABmV4cGlyeQAAAAAABAAAAAAAAAAacmVtYWluaW5nX2RlbGVnYXRpb25fZGVwdGgAAAAAAAQ=",
        "AAAAAQAAAAAAAAAAAAAAClNwcEV4dERhdGEAAAAAAAQAAAAAAAAAEWVuY3J5cHRlZF9vdXRwdXQwAAAAAAAADgAAAAAAAAARZW5jcnlwdGVkX291dHB1dDEAAAAAAAAOAAAAAAAAAApleHRfYW1vdW50AAAAAAANAAAAAAAAAAlyZWNpcGllbnQAAAAAAAAT",
        "AAAAAgAAAAAAAAAAAAAAC1NhZmV0eVN0YXRlAAAAAAIAAAAAAAAAAAAAAAZOb3JtYWwAAAAAAAAAAAAAAAAABkZyb3plbgAA",
        "AAAAAQAAAAAAAAAAAAAADEdyb3RoMTZQcm9vZgAAAAMAAAAAAAAAAWEAAAAAAAPuAAAAQAAAAAAAAAABYgAAAAAAA+4AAACAAAAAAAAAAAFjAAAAAAAD7gAAAEA=",
        "AAAAAQAAAAAAAAAAAAAADVBheW1lbnRSZWNvcmQAAAAAAAAMAAAAAAAAAA1hbW91bnRfYXRvbWljAAAAAAAABgAAAAAAAAALY2F0ZWdvcnlfaWQAAAAABAAAAAAAAAAUb2ZmZXJfcmVmZXJlbmNlX2hhc2gAAAPuAAAAIAAAAAAAAAAKcGF5bWVudF9pZAAAAAAD7gAAACAAAAAAAAAACHByb3ZpZGVyAAAAEwAAAAAAAAAYcmVtYWluZGVyX2J1ZGdldF9ub3RlX2lkAAAD6AAAA+4AAAAgAAAAAAAAAApzZXNzaW9uX2lkAAAAAAPuAAAAIAAAAAAAAAARc2V0dGxlZF9hdF9sZWRnZXIAAAAAAAAEAAAAAAAAAA5zZXR0bGVtZW50X3JlZgAAAAAD7gAAACAAAAAAAAAAFXNvdXJjZV9idWRnZXRfbm90ZV9pZAAAAAAAA+4AAAAgAAAAAAAAAAZzdGF0dXMAAAAAB9AAAAANUGF5bWVudFN0YXR1cwAAAAAAAAAAAAAKdXNhZ2Vfcm9vdAAAAAAADA==",
        "AAAAAgAAAAAAAAAAAAAADVBheW1lbnRTdGF0dXMAAAAAAAABAAAAAAAAAAAAAAAHU2V0dGxlZAA=",
        "AAAAAQAAAAAAAAAAAAAADVNlc3Npb25Qb2xpY3kAAAAAAAAJAAAAAAAAABRhbGxvd2VkX2FjdGlvbnNfbWFzawAAAAYAAAAAAAAAFmFwcHJvdmVkX3Byb3ZpZGVyX3Jvb3QAAAAAAAwAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAAAAAAXY2F0ZWdvcnlfc2NoZW1hX3ZlcnNpb24AAAAABAAAAAAAAAAUbWF4X2RlbGVnYXRpb25fZGVwdGgAAAAEAAAAAAAAAAtwb2xpY3lfaGFzaAAAAAAMAAAAAAAAAA5zZXNzaW9uX2V4cGlyeQAAAAAABAAAAAAAAAAPc2V0dGxlbWVudF9tb2RlAAAAB9AAAAAOU2V0dGxlbWVudE1vZGUAAAAAAAAAAAAHdmVyc2lvbgAAAAAE",
        "AAAAAQAAAAAAAAAAAAAADlByaXZhdGVWb3VjaGVyAAAAAAALAAAAAAAAABxjdW11bGF0aXZlX2Ftb3VudF9jb21taXRtZW50AAAADAAAAAAAAAANZXhwaXJ5X2xlZGdlcgAAAAAAAAQAAAAAAAAACm5ldHdvcmtfaWQAAAAAA+4AAAAgAAAAAAAAABBvZmZlcl9jb21taXRtZW50AAAADAAAAAAAAAAQcHJvdG9jb2xfdmVyc2lvbgAAAAQAAAAAAAAADnJlc2VydmF0aW9uX2lkAAAAAAPuAAAAIAAAAAAAAAAIc2VxdWVuY2UAAAAGAAAAAAAAAApzZXNzaW9uX2lkAAAAAAPuAAAAIAAAAAAAAAATdHJlYXN1cnlfY29udHJvbGxlcgAAAAATAAAAAAAAAAp1c2FnZV9yb290AAAAAAAMAAAAAAAAAA92b3VjaGVyX3ZlcnNpb24AAAAABA==",
        "AAAAAgAAAAAAAAAAAAAADlNldHRsZW1lbnRNb2RlAAAAAAACAAAAAAAAAAAAAAAIU3RhbmRhcmQAAAAAAAAAAAAAAAdQcml2YXRlAA==",
        "AAAAAgAAAAAAAAAAAAAAD0J1ZGdldE5vZGVPd25lcgAAAAACAAAAAAAAAAAAAAALUm9vdENvbXBhbnkAAAAAAQAAAAAAAAARQWdlbnRTbWFydEFjY291bnQAAAAAAAABAAAAEw==",
        "AAAAAgAAAAAAAAAAAAAAD0J1ZGdldE5vZGVTdGF0ZQAAAAACAAAAAAAAAAAAAAAGQWN0aXZlAAAAAAAAAAAAAAAAAAhEaXNhYmxlZA==",
        "AAAAAQAAAAAAAAAAAAAAD0J1ZGdldE5vdGVTdGF0ZQAAAAAJAAAAAAAAAApjb21taXRtZW50AAAAAAAMAAAAAAAAABFjcmVhdGVkX2F0X2xlZGdlcgAAAAAAAAQAAAAAAAAAAmlkAAAAAAPuAAAAIAAAAAAAAAAHbm9kZV9pZAAAAAPuAAAAIAAAAAAAAAAFb3duZXIAAAAAAAfQAAAAD0J1ZGdldE5vZGVPd25lcgAAAAAAAAAAC3BvbGljeV9oYXNoAAAAAAwAAAAAAAAACnNlc3Npb25faWQAAAAAA+4AAAAgAAAAAAAAAA9zcGVudF9hdF9sZWRnZXIAAAAD6AAAAAQAAAAAAAAABXN0YXRlAAAAAAAH0AAAABBCdWRnZXROb3RlU3RhdHVz",
        "AAAAAgAAAAAAAAAAAAAAEEJ1ZGdldE5vdGVTdGF0dXMAAAACAAAAAAAAAAAAAAAGQWN0aXZlAAAAAAAAAAAAAAAAAAVTcGVudAAAAA==",
        "AAAAAgAAAAAAAAAAAAAAEFNlc3Npb25MaWZlY3ljbGUAAAAGAAAAAAAAAAAAAAAFRHJhZnQAAAAAAAAAAAAAAAAAAAdGdW5kaW5nAAAAAAAAAAAAAAAABkFjdGl2ZQAAAAAAAAAAAAAAAAAIRHJhaW5pbmcAAAAAAAAAAAAAAAZDbG9zZWQAAAAAAAAAAAAAAAAACUNhbmNlbGxlZAAAAA==",
        "AAAAAQAAAAAAAAAAAAAAEVNlc3Npb25BdWRpdFN0YXRlAAAAAAAACQAAAAAAAAANYXVkaXRfdmVyc2lvbgAAAAAAAAQAAAAAAAAAE2ZpbmFsX3NuYXBzaG90X2hhc2gAAAAD6AAAA+4AAAAgAAAAAAAAAAlmaW5hbGl6ZWQAAAAAAAABAAAAAAAAAAtwb2xpY3lfaGFzaAAAAAAMAAAAAAAAAApzZXNzaW9uX2lkAAAAAAPuAAAAIAAAAAAAAAAQc2V0dGxlbWVudF9jb3VudAAAAAYAAAAAAAAAG3N0YW5kYXJkX3RvdGFsX3NwZW5kX2F0b21pYwAAAAPoAAAABgAAAAAAAAAWdG90YWxfc3BlbmRfY29tbWl0bWVudAAAAAAADAAAAAAAAAAcdW5yZXNvbHZlZF9yZXNlcnZhdGlvbl9jb3VudAAAAAY=",
        "AAAAAQAAAAAAAAAAAAAAE1Jvb3RCdWRnZXROb3RlSW5wdXQAAAAAAwAAAAAAAAAKY29tbWl0bWVudAAAAAAADAAAAAAAAAAHbm9kZV9pZAAAAAPuAAAAIAAAAAAAAAAHbm90ZV9pZAAAAAPuAAAAIA==",
        "AAAAAQAAAAAAAAAAAAAAFFByaXZhdGVQYXltZW50UmVjb3JkAAAACwAAAAAAAAAWYXVkaXRfdG90YWxfY29tbWl0bWVudAAAAAAADAAAAAAAAAAecHJvdmlkZXJfc3BwX291dHB1dF9jb21taXRtZW50AAAAAAAMAAAAAAAAABVyZWZ1bmRfYnVkZ2V0X25vdGVfaWQAAAAAAAPoAAAD7gAAACAAAAAAAAAADnJlc2VydmF0aW9uX2lkAAAAAAPuAAAAIAAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAD7gAAACAAAAAAAAAAEXNldHRsZWRfYXRfbGVkZ2VyAAAAAAAABAAAAAAAAAAOc2V0dGxlbWVudF9yZWYAAAAAA+4AAAAgAAAAAAAAABxzcHBfcmVmdW5kX291dHB1dF9jb21taXRtZW50AAAADAAAAAAAAAAGc3RhdHVzAAAAAAfQAAAADVBheW1lbnRTdGF0dXMAAAAAAAAAAAAACnVzYWdlX3Jvb3QAAAAAAAwAAAAAAAAAEHZvdWNoZXJfc2VxdWVuY2UAAAAG",
        "AAAAAQAAAAAAAAAAAAAAFlByaXZhdGVTZXR0bGVtZW50SW5wdXQAAAAAAAgAAAAAAAAADWJpbmRpbmdfcHJvb2YAAAAAAAfQAAAADEdyb3RoMTZQcm9vZgAAAAAAAAAabmV3X2F1ZGl0X3RvdGFsX2NvbW1pdG1lbnQAAAAAAAwAAAAAAAAAGHJlZnVuZF9idWRnZXRfY29tbWl0bWVudAAAA+gAAAAMAAAAAAAAABVyZWZ1bmRfYnVkZ2V0X25vdGVfaWQAAAAAAAPoAAAD7gAAACAAAAAAAAAADHNwcF9leHRfZGF0YQAAB9AAAAAKU3BwRXh0RGF0YQAAAAAAAAAAAAlzcHBfcHJvb2YAAAAAAAfQAAAACFNwcFByb29mAAAAAAAAAAd2b3VjaGVyAAAAB9AAAAAOUHJpdmF0ZVZvdWNoZXIAAAAAAAAAAAARdm91Y2hlcl9zaWduYXR1cmUAAAAAAAPuAAAAQA==",
        "AAAAAQAAAAAAAAAAAAAAF1ByaXZhdGVSZXNlcnZhdGlvbklucHV0AAAAAAsAAAAAAAAAEWFtb3VudF9jb21taXRtZW50AAAAAAAADAAAAAAAAAALY2F0ZWdvcnlfaWQAAAAABAAAAAAAAAAVY2xhaW1fZGVhZGxpbmVfbGVkZ2VyAAAAAAAABAAAAAAAAAAQb2ZmZXJfY29tbWl0bWVudAAAAAwAAAAAAAAAE3Byb3ZpZGVyX2NvbW1pdG1lbnQAAAAADAAAAAAAAAAYcmVtYWluZGVyX2J1ZGdldF9ub3RlX2lkAAAD6AAAA+4AAAAgAAAAAAAAABRyZW1haW5kZXJfY29tbWl0bWVudAAAA+gAAAAMAAAAAAAAAA5yZXNlcnZhdGlvbl9pZAAAAAAD7gAAACAAAAAAAAAACnNlc3Npb25faWQAAAAAA+4AAAAgAAAAAAAAABVzb3VyY2VfYnVkZ2V0X25vdGVfaWQAAAAAAAPuAAAAIAAAAAAAAAAZdm91Y2hlcl9zaWduZXJfcHVibGljX2tleQAAAAAAA+4AAAAg",
        "AAAAAQAAAAAAAAAAAAAAF1N0YW5kYXJkRGVsZWdhdGlvbklucHV0AAAAAAgAAAAAAAAAEGNoaWxkX2NvbW1pdG1lbnQAAAAMAAAAAAAAAA1jaGlsZF9ub2RlX2lkAAAAAAAD7gAAACAAAAAAAAAADWNoaWxkX25vdGVfaWQAAAAAAAPuAAAAIAAAAAAAAAALY2hpbGRfb3duZXIAAAAAEwAAAAAAAAAMY2hpbGRfcG9saWN5AAAH0AAAAApOb2RlUG9saWN5AAAAAAAAAAAAEGRlbGVnYXRlZF9hbW91bnQAAAAGAAAAAAAAABRyZW1haW5kZXJfY29tbWl0bWVudAAAA+gAAAAMAAAAAAAAABFyZW1haW5kZXJfbm90ZV9pZAAAAAAAA+gAAAPuAAAAIA==",
        "AAAAAQAAAAAAAAAAAAAAF1N0YW5kYXJkU2V0dGxlbWVudElucHV0AAAAAA0AAAAAAAAAGGFsbG93ZWRfc2V0dGxlbWVudF9tb2RlcwAAAAQAAAAAAAAADWFtb3VudF9hdG9taWMAAAAAAAAGAAAAAAAAAAtjYXRlZ29yeV9pZAAAAAAEAAAAAAAAABRvZmZlcl9yZWZlcmVuY2VfaGFzaAAAA+4AAAAgAAAAAAAAAApwYXltZW50X2lkAAAAAAPuAAAAIAAAAAAAAAAIcHJvdmlkZXIAAAATAAAAAAAAABdwcm92aWRlcl9zcHBfcHVibGljX2tleQAAAAAMAAAAAAAAABhyZW1haW5kZXJfYnVkZ2V0X25vdGVfaWQAAAPoAAAD7gAAACAAAAAAAAAAFHJlbWFpbmRlcl9jb21taXRtZW50AAAD6AAAAAwAAAAAAAAAD3NlcnZpY2VfaWRfaGFzaAAAAAPuAAAAIAAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAD7gAAACAAAAAAAAAAFXNvdXJjZV9idWRnZXRfbm90ZV9pZAAAAAAAA+4AAAAgAAAAAAAAAAp1c2FnZV9yb290AAAAAAAM",
        "AAAAAgAAAAAAAAAAAAAAGFByaXZhdGVSZXNlcnZhdGlvblN0YXR1cwAAAAQAAAAAAAAAAAAAAARPcGVuAAAAAAAAAAAAAAAHU2V0dGxlZAAAAAAAAAAAAAAAAAlSZWNsYWltZWQAAAAAAAAAAAAAAAAAAAdFeHBpcmVkAA==",
        "AAAAAQAAAAAAAAAAAAAAGVByaXZhdGVQYXltZW50UmVzZXJ2YXRpb24AAAAAAAAPAAAAAAAAABFhbW91bnRfY29tbWl0bWVudAAAAAAAAAwAAAAAAAAAFmFwcHJvdmVkX3Byb3ZpZGVyX3Jvb3QAAAAAAAwAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAAAAAALY2F0ZWdvcnlfaWQAAAAABAAAAAAAAAAVY2xhaW1fZGVhZGxpbmVfbGVkZ2VyAAAAAAAABAAAAAAAAAARY3JlYXRlZF9hdF9sZWRnZXIAAAAAAAAEAAAAAAAAAAJpZAAAAAAD7gAAACAAAAAAAAAAEG9mZmVyX2NvbW1pdG1lbnQAAAAMAAAAAAAAABNwcm92aWRlcl9jb21taXRtZW50AAAAAAwAAAAAAAAAGHJlc2VydmF0aW9uX2NvbnRleHRfaGFzaAAAAAwAAAAAAAAACnNlc3Npb25faWQAAAAAA+4AAAAgAAAAAAAAAAxzb3VyY2VfYWdlbnQAAAATAAAAAAAAAA5zb3VyY2Vfbm9kZV9pZAAAAAAD7gAAACAAAAAAAAAABnN0YXR1cwAAAAAH0AAAABhQcml2YXRlUmVzZXJ2YXRpb25TdGF0dXMAAAAAAAAAGXZvdWNoZXJfc2lnbmVyX3B1YmxpY19rZXkAAAAAAAPuAAAAIA==" ]),
      options
    )
  }
  public readonly fromJSON = {
    get_session: this.txFromJSON<Option<Session>>,
        get_spp_pool: this.txFromJSON<string>,
        create_session: this.txFromJSON<Buffer>,
        get_audit_state: this.txFromJSON<Option<SessionAuditState>>,
        get_budget_node: this.txFromJSON<Option<BudgetNode>>,
        get_budget_note: this.txFromJSON<Option<BudgetNoteState>>,
        get_payment_record: this.txFromJSON<Option<PaymentRecord>>,
        get_session_policy: this.txFromJSON<Option<SessionPolicy>>,
        get_standard_asset: this.txFromJSON<string>,
        delegate_standard_root: this.txFromJSON<null>,
        get_audit_context_hash: this.txFromJSON<u256>,
        settle_private_payment: this.txFromJSON<PrivatePaymentRecord>,
        verify_private_voucher: this.txFromJSON<boolean>,
        get_private_reservation: this.txFromJSON<Option<PrivatePaymentReservation>>,
        settle_standard_payment: this.txFromJSON<PaymentRecord>,
        delegate_standard_budget: this.txFromJSON<null>,
        get_provider_policy_leaf: this.txFromJSON<u256>,
        get_standard_note_amount: this.txFromJSON<Option<u64>>,
        open_private_reservation: this.txFromJSON<PrivatePaymentReservation>,
        activate_standard_session: this.txFromJSON<null>,
        get_private_payment_record: this.txFromJSON<Option<PrivatePaymentRecord>>,
        get_agent_account_wasm_hash: this.txFromJSON<Buffer>,
        get_budget_note_context_hash: this.txFromJSON<u256>,
        get_private_binding_verifier: this.txFromJSON<string>,
        get_budget_transition_verifier: this.txFromJSON<string>
  }
}