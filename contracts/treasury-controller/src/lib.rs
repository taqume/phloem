#![no_std]

mod audit;
mod budget;
mod encoding;
mod error;
mod event;
pub mod poseidon2;
mod provider;
mod reservation;
mod spp;
mod storage;
mod types;
mod voucher;

pub use error::Error;
pub use types::{
    BudgetNode, BudgetNodeOwner, BudgetNodeState, BudgetNoteState, BudgetNoteStatus, Groth16Proof,
    NodePolicy, PaymentRecord, PaymentStatus, PrivatePaymentRecord, PrivatePaymentReservation,
    PrivateReservationInput, PrivateReservationStatus, PrivateSettlementInput, PrivateVoucher,
    RootBudgetNoteInput, SafetyState, Session, SessionAuditState, SessionLifecycle, SessionPolicy,
    SettlementMode, SppExtData, SppPoolError, SppProof, StandardDelegationInput,
    StandardSettlementInput,
};

use soroban_sdk::{
    Address, Bytes, BytesN, Env, Executable, IntoVal, U256, contract, contractimpl,
    panic_with_error, symbol_short, token, xdr::ToXdr,
};

use crate::{
    event::{
        BudgetDelegated, PaymentSettled, PrivateReserved, PrivateSettled, RootFunded,
        SessionCreated,
    },
    storage::{
        Config, DataKey, extend_instance_ttl, extend_persistent_ttl, get_config,
        get_next_session_nonce, increment_session_nonce,
    },
};

const PROTOCOL_VERSION: u32 = 1;
const POLICY_VERSION: u32 = 1;
const MAX_DELEGATION_DEPTH: u32 = 3;
const ACTION_DELEGATE_BUDGET: u64 = 1;
const ACTION_SETTLE_PAYMENT: u64 = 1 << 1;
const ACTION_OPEN_PRIVATE_RESERVATION: u64 = 1 << 2;
const SETTLEMENT_MODE_STANDARD: u32 = 1;
const SETTLEMENT_MODE_MASK: u32 = 0b11;

#[contract]
pub struct TreasuryController;

