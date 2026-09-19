#![no_std]

mod error;
mod event;
mod storage;
mod types;

pub use error::Error;
pub use types::{
    BudgetNode, BudgetNodeOwner, BudgetNodeState, BudgetNoteState, BudgetNoteStatus, NodePolicy,
    RootBudgetNoteInput, SafetyState, Session, SessionLifecycle, SessionPolicy, SettlementMode,
};

use soroban_sdk::{
    Address, Bytes, BytesN, Env, U256, contract, contractimpl, panic_with_error, token, xdr::ToXdr,
};

use crate::{
    event::{RootFunded, SessionCreated},
    storage::{
        Config, DataKey, extend_instance_ttl, extend_persistent_ttl, get_config,
        get_next_session_nonce, increment_session_nonce,
    },
};

const PROTOCOL_VERSION: u32 = 1;
const POLICY_VERSION: u32 = 1;
const MAX_DELEGATION_DEPTH: u32 = 3;

#[contract]
pub struct TreasuryController;

#[contractimpl]
impl TreasuryController {
    pub fn __constructor(env: Env, standard_asset: Address) {
        env.storage()
            .instance()
            .set(&DataKey::Config, &Config { standard_asset });
        env.storage()
            .instance()
            .set(&DataKey::NextSessionNonce, &0u64);
    }

    pub fn create_session(
        env: Env,
        company: Address,
        asset: Address,
        settlement_mode: SettlementMode,
        draft_policy: SessionPolicy,
        expires_at: u32,
    ) -> BytesN<32> {
        company.require_auth();

        let current_ledger = env.ledger().sequence();
        validate_policy(
            &env,
            &asset,
            &settlement_mode,
            &draft_policy,
            expires_at,
            current_ledger,
        );

        let config = get_config(&env);
        if asset != config.standard_asset {
            panic_with_error!(&env, Error::AssetNotAllowed);
        }

        let nonce = get_next_session_nonce(&env);
        let session_id = derive_session_id(&env, &company, nonce);
        increment_session_nonce(&env, nonce);

        let session = Session {
            id: session_id.clone(),
            company: company.clone(),
            lifecycle: SessionLifecycle::Draft,
            safety: SafetyState::Normal,
            asset: asset.clone(),
            settlement_mode: settlement_mode.clone(),
            policy_hash: draft_policy.policy_hash.clone(),
            approved_provider_root: draft_policy.approved_provider_root.clone(),
            category_schema_version: draft_policy.category_schema_version,
            created_protocol_version: PROTOCOL_VERSION,
            created_at_ledger: current_ledger,
            expires_at_ledger: expires_at,
            root_budget_node_id: None,
            root_budget_note_id: None,
            settlement_count: 0,
            unresolved_reservation_count: 0,
            audit_version: 1,
            audit_finalized: false,
            final_audit_snapshot_hash: None,
        };

        let session_key = DataKey::Session(session_id.clone());
        let policy_key = DataKey::SessionPolicy(session_id.clone());
        env.storage().persistent().set(&session_key, &session);
        env.storage().persistent().set(&policy_key, &draft_policy);
        extend_persistent_ttl(&env, &session_key, expires_at);
        extend_persistent_ttl(&env, &policy_key, expires_at);
        extend_instance_ttl(&env, expires_at);

        SessionCreated {
            session_id: session_id.clone(),
            company,
            asset,
            settlement_mode,
            expires_at_ledger: expires_at,
        }
        .publish(&env);

        session_id
    }

    pub fn activate_standard_session(
        env: Env,
        session_id: BytesN<32>,
        root_note: RootBudgetNoteInput,
        funding_amount: u64,
    ) {
        let mut session = load_session_or_fail(&env, &session_id);
        session.company.require_auth();

        if session.lifecycle != SessionLifecycle::Draft {
            panic_with_error!(&env, Error::InvalidLifecycle);
        }
        if session.settlement_mode != SettlementMode::Standard {
            panic_with_error!(&env, Error::WrongSettlementMode);
        }
        if session.safety != SafetyState::Normal {
            panic_with_error!(&env, Error::SessionFrozen);
        }
        if env.ledger().sequence() >= session.expires_at_ledger {
            panic_with_error!(&env, Error::SessionExpired);
        }
        if funding_amount == 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        validate_field(&env, &root_note.commitment);

        let node_key = DataKey::BudgetNode(root_note.node_id.clone());
        let note_key = DataKey::BudgetNote(root_note.note_id.clone());
        let amount_key = DataKey::StandardNoteAmount(root_note.note_id.clone());
        if root_note.node_id == root_note.note_id
            || env.storage().persistent().has(&node_key)
            || env.storage().persistent().has(&note_key)
            || env.storage().persistent().has(&amount_key)
        {
            panic_with_error!(&env, Error::IdentifierAlreadyUsed);
        }

        let policy = load_policy_or_fail(&env, &session_id);
        let root_node = BudgetNode {
            id: root_note.node_id.clone(),
            session_id: session_id.clone(),
            parent_node_id: None,
            owner: BudgetNodeOwner::RootCompany,
            depth: 0,
            node_policy: NodePolicy {
                category_mask: u64::MAX,
                allowed_actions_mask: policy.allowed_actions_mask,
                expiry: policy.session_expiry,
                remaining_delegation_depth: policy.max_delegation_depth,
            },
            branch_frozen: false,
            created_at_ledger: env.ledger().sequence(),
            state: BudgetNodeState::Active,
        };
        let budget_note = BudgetNoteState {
            id: root_note.note_id.clone(),
            session_id: session_id.clone(),
            node_id: root_note.node_id.clone(),
            owner: BudgetNodeOwner::RootCompany,
            policy_hash: session.policy_hash.clone(),
            commitment: root_note.commitment,
            state: BudgetNoteStatus::Active,
            created_at_ledger: env.ledger().sequence(),
            spent_at_ledger: None,
        };

        // The outer company authorization and the nested SAC authorization are
        // intentionally in the same invocation tree. A failed token transfer or
        // any later failure rolls the entire activation back.
        token::Client::new(&env, &session.asset).transfer(
            &session.company,
            env.current_contract_address(),
            &(funding_amount as i128),
        );

        session.lifecycle = SessionLifecycle::Active;
        session.root_budget_node_id = Some(root_note.node_id.clone());
        session.root_budget_note_id = Some(root_note.note_id.clone());

        let session_key = DataKey::Session(session_id.clone());
        env.storage().persistent().set(&node_key, &root_node);
        env.storage().persistent().set(&note_key, &budget_note);
        env.storage().persistent().set(&amount_key, &funding_amount);
        env.storage().persistent().set(&session_key, &session);

        extend_persistent_ttl(&env, &node_key, session.expires_at_ledger);
        extend_persistent_ttl(&env, &note_key, session.expires_at_ledger);
        extend_persistent_ttl(&env, &amount_key, session.expires_at_ledger);
        extend_persistent_ttl(&env, &session_key, session.expires_at_ledger);
        extend_instance_ttl(&env, session.expires_at_ledger);

        RootFunded {
            session_id,
            root_node_id: root_note.node_id,
            root_note_id: root_note.note_id,
            funding_amount,
        }
        .publish(&env);
    }

