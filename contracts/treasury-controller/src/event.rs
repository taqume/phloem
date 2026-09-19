use soroban_sdk::{Address, BytesN, contractevent};

use crate::{PaymentStatus, PrivateReservationStatus, SettlementMode};

#[contractevent(topics = ["phloem", "session_created"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionCreated {
    #[topic]
    pub session_id: BytesN<32>,
    #[topic]
    pub company: Address,
    pub asset: Address,
    pub settlement_mode: SettlementMode,
    pub expires_at_ledger: u32,
}

#[contractevent(topics = ["phloem", "root_funded"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RootFunded {
    #[topic]
    pub session_id: BytesN<32>,
    pub root_node_id: BytesN<32>,
    pub root_note_id: BytesN<32>,
    pub funding_amount: u64,
}

#[contractevent(topics = ["phloem", "budget_delegated"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BudgetDelegated {
    #[topic]
    pub session_id: BytesN<32>,
    #[topic]
    pub child_node_id: BytesN<32>,
    pub source_note_id: BytesN<32>,
    pub child_note_id: BytesN<32>,
    pub remainder_note_id: Option<BytesN<32>>,
    pub delegated_amount: u64,
}

#[contractevent(topics = ["phloem", "payment_settled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentSettled {
    #[topic]
    pub payment_id: BytesN<32>,
    #[topic]
    pub session_id: BytesN<32>,
    pub source_budget_note_id: BytesN<32>,
    pub remainder_budget_note_id: Option<BytesN<32>>,
    pub amount_atomic: u64,
    pub provider: Address,
    pub category_id: u32,
    pub settlement_ref: BytesN<32>,
    pub status: PaymentStatus,
}

#[contractevent(topics = ["phloem", "private_reserved"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrivateReserved {
    #[topic]
    pub reservation_id: BytesN<32>,
    #[topic]
    pub session_id: BytesN<32>,
    pub source_budget_note_id: BytesN<32>,
    pub remainder_budget_note_id: Option<BytesN<32>>,
    pub category_id: u32,
    pub claim_deadline_ledger: u32,
    pub status: PrivateReservationStatus,
}