#[contractimpl]
impl TreasuryController {
    pub fn __constructor(
        env: Env,
        standard_asset: Address,
        agent_account_wasm_hash: BytesN<32>,
        budget_transition_verifier: Address,
        private_binding_verifier: Address,
        spp_pool: Address,
    ) {
        env.storage().instance().set(
            &DataKey::Config,
            &Config {
                standard_asset,
                agent_account_wasm_hash,
                budget_transition_verifier,
                private_binding_verifier,
                spp_pool,
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
            treasury_spp_key_commitment: None,
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
        let audit_key = DataKey::SessionAudit(session_id.clone());

        let policy = load_policy_or_fail(&env, &session_id);
        let audit_context_hash = audit::context_hash_v1(
            &env,
            &env.ledger().network_id(),
            &env.current_contract_address(),
            &session.id,
            &session.asset,
            &session.settlement_mode,
            &session.policy_hash,
        )
        .unwrap_or_else(|| panic_with_error!(&env, Error::InvalidAddressEncoding));
        let initial_audit_commitment =
            audit::total_commitment_v1(&env, &audit_context_hash, 0, &U256::from_u32(&env, 0))
                .unwrap_or_else(|| panic_with_error!(&env, Error::NonCanonicalField));
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
        let audit_state = SessionAuditState {
            session_id: session_id.clone(),
            total_spend_commitment: initial_audit_commitment,
            settlement_count: 0,
            unresolved_reservation_count: 0,
            audit_version: 1,
            policy_hash: session.policy_hash.clone(),
            finalized: false,
            final_snapshot_hash: None,
            standard_total_spend_atomic: Some(0),
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
        env.storage().persistent().set(&audit_key, &audit_state);
        env.storage().persistent().set(&session_key, &session);

        extend_persistent_ttl(&env, &node_key, session.expires_at_ledger);
        extend_persistent_ttl(&env, &note_key, session.expires_at_ledger);
        extend_persistent_ttl(&env, &amount_key, session.expires_at_ledger);
        extend_persistent_ttl(&env, &audit_key, session.expires_at_ledger);
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

    pub fn settle_standard_payment(env: Env, input: StandardSettlementInput) -> PaymentRecord {
        let mut session = load_session_or_fail(&env, &input.session_id);
        let mut source_note = load_note_or_fail(&env, &input.source_budget_note_id);
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

        validate_active_standard_source(&env, &session, &source_note, &source_node);
        if input.amount_atomic == 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        validate_field(&env, &input.provider_spp_public_key);
        validate_field(&env, &input.usage_root);

        let payment_key = DataKey::PaymentRecord(input.payment_id.clone());
        if env.storage().persistent().has(&payment_key) {
            panic_with_error!(&env, Error::PaymentAlreadySettled);
        }

        let category_bit = 1u64
            .checked_shl(input.category_id)
            .unwrap_or_else(|| panic_with_error!(&env, Error::CategoryNotAllowed));
        if source_node.node_policy.category_mask & category_bit == 0 {
            panic_with_error!(&env, Error::CategoryNotAllowed);
        }
        if source_node.node_policy.allowed_actions_mask & ACTION_SETTLE_PAYMENT == 0 {
            panic_with_error!(&env, Error::ActionNotAllowed);
        }
        if input.allowed_settlement_modes & SETTLEMENT_MODE_STANDARD == 0
            || input.allowed_settlement_modes & !SETTLEMENT_MODE_MASK != 0
        {
            panic_with_error!(&env, Error::ProviderNotApproved);
        }
        let provider_leaf = provider::leaf_hash_v1(
            &env,
            &provider::ProviderPolicyLeafV1 {
                provider_identity: &input.provider,
                provider_spp_public_key: &input.provider_spp_public_key,
                service_id_hash: &input.service_id_hash,
                category_id: input.category_id,
                allowed_settlement_modes: input.allowed_settlement_modes,
            },
        )
        .unwrap_or_else(|| panic_with_error!(&env, Error::InvalidAddressEncoding));
        // P0 has exactly one controlled provider, so the policy root is the
        // canonical provider leaf itself. Merkle membership is reserved for a
        // future multi-provider policy without weakening this check.
        if provider_leaf != session.approved_provider_root {
            panic_with_error!(&env, Error::ProviderNotApproved);
        }

        let source_amount_key = DataKey::StandardNoteAmount(input.source_budget_note_id.clone());
        let source_amount: u64 = env
            .storage()
            .persistent()
            .get(&source_amount_key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::BudgetStateMismatch));
        let remainder_amount = source_amount
            .checked_sub(input.amount_atomic)
            .unwrap_or_else(|| panic_with_error!(&env, Error::InvalidConservation));
        match (
            remainder_amount,
            &input.remainder_budget_note_id,
            &input.remainder_commitment,
        ) {
            (0, None, None) => {}
            (0, _, _) | (_, None, _) | (_, _, None) => {
                panic_with_error!(&env, Error::InvalidConservation)
            }
            (_, Some(note_id), Some(commitment)) => {
                ensure_budget_identifier_available(&env, note_id);
                if *note_id == input.source_budget_note_id {
                    panic_with_error!(&env, Error::IdentifierAlreadyUsed);
                }
                validate_field(&env, commitment);
            }
        }

        let audit_key = DataKey::SessionAudit(input.session_id.clone());
        let mut audit_state: SessionAuditState = env
            .storage()
            .persistent()
            .get(&audit_key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::AuditStateNotFound));
        if audit_state.session_id != session.id
            || audit_state.policy_hash != session.policy_hash
            || audit_state.settlement_count != session.settlement_count
            || audit_state.audit_version != session.audit_version
            || audit_state.finalized
            || session.audit_finalized
        {
            panic_with_error!(&env, Error::AuditStateMismatch);
        }
        let current_total = audit_state
            .standard_total_spend_atomic
            .unwrap_or_else(|| panic_with_error!(&env, Error::AuditStateMismatch));
        let next_total = current_total
            .checked_add(input.amount_atomic)
            .unwrap_or_else(|| panic_with_error!(&env, Error::CounterOverflow));
        let audit_context_hash = audit::context_hash_v1(
            &env,
            &env.ledger().network_id(),
            &env.current_contract_address(),
            &session.id,
            &session.asset,
            &session.settlement_mode,
            &session.policy_hash,
        )
        .unwrap_or_else(|| panic_with_error!(&env, Error::InvalidAddressEncoding));
        let expected_old_commitment = audit::total_commitment_v1(
            &env,
            &audit_context_hash,
            current_total,
            &U256::from_u32(&env, 0),
        )
        .unwrap_or_else(|| panic_with_error!(&env, Error::NonCanonicalField));
        if audit_state.total_spend_commitment != expected_old_commitment {
            panic_with_error!(&env, Error::AuditStateMismatch);
        }
        let new_audit_commitment = audit::total_commitment_v1(
            &env,
            &audit_context_hash,
            next_total,
            &U256::from_u32(&env, 0),
        )
        .unwrap_or_else(|| panic_with_error!(&env, Error::NonCanonicalField));

        let next_settlement_count = session
            .settlement_count
            .checked_add(1)
            .unwrap_or_else(|| panic_with_error!(&env, Error::CounterOverflow));
        let next_audit_version = session
            .audit_version
            .checked_add(1)
            .unwrap_or_else(|| panic_with_error!(&env, Error::CounterOverflow));
        let settled_at_ledger = env.ledger().sequence();
        let settlement_ref = derive_standard_settlement_ref(&env, &input, settled_at_ledger);
        let record = PaymentRecord {
            payment_id: input.payment_id.clone(),
            session_id: input.session_id.clone(),
            source_budget_note_id: input.source_budget_note_id.clone(),
            remainder_budget_note_id: input.remainder_budget_note_id.clone(),
            amount_atomic: input.amount_atomic,
            provider: input.provider.clone(),
            category_id: input.category_id,
            usage_root: input.usage_root.clone(),
            offer_reference_hash: input.offer_reference_hash.clone(),
            settlement_ref: settlement_ref.clone(),
            status: PaymentStatus::Settled,
            settled_at_ledger,
        };

        // The nested SAC transfer and every canonical protocol mutation below
        // share one call tree. Any failure rolls back the transfer and all state.
        token::Client::new(&env, &session.asset).transfer(
            &env.current_contract_address(),
            &input.provider,
            &(input.amount_atomic as i128),
        );

        source_note.state = BudgetNoteStatus::Spent;
        source_note.spent_at_ledger = Some(settled_at_ledger);
        session.settlement_count = next_settlement_count;
        session.audit_version = next_audit_version;
        audit_state.total_spend_commitment = new_audit_commitment;
        audit_state.settlement_count = next_settlement_count;
        audit_state.audit_version = next_audit_version;
        audit_state.standard_total_spend_atomic = Some(next_total);

        let session_key = DataKey::Session(input.session_id.clone());
        let source_note_key = DataKey::BudgetNote(input.source_budget_note_id.clone());
        env.storage()
            .persistent()
            .set(&source_note_key, &source_note);
        env.storage().persistent().set(&session_key, &session);
        env.storage().persistent().set(&audit_key, &audit_state);
        env.storage().persistent().set(&payment_key, &record);

        extend_persistent_ttl(&env, &source_note_key, session.expires_at_ledger);
        extend_persistent_ttl(&env, &source_amount_key, session.expires_at_ledger);
        extend_persistent_ttl(&env, &session_key, session.expires_at_ledger);
        extend_persistent_ttl(&env, &audit_key, session.expires_at_ledger);
        extend_persistent_ttl(&env, &payment_key, session.expires_at_ledger);

        if let (Some(remainder_note_id), Some(remainder_commitment)) =
            (&input.remainder_budget_note_id, &input.remainder_commitment)
        {
            let remainder_note = BudgetNoteState {
                id: remainder_note_id.clone(),
                session_id: session.id.clone(),
                node_id: source_node.id.clone(),
                owner: source_node.owner.clone(),
                policy_hash: session.policy_hash.clone(),
                commitment: remainder_commitment.clone(),
                state: BudgetNoteStatus::Active,
                created_at_ledger: settled_at_ledger,
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
            extend_persistent_ttl(&env, &remainder_note_key, session.expires_at_ledger);
            extend_persistent_ttl(&env, &remainder_amount_key, session.expires_at_ledger);
        }

        extend_instance_ttl(&env, session.expires_at_ledger);
        PaymentSettled {
            payment_id: record.payment_id.clone(),
            session_id: record.session_id.clone(),
            source_budget_note_id: record.source_budget_note_id.clone(),
            remainder_budget_note_id: record.remainder_budget_note_id.clone(),
            amount_atomic: record.amount_atomic,
            provider: record.provider.clone(),
            category_id: record.category_id,
            settlement_ref,
            status: PaymentStatus::Settled,
        }
        .publish(&env);

        record
    }

    pub fn open_private_reservation(
        env: Env,
        input: PrivateReservationInput,
        proof: Groth16Proof,
    ) -> PrivatePaymentReservation {
        let mut session = load_session_or_fail(&env, &input.session_id);
        let mut source_note = load_note_or_fail(&env, &input.source_budget_note_id);
        let source_node = load_node_or_fail(&env, &source_note.node_id);
        let source_agent = match &source_note.owner {
            BudgetNodeOwner::AgentSmartAccount(owner) => owner.clone(),
            BudgetNodeOwner::RootCompany => {
                panic_with_error!(&env, Error::InvalidBudgetOwner)
            }
        };
        source_agent.require_auth();
        validate_active_private_source(&env, &session, &source_note, &source_node);

        let current_ledger = env.ledger().sequence();
        if input.claim_deadline_ledger <= current_ledger
            || input.claim_deadline_ledger > session.expires_at_ledger
        {
            panic_with_error!(&env, Error::InvalidExpiry);
        }
        let category_bit = 1u64
            .checked_shl(input.category_id)
            .unwrap_or_else(|| panic_with_error!(&env, Error::CategoryNotAllowed));
        if source_node.node_policy.category_mask & category_bit == 0 {
            panic_with_error!(&env, Error::CategoryNotAllowed);
        }
        if source_node.node_policy.allowed_actions_mask & ACTION_OPEN_PRIVATE_RESERVATION == 0 {
            panic_with_error!(&env, Error::ActionNotAllowed);
        }
        validate_field(&env, &input.offer_commitment);
        validate_field(&env, &input.amount_commitment);
        validate_field(&env, &input.provider_commitment);
        if input.voucher_signer_public_key == BytesN::from_array(&env, &[0_u8; 32]) {
            panic_with_error!(&env, Error::InvalidReservation);
        }

        let reservation_key = DataKey::PrivateReservation(input.reservation_id.clone());
        if env.storage().persistent().has(&reservation_key) {
            panic_with_error!(&env, Error::ReservationAlreadyExists);
        }
        ensure_budget_identifier_available(&env, &input.reservation_id);
        let voucher_key = DataKey::VoucherKeyUsed(input.voucher_signer_public_key.clone());
        if env.storage().persistent().has(&voucher_key) {
            panic_with_error!(&env, Error::VoucherKeyAlreadyUsed);
        }

        let source_context_hash = budget_context_hash_for_note(&env, &session, &source_note);
        let reservation_context_hash = reservation::context_hash_v1(
            &env,
            &source_context_hash,
            &input.reservation_id,
            &session.approved_provider_root,
        )
        .unwrap_or_else(|| panic_with_error!(&env, Error::NonCanonicalField));

        let (remainder_context_hash, remainder_commitment, remainder_kind) =
            match (&input.remainder_budget_note_id, &input.remainder_commitment) {
                (None, None) => (U256::from_u32(&env, 0), U256::from_u32(&env, 0), 0u32),
                (Some(note_id), Some(commitment)) => {
                    ensure_budget_identifier_available(&env, note_id);
                    if *note_id == input.source_budget_note_id || *note_id == input.reservation_id {
                        panic_with_error!(&env, Error::IdentifierAlreadyUsed);
                    }
                    validate_field(&env, commitment);
                    let remainder_note = BudgetNoteState {
                        id: note_id.clone(),
                        session_id: session.id.clone(),
                        node_id: source_node.id.clone(),
                        owner: source_node.owner.clone(),
                        policy_hash: session.policy_hash.clone(),
                        commitment: commitment.clone(),
                        state: BudgetNoteStatus::Active,
                        created_at_ledger: current_ledger,
                        spent_at_ledger: None,
                    };
                    (
                        budget_context_hash_for_note(&env, &session, &remainder_note),
                        commitment.clone(),
                        1u32,
                    )
                }
                _ => panic_with_error!(&env, Error::InvalidConservation),
            };

        let public_inputs = soroban_sdk::vec![
            &env,
            source_context_hash,
            source_note.commitment.clone(),
            reservation_context_hash.clone(),
            input.amount_commitment.clone(),
            U256::from_u32(&env, 2),
            remainder_context_hash,
            remainder_commitment,
            U256::from_u32(&env, remainder_kind),
        ];
        let verified: bool = env.invoke_contract(
            &get_config(&env).budget_transition_verifier,
            &symbol_short!("verify"),
            (proof, public_inputs).into_val(&env),
        );
        if !verified {
            panic_with_error!(&env, Error::InvalidProof);
        }

        let next_unresolved = session
            .unresolved_reservation_count
            .checked_add(1)
            .unwrap_or_else(|| panic_with_error!(&env, Error::CounterOverflow));
        let audit_key = DataKey::SessionAudit(session.id.clone());
        let mut audit_state: SessionAuditState = env
            .storage()
            .persistent()
            .get(&audit_key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::AuditStateNotFound));
        if audit_state.unresolved_reservation_count != session.unresolved_reservation_count
            || audit_state.session_id != session.id
            || audit_state.policy_hash != session.policy_hash
            || audit_state.settlement_count != session.settlement_count
            || audit_state.audit_version != session.audit_version
            || audit_state.finalized
            || session.audit_finalized
        {
            panic_with_error!(&env, Error::AuditStateMismatch);
        }

        let reservation = PrivatePaymentReservation {
            id: input.reservation_id.clone(),
            session_id: session.id.clone(),
            source_node_id: source_node.id.clone(),
            source_agent,
            asset: session.asset.clone(),
            category_id: input.category_id,
            offer_commitment: input.offer_commitment,
            voucher_signer_public_key: input.voucher_signer_public_key.clone(),
            amount_commitment: input.amount_commitment,
            provider_commitment: input.provider_commitment,
            approved_provider_root: session.approved_provider_root.clone(),
            reservation_context_hash,
            claim_deadline_ledger: input.claim_deadline_ledger,
            status: PrivateReservationStatus::Open,
            created_at_ledger: current_ledger,
        };

        source_note.state = BudgetNoteStatus::Spent;
        source_note.spent_at_ledger = Some(current_ledger);
        session.unresolved_reservation_count = next_unresolved;
        audit_state.unresolved_reservation_count = next_unresolved;

        let source_note_key = DataKey::BudgetNote(input.source_budget_note_id.clone());
        let session_key = DataKey::Session(session.id.clone());
        env.storage()
            .persistent()
            .set(&source_note_key, &source_note);
        env.storage().persistent().set(&session_key, &session);
        env.storage().persistent().set(&audit_key, &audit_state);
        env.storage()
            .persistent()
            .set(&reservation_key, &reservation);
        env.storage().persistent().set(&voucher_key, &true);

        extend_persistent_ttl(&env, &source_note_key, session.expires_at_ledger);
        extend_persistent_ttl(&env, &session_key, session.expires_at_ledger);
        extend_persistent_ttl(&env, &audit_key, session.expires_at_ledger);
        extend_persistent_ttl(&env, &reservation_key, session.expires_at_ledger);
        extend_persistent_ttl(&env, &voucher_key, session.expires_at_ledger);

        if let (Some(note_id), Some(commitment)) =
            (&input.remainder_budget_note_id, &input.remainder_commitment)
        {
            let remainder_note = BudgetNoteState {
                id: note_id.clone(),
                session_id: session.id.clone(),
                node_id: source_node.id.clone(),
                owner: source_node.owner.clone(),
                policy_hash: session.policy_hash.clone(),
                commitment: commitment.clone(),
                state: BudgetNoteStatus::Active,
                created_at_ledger: current_ledger,
                spent_at_ledger: None,
            };
            let remainder_key = DataKey::BudgetNote(note_id.clone());
            env.storage()
                .persistent()
                .set(&remainder_key, &remainder_note);
            extend_persistent_ttl(&env, &remainder_key, session.expires_at_ledger);
        }

        extend_instance_ttl(&env, session.expires_at_ledger);
        PrivateReserved {
            reservation_id: reservation.id.clone(),
            session_id: reservation.session_id.clone(),
            source_budget_note_id: input.source_budget_note_id,
            remainder_budget_note_id: input.remainder_budget_note_id,
            category_id: reservation.category_id,
            claim_deadline_ledger: reservation.claim_deadline_ledger,
            status: reservation.status.clone(),
        }
        .publish(&env);

        reservation
    }

    pub fn settle_private_payment(env: Env, input: PrivateSettlementInput) -> PrivatePaymentRecord {
        let mut reservation =
            validate_private_voucher(&env, &input.voucher, &input.voucher_signature);
        let mut session = load_session_or_fail(&env, &reservation.session_id);
        if session.settlement_mode != SettlementMode::Private
            || (session.lifecycle != SessionLifecycle::Active
                && session.lifecycle != SessionLifecycle::Draining)
            || session.audit_finalized
            || reservation.asset != session.asset
            || reservation.approved_provider_root != session.approved_provider_root
        {
            panic_with_error!(&env, Error::InvalidPrivateSettlement);
        }

        let treasury_spp_key_commitment = session
            .treasury_spp_key_commitment
            .clone()
            .unwrap_or_else(|| panic_with_error!(&env, Error::InvalidPrivateSettlement));
        validate_field(&env, &treasury_spp_key_commitment);
        validate_field(&env, &input.new_audit_total_commitment);
        validate_field(&env, &input.spp_proof.output_commitment0);
        validate_field(&env, &input.spp_proof.output_commitment1);
        validate_field(&env, &input.spp_proof.public_amount);
        if input.spp_proof.public_amount != U256::from_u32(&env, 0)
            || input.spp_ext_data.ext_amount != soroban_sdk::I256::from_i32(&env, 0)
        {
            panic_with_error!(&env, Error::InvalidPrivateSettlement);
        }

        let config = get_config(&env);
        if input.spp_ext_data.recipient != config.spp_pool {
            panic_with_error!(&env, Error::InvalidPrivateSettlement);
        }
        let private_record_key = DataKey::PrivatePaymentRecord(reservation.id.clone());
        if env.storage().persistent().has(&private_record_key) {
            panic_with_error!(&env, Error::PaymentAlreadySettled);
        }

        let source_node = load_node_or_fail(&env, &reservation.source_node_id);
        if source_node.session_id != session.id
            || source_node.owner
                != BudgetNodeOwner::AgentSmartAccount(reservation.source_agent.clone())
        {
            panic_with_error!(&env, Error::BudgetStateMismatch);
        }
        let current_ledger = env.ledger().sequence();
        let (refund_context_hash, refund_commitment, refund_note) = match (
            &input.refund_budget_note_id,
            &input.refund_budget_commitment,
        ) {
            (None, None) => (U256::from_u32(&env, 0), U256::from_u32(&env, 0), None),
            (Some(note_id), Some(commitment)) => {
                ensure_budget_identifier_available(&env, note_id);
                if *note_id == reservation.id {
                    panic_with_error!(&env, Error::IdentifierAlreadyUsed);
                }
                validate_field(&env, commitment);
                let note = BudgetNoteState {
                    id: note_id.clone(),
                    session_id: session.id.clone(),
                    node_id: source_node.id.clone(),
                    owner: source_node.owner.clone(),
                    policy_hash: session.policy_hash.clone(),
                    commitment: commitment.clone(),
                    state: BudgetNoteStatus::Active,
                    created_at_ledger: current_ledger,
                    spent_at_ledger: None,
                };
                (
                    budget_context_hash_for_note(&env, &session, &note),
                    commitment.clone(),
                    Some(note),
                )
            }
            _ => panic_with_error!(&env, Error::InvalidConservation),
        };

        let audit_key = DataKey::SessionAudit(session.id.clone());
        let mut audit_state: SessionAuditState = env
            .storage()
            .persistent()
            .get(&audit_key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::AuditStateNotFound));
        if audit_state.session_id != session.id
            || audit_state.policy_hash != session.policy_hash
            || audit_state.settlement_count != session.settlement_count
            || audit_state.unresolved_reservation_count != session.unresolved_reservation_count
            || audit_state.audit_version != session.audit_version
            || audit_state.finalized
            || audit_state.standard_total_spend_atomic.is_some()
        {
            panic_with_error!(&env, Error::AuditStateMismatch);
        }
        let audit_context_hash = audit::context_hash_v1(
            &env,
            &env.ledger().network_id(),
            &env.current_contract_address(),
            &session.id,
            &session.asset,
            &session.settlement_mode,
            &session.policy_hash,
        )
        .unwrap_or_else(|| panic_with_error!(&env, Error::InvalidAddressEncoding));
        let next_settlement_count = session
            .settlement_count
            .checked_add(1)
            .unwrap_or_else(|| panic_with_error!(&env, Error::CounterOverflow));
        let next_unresolved = session
            .unresolved_reservation_count
            .checked_sub(1)
            .unwrap_or_else(|| panic_with_error!(&env, Error::AuditStateMismatch));
        let next_audit_version = session
            .audit_version
            .checked_add(1)
            .unwrap_or_else(|| panic_with_error!(&env, Error::CounterOverflow));
        let public_inputs = soroban_sdk::vec![
            &env,
            reservation.reservation_context_hash.clone(),
            reservation.amount_commitment.clone(),
            voucher::context_hash_v1(
                &env,
                &reservation.reservation_context_hash,
                &reservation.offer_commitment,
                &reservation.voucher_signer_public_key,
                &input.voucher.usage_root,
            )
            .unwrap_or_else(|| panic_with_error!(&env, Error::NonCanonicalField)),
            input.voucher.cumulative_amount_commitment.clone(),
            reservation.provider_commitment.clone(),
            input.spp_proof.output_commitment0.clone(),
            treasury_spp_key_commitment,
            input.spp_proof.output_commitment1.clone(),
            refund_context_hash,
            refund_commitment,
            reservation.approved_provider_root.clone(),
            audit_context_hash,
            audit_state.total_spend_commitment.clone(),
            input.new_audit_total_commitment.clone(),
            input.voucher.usage_root.clone(),
            reservation.offer_commitment.clone(),
        ];
        let binding_verified: bool = env.invoke_contract(
            &config.private_binding_verifier,
            &symbol_short!("verify"),
            (input.binding_proof.clone(), public_inputs).into_val(&env),
        );
        if !binding_verified {
            panic_with_error!(&env, Error::InvalidProof);
        }

        spp::SppPoolClient::new(&env, &config.spp_pool).transact(
            &input.spp_proof,
            &input.spp_ext_data,
            &env.current_contract_address(),
        );
        let settlement_ref = derive_private_settlement_ref(
            &env,
            &reservation.id,
            &input.voucher,
            &input.spp_proof,
            current_ledger,
        );
        let record = PrivatePaymentRecord {
            reservation_id: reservation.id.clone(),
            session_id: session.id.clone(),
            refund_budget_note_id: input.refund_budget_note_id.clone(),
            voucher_sequence: input.voucher.sequence,
            usage_root: input.voucher.usage_root.clone(),
            provider_spp_output_commitment: input.spp_proof.output_commitment0.clone(),
            spp_refund_output_commitment: input.spp_proof.output_commitment1.clone(),
            audit_total_commitment: input.new_audit_total_commitment.clone(),
            settlement_ref: settlement_ref.clone(),
            status: PaymentStatus::Settled,
            settled_at_ledger: current_ledger,
        };

        reservation.status = PrivateReservationStatus::Settled;
        session.settlement_count = next_settlement_count;
        session.unresolved_reservation_count = next_unresolved;
        session.audit_version = next_audit_version;
        audit_state.total_spend_commitment = input.new_audit_total_commitment;
        audit_state.settlement_count = next_settlement_count;
        audit_state.unresolved_reservation_count = next_unresolved;
        audit_state.audit_version = next_audit_version;

        let reservation_key = DataKey::PrivateReservation(reservation.id.clone());
        let session_key = DataKey::Session(session.id.clone());
        env.storage()
            .persistent()
            .set(&reservation_key, &reservation);
        env.storage().persistent().set(&session_key, &session);
        env.storage().persistent().set(&audit_key, &audit_state);
        env.storage().persistent().set(&private_record_key, &record);
        extend_persistent_ttl(&env, &reservation_key, session.expires_at_ledger);
        extend_persistent_ttl(&env, &session_key, session.expires_at_ledger);
        extend_persistent_ttl(&env, &audit_key, session.expires_at_ledger);
        extend_persistent_ttl(&env, &private_record_key, session.expires_at_ledger);
        if let Some(note) = refund_note {
            let refund_key = DataKey::BudgetNote(note.id.clone());
            env.storage().persistent().set(&refund_key, &note);
            extend_persistent_ttl(&env, &refund_key, session.expires_at_ledger);
        }
        extend_instance_ttl(&env, session.expires_at_ledger);

        PrivateSettled {
            reservation_id: record.reservation_id.clone(),
            session_id: record.session_id.clone(),
            refund_budget_note_id: record.refund_budget_note_id.clone(),
            voucher_sequence: record.voucher_sequence,
            usage_root: record.usage_root.clone(),
            provider_spp_output_commitment: record.provider_spp_output_commitment.clone(),
            spp_refund_output_commitment: record.spp_refund_output_commitment.clone(),
            new_audit_total_commitment: record.audit_total_commitment.clone(),
            settlement_ref,
            status: PaymentStatus::Settled,
        }
        .publish(&env);

        record
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

    pub fn get_payment_record(env: Env, payment_id: BytesN<32>) -> Option<PaymentRecord> {
        let key = DataKey::PaymentRecord(payment_id);
        let record: Option<PaymentRecord> = env.storage().persistent().get(&key);
        if let Some(value) = &record {
            let session = load_session_or_fail(&env, &value.session_id);
            extend_persistent_ttl(&env, &key, session.expires_at_ledger);
        }
        record
    }

    pub fn get_private_reservation(
        env: Env,
        reservation_id: BytesN<32>,
    ) -> Option<PrivatePaymentReservation> {
        let key = DataKey::PrivateReservation(reservation_id);
        let reservation: Option<PrivatePaymentReservation> = env.storage().persistent().get(&key);
        if let Some(value) = &reservation {
            let session = load_session_or_fail(&env, &value.session_id);
            extend_persistent_ttl(&env, &key, session.expires_at_ledger);
        }
        reservation
    }

    pub fn get_private_payment_record(
        env: Env,
        reservation_id: BytesN<32>,
    ) -> Option<PrivatePaymentRecord> {
        let key = DataKey::PrivatePaymentRecord(reservation_id);
        let record: Option<PrivatePaymentRecord> = env.storage().persistent().get(&key);
        if let Some(value) = &record {
            let session = load_session_or_fail(&env, &value.session_id);
            extend_persistent_ttl(&env, &key, session.expires_at_ledger);
        }
        record
    }

    pub fn verify_private_voucher(
        env: Env,
        voucher: PrivateVoucher,
        signature: BytesN<64>,
    ) -> bool {
        let reservation = validate_private_voucher(&env, &voucher, &signature);
        let reservation_key = DataKey::PrivateReservation(reservation.id.clone());
        extend_persistent_ttl(&env, &reservation_key, reservation.claim_deadline_ledger);
        true
    }

    pub fn get_provider_policy_leaf(
        env: Env,
        provider_identity: Address,
        provider_spp_public_key: U256,
        service_id_hash: BytesN<32>,
        category_id: u32,
        allowed_settlement_modes: u32,
    ) -> U256 {
        validate_field(&env, &provider_spp_public_key);
        provider::leaf_hash_v1(
            &env,
            &provider::ProviderPolicyLeafV1 {
                provider_identity: &provider_identity,
                provider_spp_public_key: &provider_spp_public_key,
                service_id_hash: &service_id_hash,
                category_id,
                allowed_settlement_modes,
            },
        )
        .unwrap_or_else(|| panic_with_error!(&env, Error::InvalidAddressEncoding))
    }

    pub fn get_standard_asset(env: Env) -> Address {
        get_config(&env).standard_asset
    }

    pub fn get_audit_state(env: Env, session_id: BytesN<32>) -> Option<SessionAuditState> {
        let session = load_session_or_fail(&env, &session_id);
        let key = DataKey::SessionAudit(session_id);
        let state = env.storage().persistent().get(&key);
        if state.is_some() {
            extend_persistent_ttl(&env, &key, session.expires_at_ledger);
        }
        state
    }

    pub fn get_agent_account_wasm_hash(env: Env) -> BytesN<32> {
        get_config(&env).agent_account_wasm_hash
    }

    pub fn get_budget_transition_verifier(env: Env) -> Address {
        get_config(&env).budget_transition_verifier
    }

    pub fn get_private_binding_verifier(env: Env) -> Address {
        get_config(&env).private_binding_verifier
    }

    pub fn get_spp_pool(env: Env) -> Address {
        get_config(&env).spp_pool
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
        budget_context_hash_for_note(&env, &session, &note)
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

fn derive_standard_settlement_ref(
    env: &Env,
    input: &StandardSettlementInput,
    settled_at_ledger: u32,
) -> BytesN<32> {
    let domain = Bytes::from_slice(env, b"PHLOEM_STANDARD_SETTLEMENT_V1");
    let preimage = (
        domain,
        env.current_contract_address(),
        input.payment_id.clone(),
        input.session_id.clone(),
        input.source_budget_note_id.clone(),
        input.provider.clone(),
        input.amount_atomic,
        input.offer_reference_hash.clone(),
        settled_at_ledger,
    )
        .to_xdr(env);
    env.crypto().sha256(&preimage).to_bytes()
}

fn derive_private_settlement_ref(
    env: &Env,
    reservation_id: &BytesN<32>,
    voucher: &PrivateVoucher,
    spp_proof: &SppProof,
    settled_at_ledger: u32,
) -> BytesN<32> {
    let domain = Bytes::from_slice(env, b"PHLOEM_PRIVATE_SETTLEMENT_V1");
    let preimage = (
        domain,
        env.current_contract_address(),
        reservation_id.clone(),
        voucher.sequence,
        voucher.usage_root.clone(),
        spp_proof.output_commitment0.clone(),
        spp_proof.output_commitment1.clone(),
        settled_at_ledger,
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

fn validate_private_voucher(
    env: &Env,
    voucher: &PrivateVoucher,
    signature: &BytesN<64>,
) -> PrivatePaymentReservation {
    let reservation: PrivatePaymentReservation = env
        .storage()
        .persistent()
        .get(&DataKey::PrivateReservation(voucher.reservation_id.clone()))
        .unwrap_or_else(|| panic_with_error!(env, Error::ReservationNotFound));
    let current_ledger = env.ledger().sequence();
    if reservation.status != PrivateReservationStatus::Open
        || voucher.protocol_version != PROTOCOL_VERSION
        || voucher.voucher_version != 1
        || voucher.network_id != env.ledger().network_id()
        || voucher.treasury_controller != env.current_contract_address()
        || voucher.session_id != reservation.session_id
        || voucher.offer_commitment != reservation.offer_commitment
        || voucher.sequence == 0
        || current_ledger > voucher.expiry_ledger
        || current_ledger > reservation.claim_deadline_ledger
        || voucher.expiry_ledger > reservation.claim_deadline_ledger
    {
        panic_with_error!(env, Error::InvalidVoucher);
    }
    validate_field(env, &voucher.cumulative_amount_commitment);
    validate_field(env, &voucher.usage_root);

    let signing_bytes = voucher::signing_bytes_v1(env, voucher)
        .unwrap_or_else(|| panic_with_error!(env, Error::InvalidAddressEncoding));
    env.crypto().ed25519_verify(
        &reservation.voucher_signer_public_key,
        &signing_bytes,
        signature,
    );
    reservation
}

fn budget_context_hash_for_note(env: &Env, session: &Session, note: &BudgetNoteState) -> U256 {
    if session.created_protocol_version != PROTOCOL_VERSION {
        panic_with_error!(env, Error::BudgetStateMismatch);
    }
    let owner = match &note.owner {
        BudgetNodeOwner::RootCompany => session.company.clone(),
        BudgetNodeOwner::AgentSmartAccount(address) => address.clone(),
    };
    budget::context_hash_v1(
        env,
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
    .unwrap_or_else(|| panic_with_error!(env, Error::InvalidAddressEncoding))
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

fn validate_active_private_source(
    env: &Env,
    session: &Session,
    source_note: &BudgetNoteState,
    source_node: &BudgetNode,
) {
    let current_ledger = env.ledger().sequence();
    if session.lifecycle != SessionLifecycle::Active {
        panic_with_error!(env, Error::InvalidLifecycle);
    }
    if session.settlement_mode != SettlementMode::Private {
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
    if parent_policy.allowed_actions_mask & ACTION_DELEGATE_BUDGET == 0 {
        panic_with_error!(env, Error::ActionNotAllowed);
    }
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
        || env
            .storage()
            .persistent()
            .has(&DataKey::PrivateReservation(identifier.clone()))
    {
        panic_with_error!(env, Error::IdentifierAlreadyUsed);
    }
}

#[cfg(test)]
mod test;
