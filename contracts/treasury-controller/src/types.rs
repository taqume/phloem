use soroban_sdk::{
    Address, BytesN, U256, contracttype,
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