    pub fn get_session(env: Env, session_id: BytesN<32>) -> Option<Session> {
        let key = DataKey::Session(session_id);
        let session: Option<Session> = env.storage().persistent().get(&key);
        if let Some(value) = &session {
            extend_persistent_ttl(&env, &key, value.expires_at_ledger);
        }
        session
    }

    pub fn get_session_policy(env: Env, session_id: BytesN<32>) -> Option<SessionPolicy> {
        let session = load_session_or_fail(&env, &session_id);
        let key = DataKey::SessionPolicy(session_id);
        let policy = env.storage().persistent().get(&key);
        extend_persistent_ttl(&env, &key, session.expires_at_ledger);
        policy
    }

    pub fn get_budget_node(env: Env, node_id: BytesN<32>) -> Option<BudgetNode> {
        env.storage()
            .persistent()
            .get(&DataKey::BudgetNode(node_id))
    }

    pub fn get_budget_note(env: Env, note_id: BytesN<32>) -> Option<BudgetNoteState> {
        env.storage()
            .persistent()
            .get(&DataKey::BudgetNote(note_id))
    }

    pub fn get_standard_note_amount(env: Env, note_id: BytesN<32>) -> Option<u64> {
        env.storage()
            .persistent()
            .get(&DataKey::StandardNoteAmount(note_id))
    }

    pub fn get_standard_asset(env: Env) -> Address {
        get_config(&env).standard_asset
    }
}

fn derive_session_id(env: &Env, company: &Address, nonce: u64) -> BytesN<32> {
    let domain = Bytes::from_slice(env, b"PHLOEM_SESSION_V1");
    let preimage = (
        domain,
        env.current_contract_address(),
        company.clone(),
        nonce,
    )
        .to_xdr(env);
    env.crypto().sha256(&preimage).to_bytes()
}

fn validate_policy(
    env: &Env,
    asset: &Address,
    settlement_mode: &SettlementMode,
    policy: &SessionPolicy,
    expires_at: u32,
    current_ledger: u32,
) {
    if expires_at <= current_ledger {
        panic_with_error!(env, Error::InvalidExpiry);
    }
    if policy.version != POLICY_VERSION
        || policy.asset != *asset
        || policy.settlement_mode != *settlement_mode
        || policy.session_expiry != expires_at
        || policy.max_delegation_depth == 0
        || policy.max_delegation_depth > MAX_DELEGATION_DEPTH
        || policy.allowed_actions_mask == 0
    {
        panic_with_error!(env, Error::InvalidPolicy);
    }
    validate_field(env, &policy.policy_hash);
    validate_field(env, &policy.approved_provider_root);
}

fn validate_field(env: &Env, value: &U256) {
    // BN254 scalar modulus:
    // 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
    let modulus = U256::from_parts(
        env,
        0x3064_4e72_e131_a029,
        0xb850_45b6_8181_585d,
        0x2833_e848_79b9_7091,
        0x43e1_f593_f000_0001,
    );
    if value >= &modulus {
        panic_with_error!(env, Error::NonCanonicalField);
    }
}

fn load_session_or_fail(env: &Env, session_id: &BytesN<32>) -> Session {
    env.storage()
        .persistent()
        .get(&DataKey::Session(session_id.clone()))
        .unwrap_or_else(|| panic_with_error!(env, Error::SessionNotFound))
}

fn load_policy_or_fail(env: &Env, session_id: &BytesN<32>) -> SessionPolicy {
    env.storage()
        .persistent()
        .get(&DataKey::SessionPolicy(session_id.clone()))
        .unwrap_or_else(|| panic_with_error!(env, Error::SessionNotFound))
}

#[cfg(test)]
mod test;
