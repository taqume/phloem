use soroban_sdk::{Address, BytesN, contractevent};

use crate::SettlementMode;

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
