use soroban_sdk::{
    Address, Bytes, BytesN, I256, U256, Vec, contracterror, contracttype,
    crypto::bn254::{Bn254G1Affine, Bn254G2Affine},
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SettlementMode {
    Standard,
    Private,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionLifecycle {
    Draft,
    Funding,
    Active,
    Draining,
    Closed,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SafetyState {
    Normal,
    Frozen,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionPolicy {
    pub version: u32,
    pub asset: Address,
    pub settlement_mode: SettlementMode,
    pub approved_provider_root: U256,
    pub category_schema_version: u32,
    pub max_delegation_depth: u32,
    pub allowed_actions_mask: u64,
    pub session_expiry: u32,
    pub policy_hash: U256,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Session {
    pub id: BytesN<32>,
    pub company: Address,
    pub lifecycle: SessionLifecycle,
    pub safety: SafetyState,
    pub asset: Address,
    pub settlement_mode: SettlementMode,
    pub policy_hash: U256,
    pub approved_provider_root: U256,
    pub category_schema_version: u32,
    pub created_protocol_version: u32,
    pub created_at_ledger: u32,
    pub expires_at_ledger: u32,
    pub root_budget_node_id: Option<BytesN<32>>,
    pub root_budget_note_id: Option<BytesN<32>>,
    pub treasury_spp_key_commitment: Option<U256>,
    pub settlement_count: u64,
    pub unresolved_reservation_count: u64,
    pub audit_version: u32,
    pub audit_finalized: bool,
    pub final_audit_snapshot_hash: Option<BytesN<32>>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BudgetNodeOwner {
    RootCompany,
    AgentSmartAccount(Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodePolicy {
    pub category_mask: u64,
    pub allowed_actions_mask: u64,
    pub expiry: u32,
    pub remaining_delegation_depth: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BudgetNodeState {
    Active,
    Disabled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BudgetNode {
    pub id: BytesN<32>,
    pub session_id: BytesN<32>,
    pub parent_node_id: Option<BytesN<32>>,
    pub owner: BudgetNodeOwner,
    pub depth: u32,
    pub node_policy: NodePolicy,
    pub branch_frozen: bool,
    pub created_at_ledger: u32,
    pub state: BudgetNodeState,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BudgetNoteStatus {
    Active,
    Spent,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BudgetNoteState {
    pub id: BytesN<32>,
    pub session_id: BytesN<32>,
    pub node_id: BytesN<32>,
    pub owner: BudgetNodeOwner,
    pub policy_hash: U256,
    pub commitment: U256,
    pub state: BudgetNoteStatus,
    pub created_at_ledger: u32,
    pub spent_at_ledger: Option<u32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RootBudgetNoteInput {
    pub node_id: BytesN<32>,
    pub note_id: BytesN<32>,
    pub commitment: U256,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrivateRootBackingInput {
    pub root_note: RootBudgetNoteInput,
    pub funding_amount: u64,
    pub initial_audit_total_commitment: U256,
    pub treasury_spp_key_commitment: U256,
    pub spp_proof: SppProof,
    pub spp_ext_data: SppExtData,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StandardDelegationInput {
    pub child_node_id: BytesN<32>,
    pub child_note_id: BytesN<32>,
    pub child_owner: Address,
    pub child_policy: NodePolicy,
    pub child_commitment: U256,
    pub delegated_amount: u64,
    pub remainder_note_id: Option<BytesN<32>>,
    pub remainder_commitment: Option<U256>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StandardSettlementInput {
    pub payment_id: BytesN<32>,
    pub session_id: BytesN<32>,
    pub source_budget_note_id: BytesN<32>,
    pub amount_atomic: u64,
    pub provider: Address,
    pub provider_spp_public_key: U256,
    pub service_id_hash: BytesN<32>,
    pub category_id: u32,
    pub allowed_settlement_modes: u32,
    pub usage_root: U256,
    pub offer_reference_hash: BytesN<32>,
    pub remainder_budget_note_id: Option<BytesN<32>>,
    pub remainder_commitment: Option<U256>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PrivateReservationStatus {
    Open,
    Settled,
    Reclaimed,
    Expired,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrivatePaymentReservation {
    pub id: BytesN<32>,
    pub session_id: BytesN<32>,
    pub source_node_id: BytesN<32>,
    pub source_agent: Address,
    pub asset: Address,
    pub category_id: u32,
    pub offer_commitment: U256,
    pub voucher_signer_public_key: BytesN<32>,
    pub amount_commitment: U256,
    pub provider_commitment: U256,
    pub approved_provider_root: U256,
    pub reservation_context_hash: U256,
    pub claim_deadline_ledger: u32,
    pub status: PrivateReservationStatus,
    pub created_at_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrivateReservationInput {
    pub reservation_id: BytesN<32>,
    pub session_id: BytesN<32>,
    pub source_budget_note_id: BytesN<32>,
    pub category_id: u32,
    pub offer_commitment: U256,
    pub voucher_signer_public_key: BytesN<32>,
    pub amount_commitment: U256,
    pub provider_commitment: U256,
    pub claim_deadline_ledger: u32,
    pub remainder_budget_note_id: Option<BytesN<32>>,
    pub remainder_commitment: Option<U256>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrivateVoucher {
    pub protocol_version: u32,
    pub voucher_version: u32,
    pub network_id: BytesN<32>,
    pub treasury_controller: Address,
    pub session_id: BytesN<32>,
    pub reservation_id: BytesN<32>,
    pub sequence: u64,
    pub cumulative_amount_commitment: U256,
    pub usage_root: U256,
    pub offer_commitment: U256,
    pub expiry_ledger: u32,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum SppPoolError {
    NotAuthorized = 1,
    MerkleTreeFull = 2,
    AlreadyInitialized = 3,
    WrongLevels = 4,
    NextIndexNotEven = 5,
    WrongExtAmount = 6,
    InvalidProof = 7,
    UnknownRoot = 8,
    AlreadySpentNullifier = 9,
    WrongExtHash = 10,
    NotInitialized = 11,
    Overflow = 12,
    NonCanonicalPublicInput = 13,
    InvalidPolicyFlags = 14,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SppProof {
    pub proof: Groth16Proof,
    pub root: U256,
    pub input_nullifiers: Vec<U256>,
    pub output_commitment0: U256,
    pub output_commitment1: U256,
    pub public_amount: U256,
    pub ext_data_hash: BytesN<32>,
    pub asp_membership_root: U256,
    pub asp_non_membership_root: U256,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SppExtData {
    pub recipient: Address,
    pub ext_amount: I256,
    pub encrypted_output0: Bytes,
    pub encrypted_output1: Bytes,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrivateSettlementInput {
    pub voucher: PrivateVoucher,
    pub voucher_signature: BytesN<64>,
    pub binding_proof: Groth16Proof,
    pub spp_proof: SppProof,
    pub spp_ext_data: SppExtData,
    pub new_audit_total_commitment: U256,
    pub refund_budget_note_id: Option<BytesN<32>>,
    pub refund_budget_commitment: Option<U256>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrivatePaymentRecord {
    pub reservation_id: BytesN<32>,
    pub session_id: BytesN<32>,
    pub refund_budget_note_id: Option<BytesN<32>>,
    pub voucher_sequence: u64,
    pub usage_root: U256,
    pub provider_spp_output_commitment: U256,
    pub spp_refund_output_commitment: U256,
    pub audit_total_commitment: U256,
    pub settlement_ref: BytesN<32>,
    pub status: PaymentStatus,
    pub settled_at_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PaymentStatus {
    Settled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentRecord {
    pub payment_id: BytesN<32>,
    pub session_id: BytesN<32>,
    pub source_budget_note_id: BytesN<32>,
    pub remainder_budget_note_id: Option<BytesN<32>>,
    pub amount_atomic: u64,
    pub provider: Address,
    pub category_id: u32,
    pub usage_root: U256,
    pub offer_reference_hash: BytesN<32>,
    pub settlement_ref: BytesN<32>,
    pub status: PaymentStatus,
    pub settled_at_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Groth16Proof {
    pub a: Bn254G1Affine,
    pub b: Bn254G2Affine,
    pub c: Bn254G1Affine,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionAuditState {
    pub session_id: BytesN<32>,
    pub total_spend_commitment: U256,
    pub settlement_count: u64,
    pub unresolved_reservation_count: u64,
    pub audit_version: u32,
    pub policy_hash: U256,
    pub finalized: bool,
    pub final_snapshot_hash: Option<BytesN<32>>,
    pub standard_total_spend_atomic: Option<u64>,
}
