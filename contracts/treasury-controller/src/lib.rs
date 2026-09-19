#![no_std]

mod audit;
mod budget;
mod encoding;
mod error;
mod event;
pub mod poseidon2;
mod storage;
mod types;

pub use error::Error;
pub use types::{
    BudgetNode, BudgetNodeOwner, BudgetNodeState, BudgetNoteState, BudgetNoteStatus, NodePolicy,
    RootBudgetNoteInput, SafetyState, Session, SessionLifecycle, SessionPolicy, SettlementMode,
    StandardDelegationInput,
};

use soroban_sdk::{
    Address, Bytes, BytesN, Env, Executable, U256, contract, contractimpl, panic_with_error, token,
    xdr::ToXdr,
};

use crate::{
    event::{BudgetDelegated, RootFunded, SessionCreated},
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
    pub fn __constructor(env: Env, standard_asset: Address, agent_account_wasm_hash: BytesN<32>) {
        env.storage().instance().set(
            &DataKey::Config,
            &Config {
                standard_asset,
                agent_account_wasm_hash,
            },
        );
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

        if root_note.node_id == root_note.note_id {
            panic_with_error!(&env, Error::IdentifierAlreadyUsed);
        }
        ensure_budget_identifier_available(&env, &root_note.node_id);
        ensure_budget_identifier_available(&env, &root_note.note_id);

        let node_key = DataKey::BudgetNode(root_note.node_id.clone());
        let note_key = DataKey::BudgetNote(root_note.note_id.clone());
        let amount_key = DataKey::StandardNoteAmount(root_note.note_id.clone());

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

    pub fn delegate_standard_root(
        env: Env,
        session_id: BytesN<32>,
        source_note_id: BytesN<32>,
        delegation: StandardDelegationInput,
    ) {
        let session = load_session_or_fail(&env, &session_id);
        session.company.require_auth();

        let source_note = load_note_or_fail(&env, &source_note_id);
        let source_node = load_node_or_fail(&env, &source_note.node_id);
        if source_note.owner != BudgetNodeOwner::RootCompany
            || source_node.owner != BudgetNodeOwner::RootCompany
            || session.root_budget_node_id != Some(source_node.id.clone())
        {
            panic_with_error!(&env, Error::InvalidBudgetOwner);
        }

        delegate_standard(
            &env,
            &session,
            source_note,
            source_node,
            source_note_id,
            delegation,
        );
    }

    pub fn delegate_standard_budget(
        env: Env,
        session_id: BytesN<32>,
        source_note_id: BytesN<32>,
        delegation: StandardDelegationInput,
    ) {
        let session = load_session_or_fail(&env, &session_id);
        let source_note = load_note_or_fail(&env, &source_note_id);
        let source_node = load_node_or_fail(&env, &source_note.node_id);
        let owner = match &source_note.owner {
            BudgetNodeOwner::AgentSmartAccount(owner) => owner.clone(),
            BudgetNodeOwner::RootCompany => {
                panic_with_error!(&env, Error::InvalidBudgetOwner)
            }
        };
        if source_node.owner != source_note.owner {
            panic_with_error!(&env, Error::BudgetStateMismatch);
        }
        owner.require_auth();

        delegate_standard(
            &env,
            &session,
            source_note,
            source_node,
            source_note_id,
            delegation,
        );
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

    pub fn get_agent_account_wasm_hash(env: Env) -> BytesN<32> {
        get_config(&env).agent_account_wasm_hash
    }

    pub fn get_audit_context_hash(env: Env, session_id: BytesN<32>) -> U256 {
        let session = load_session_or_fail(&env, &session_id);
        if session.created_protocol_version != PROTOCOL_VERSION {
            panic_with_error!(&env, Error::BudgetStateMismatch);
        }
        audit::context_hash_v1(
            &env,
            &env.ledger().network_id(),
            &env.current_contract_address(),
            &session.id,
            &session.asset,
            &session.settlement_mode,
            &session.policy_hash,
        )
        .unwrap_or_else(|| panic_with_error!(&env, Error::InvalidAddressEncoding))
    }

    pub fn get_budget_note_context_hash(env: Env, note_id: BytesN<32>) -> U256 {
        let note = load_note_or_fail(&env, &note_id);
        let session = load_session_or_fail(&env, &note.session_id);
        if session.created_protocol_version != PROTOCOL_VERSION {
            panic_with_error!(&env, Error::BudgetStateMismatch);
        }
        let owner = match &note.owner {
            BudgetNodeOwner::RootCompany => session.company.clone(),
            BudgetNodeOwner::AgentSmartAccount(address) => address.clone(),
        };
        budget::context_hash_v1(
            &env,
            &budget::BudgetContextV1 {
                protocol_version: session.created_protocol_version,
                network_id: &env.ledger().network_id(),
                controller: &env.current_contract_address(),
                session_id: &note.session_id,
                node_id: &note.node_id,
                owner: &owner,
                asset: &session.asset,
                policy_hash: &note.policy_hash,
                note_id: &note.id,
            },
        )
        .unwrap_or_else(|| panic_with_error!(&env, Error::InvalidAddressEncoding))
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

fn load_node_or_fail(env: &Env, node_id: &BytesN<32>) -> BudgetNode {
    env.storage()
        .persistent()
        .get(&DataKey::BudgetNode(node_id.clone()))
        .unwrap_or_else(|| panic_with_error!(env, Error::BudgetNodeNotFound))
}

fn load_note_or_fail(env: &Env, note_id: &BytesN<32>) -> BudgetNoteState {
    env.storage()
        .persistent()
        .get(&DataKey::BudgetNote(note_id.clone()))
        .unwrap_or_else(|| panic_with_error!(env, Error::BudgetNoteNotFound))
}

fn delegate_standard(
    env: &Env,
    session: &Session,
    mut source_note: BudgetNoteState,
    source_node: BudgetNode,
    source_note_id: BytesN<32>,
    delegation: StandardDelegationInput,
) {
    validate_active_standard_source(env, session, &source_note, &source_node);
    validate_standard_delegation(env, session, &source_node, &source_note_id, &delegation);

    let source_amount_key = DataKey::StandardNoteAmount(source_note_id.clone());
    let source_amount: u64 = env
        .storage()
        .persistent()
        .get(&source_amount_key)
        .unwrap_or_else(|| panic_with_error!(env, Error::BudgetStateMismatch));
    let remainder_amount = source_amount
        .checked_sub(delegation.delegated_amount)
        .unwrap_or_else(|| panic_with_error!(env, Error::InvalidConservation));

    match (
        remainder_amount,
        &delegation.remainder_note_id,
        &delegation.remainder_commitment,
    ) {
        (0, None, None) => {}
        (0, _, _) | (_, None, _) | (_, _, None) => {
            panic_with_error!(env, Error::InvalidConservation)
        }
        (_, Some(_), Some(commitment)) => validate_field(env, commitment),
    }

    let current_ledger = env.ledger().sequence();
    let child_owner = BudgetNodeOwner::AgentSmartAccount(delegation.child_owner.clone());
    let child_node = BudgetNode {
        id: delegation.child_node_id.clone(),
        session_id: session.id.clone(),
        parent_node_id: Some(source_node.id.clone()),
        owner: child_owner.clone(),
        depth: source_node
            .depth
            .checked_add(1)
            .unwrap_or_else(|| panic_with_error!(env, Error::CounterOverflow)),
        node_policy: delegation.child_policy.clone(),
        branch_frozen: false,
        created_at_ledger: current_ledger,
        state: BudgetNodeState::Active,
    };
    let child_note = BudgetNoteState {
        id: delegation.child_note_id.clone(),
        session_id: session.id.clone(),
        node_id: delegation.child_node_id.clone(),
        owner: child_owner,
        policy_hash: session.policy_hash.clone(),
        commitment: delegation.child_commitment.clone(),
        state: BudgetNoteStatus::Active,
        created_at_ledger: current_ledger,
        spent_at_ledger: None,
    };

    source_note.state = BudgetNoteStatus::Spent;
    source_note.spent_at_ledger = Some(current_ledger);

    let source_note_key = DataKey::BudgetNote(source_note_id.clone());
    let child_node_key = DataKey::BudgetNode(delegation.child_node_id.clone());
    let child_note_key = DataKey::BudgetNote(delegation.child_note_id.clone());
    let child_amount_key = DataKey::StandardNoteAmount(delegation.child_note_id.clone());

    env.storage()
        .persistent()
        .set(&source_note_key, &source_note);
    env.storage().persistent().set(&child_node_key, &child_node);
    env.storage().persistent().set(&child_note_key, &child_note);
    env.storage()
        .persistent()
        .set(&child_amount_key, &delegation.delegated_amount);

    extend_persistent_ttl(env, &source_note_key, session.expires_at_ledger);
    extend_persistent_ttl(env, &source_amount_key, session.expires_at_ledger);
    extend_persistent_ttl(env, &child_node_key, session.expires_at_ledger);
    extend_persistent_ttl(env, &child_note_key, session.expires_at_ledger);
    extend_persistent_ttl(env, &child_amount_key, session.expires_at_ledger);

    if let (Some(remainder_note_id), Some(remainder_commitment)) = (
        &delegation.remainder_note_id,
        &delegation.remainder_commitment,
    ) {
        let remainder_note = BudgetNoteState {
            id: remainder_note_id.clone(),
            session_id: session.id.clone(),
            node_id: source_node.id.clone(),
            owner: source_node.owner.clone(),
            policy_hash: session.policy_hash.clone(),
            commitment: remainder_commitment.clone(),
            state: BudgetNoteStatus::Active,
            created_at_ledger: current_ledger,
            spent_at_ledger: None,
        };
        let remainder_note_key = DataKey::BudgetNote(remainder_note_id.clone());
        let remainder_amount_key = DataKey::StandardNoteAmount(remainder_note_id.clone());
        env.storage()
            .persistent()
            .set(&remainder_note_key, &remainder_note);
        env.storage()
            .persistent()
            .set(&remainder_amount_key, &remainder_amount);
        extend_persistent_ttl(env, &remainder_note_key, session.expires_at_ledger);
        extend_persistent_ttl(env, &remainder_amount_key, session.expires_at_ledger);
    }

    extend_instance_ttl(env, session.expires_at_ledger);
    BudgetDelegated {
        session_id: session.id.clone(),
        child_node_id: delegation.child_node_id,
        source_note_id,
        child_note_id: delegation.child_note_id,
        remainder_note_id: delegation.remainder_note_id,
        delegated_amount: delegation.delegated_amount,
    }
    .publish(env);
}

fn validate_active_standard_source(
    env: &Env,
    session: &Session,
    source_note: &BudgetNoteState,
    source_node: &BudgetNode,
) {
    let current_ledger = env.ledger().sequence();
    if session.lifecycle != SessionLifecycle::Active {
        panic_with_error!(env, Error::InvalidLifecycle);
    }
    if session.settlement_mode != SettlementMode::Standard {
        panic_with_error!(env, Error::WrongSettlementMode);
    }
    if session.safety != SafetyState::Normal {
        panic_with_error!(env, Error::SessionFrozen);
    }
    if current_ledger >= session.expires_at_ledger {
        panic_with_error!(env, Error::SessionExpired);
    }
    if source_note.state != BudgetNoteStatus::Active {
        panic_with_error!(env, Error::BudgetNoteSpent);
    }
    if source_node.state != BudgetNodeState::Active {
        panic_with_error!(env, Error::InvalidNodeState);
    }
    if source_node.branch_frozen {
        panic_with_error!(env, Error::BranchFrozen);
    }
    if source_node.node_policy.expiry <= current_ledger {
        panic_with_error!(env, Error::SessionExpired);
    }
    if source_note.session_id != session.id
        || source_node.session_id != session.id
        || source_note.node_id != source_node.id
        || source_note.owner != source_node.owner
        || source_note.policy_hash != session.policy_hash
    {
        panic_with_error!(env, Error::BudgetStateMismatch);
    }
}

fn validate_standard_delegation(
    env: &Env,
    session: &Session,
    source_node: &BudgetNode,
    source_note_id: &BytesN<32>,
    delegation: &StandardDelegationInput,
) {
    if delegation.delegated_amount == 0 {
        panic_with_error!(env, Error::InvalidAmount);
    }
    let config = get_config(env);
    if !matches!(
        delegation.child_owner.executable(),
        Some(Executable::Wasm(hash)) if hash == config.agent_account_wasm_hash
    ) {
        panic_with_error!(env, Error::InvalidAgentAccount);
    }
    validate_field(env, &delegation.child_commitment);

    let parent_policy = &source_node.node_policy;
    let child_policy = &delegation.child_policy;
    if child_policy.category_mask & !parent_policy.category_mask != 0
        || child_policy.allowed_actions_mask & !parent_policy.allowed_actions_mask != 0
        || child_policy.expiry > parent_policy.expiry
        || child_policy.expiry <= env.ledger().sequence()
        || child_policy.remaining_delegation_depth >= parent_policy.remaining_delegation_depth
    {
        panic_with_error!(env, Error::InvalidChildPolicy);
    }

    ensure_budget_identifier_available(env, &delegation.child_node_id);
    ensure_budget_identifier_available(env, &delegation.child_note_id);
    if delegation.child_node_id == delegation.child_note_id
        || delegation.child_node_id == *source_note_id
        || delegation.child_note_id == *source_note_id
    {
        panic_with_error!(env, Error::IdentifierAlreadyUsed);
    }
    if let Some(remainder_note_id) = &delegation.remainder_note_id {
        ensure_budget_identifier_available(env, remainder_note_id);
        if remainder_note_id == source_note_id
            || *remainder_note_id == delegation.child_node_id
            || *remainder_note_id == delegation.child_note_id
        {
            panic_with_error!(env, Error::IdentifierAlreadyUsed);
        }
    }

    if child_policy.expiry > session.expires_at_ledger {
        panic_with_error!(env, Error::InvalidChildPolicy);
    }
}

fn ensure_budget_identifier_available(env: &Env, identifier: &BytesN<32>) {
    if env
        .storage()
        .persistent()
        .has(&DataKey::BudgetNode(identifier.clone()))
        || env
            .storage()
            .persistent()
            .has(&DataKey::BudgetNote(identifier.clone()))
        || env
            .storage()
            .persistent()
            .has(&DataKey::StandardNoteAmount(identifier.clone()))
    {
        panic_with_error!(env, Error::IdentifierAlreadyUsed);
    }
}

#[cfg(test)]
mod test;
