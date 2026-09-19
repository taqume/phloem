extern crate std;

use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{
    Address, Bytes, BytesN, ContractExecutable, Env, Event as _, IntoVal, Symbol, U256, Vec,
    contract, contractimpl,
    crypto::bn254::{
        BN254_G1_SERIALIZED_SIZE, BN254_G2_SERIALIZED_SIZE, Bn254G1Affine, Bn254G2Affine,
    },
    testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation, Events as _, Ledger},
    token::{StellarAssetClient, TokenClient},
};

use crate::{
    BudgetNode, BudgetNodeOwner, BudgetNodeState, BudgetNoteState, BudgetNoteStatus, Groth16Proof,
    NodePolicy, PaymentStatus, PrivateReservationInput, PrivateReservationStatus,
    PrivateSettlementInput, PrivateVoucher, RootBudgetNoteInput, SafetyState, SessionAuditState,
    SessionLifecycle, SessionPolicy, SettlementMode, SppExtData, SppPoolError, SppProof,
    StandardDelegationInput, StandardSettlementInput, TreasuryController, TreasuryControllerClient,
    event::BudgetDelegated, storage::DataKey,
};

#[contract]
struct MockAgentAccount;

#[contractimpl]
impl MockAgentAccount {
    pub fn ping() {}
}

#[contract]
struct WrongAgentImplementation;

#[contractimpl]
impl WrongAgentImplementation {
    pub fn pong() {}
}

#[contract]
struct MockBudgetTransitionVerifier;

#[contractimpl]
impl MockBudgetTransitionVerifier {
    pub fn verify(env: Env, _proof: Groth16Proof, public_inputs: Vec<U256>) -> bool {
        if public_inputs.len() != 8 || public_inputs.get_unchecked(4) != U256::from_u32(&env, 2) {
            return false;
        }
        let remainder_kind = public_inputs.get_unchecked(7);
        remainder_kind == U256::from_u32(&env, 0) || remainder_kind == U256::from_u32(&env, 1)
    }
}

#[contract]
struct RejectingBudgetTransitionVerifier;

#[contractimpl]
impl RejectingBudgetTransitionVerifier {
    pub fn verify(_proof: Groth16Proof, _public_inputs: Vec<U256>) -> bool {
        false
    }
}

#[contract]
struct MockPrivateBindingVerifier;

#[contractimpl]
impl MockPrivateBindingVerifier {
    pub fn verify(env: Env, _proof: Groth16Proof, public_inputs: Vec<U256>) -> bool {
        public_inputs.len() == 16
            && public_inputs.get_unchecked(5) != U256::from_u32(&env, 0)
            && public_inputs.get_unchecked(6) != U256::from_u32(&env, 0)
            && public_inputs.get_unchecked(7) != U256::from_u32(&env, 0)
    }
}

#[contract]
struct MockSppPool;

#[contractimpl]
impl MockSppPool {
    pub fn transact(
        env: Env,
        proof: SppProof,
        ext_data: SppExtData,
        sender: Address,
    ) -> Result<(), SppPoolError> {
        sender.require_auth();
        if proof.public_amount != U256::from_u32(&env, 0)
            || ext_data.ext_amount != soroban_sdk::I256::from_i32(&env, 0)
            || ext_data.recipient != env.current_contract_address()
        {
            return Err(SppPoolError::WrongExtAmount);
        }
        if proof.root == U256::from_u32(&env, 999) {
            env.storage().instance().set(
                &Symbol::new(&env, "last_output0"),
                &proof.output_commitment0,
            );
            return Err(SppPoolError::InvalidProof);
        }
        env.storage().instance().set(
            &Symbol::new(&env, "last_output0"),
            &proof.output_commitment0,
        );
        Ok(())
    }

    pub fn get_last_output0(env: Env) -> Option<U256> {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "last_output0"))
    }
}

struct Harness<'a> {
    env: Env,
    contract_id: Address,
    controller: TreasuryControllerClient<'a>,
    company: Address,
    asset: Address,
    agent_account_wasm_hash: BytesN<32>,
    budget_transition_verifier: Address,
    private_binding_verifier: Address,
    spp_pool: Address,
    token: TokenClient<'a>,
}

fn setup<'a>() -> Harness<'a> {
    setup_internal(None, false)
}

fn setup_with_budget_verifier<'a>(accept_proof: bool) -> Harness<'a> {
    setup_internal(Some(accept_proof), false)
}

fn setup_with_private_settlement<'a>() -> Harness<'a> {
    setup_internal(Some(true), true)
}

fn setup_internal<'a>(accept_proof: Option<bool>, private_settlement: bool) -> Harness<'a> {
    let env = Env::default();
    env.ledger().set_sequence_number(1_000);

    let issuer = Address::generate(&env);
    let company = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let asset = sac.address();
    let stellar_asset = StellarAssetClient::new(&env, &asset);

    env.mock_all_auths();
    stellar_asset.mint(&company, &10_000);
    env.set_auths(&[]);

    let agent_account_wasm_hash = env.upload(MockAgentAccount);
    let budget_transition_verifier = match accept_proof {
        Some(true) => env.register(MockBudgetTransitionVerifier, ()),
        Some(false) => env.register(RejectingBudgetTransitionVerifier, ()),
        None => company.clone(),
    };
    let (private_binding_verifier, spp_pool) = if private_settlement {
        (
            env.register(MockPrivateBindingVerifier, ()),
            env.register(MockSppPool, ()),
        )
    } else {
        (company.clone(), company.clone())
    };
    let contract_id = env.register(
        TreasuryController,
        (
            asset.clone(),
            agent_account_wasm_hash.clone(),
            budget_transition_verifier.clone(),
            private_binding_verifier.clone(),
            spp_pool.clone(),
        ),
    );
    let controller = TreasuryControllerClient::new(&env, &contract_id);
    let token = TokenClient::new(&env, &asset);

    Harness {
        env,
        contract_id,
        controller,
        company,
        asset,
        agent_account_wasm_hash,
        budget_transition_verifier,
        private_binding_verifier,
        spp_pool,
        token,
    }
}

fn policy(env: &Env, asset: &Address, mode: SettlementMode, expiry: u32) -> SessionPolicy {
    SessionPolicy {
        version: 1,
        asset: asset.clone(),
        settlement_mode: mode,
        approved_provider_root: U256::from_u32(env, 17),
        category_schema_version: 1,
        max_delegation_depth: 3,
        allowed_actions_mask: 0b111,
        session_expiry: expiry,
        policy_hash: U256::from_u32(env, 23),
    }
}

fn id(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

fn create_standard_session(h: &Harness<'_>, expiry: u32) -> BytesN<32> {
    h.env.mock_all_auths();
    h.controller.create_session(
        &h.company,
        &h.asset,
        &SettlementMode::Standard,
        &policy(&h.env, &h.asset, SettlementMode::Standard, expiry),
        &expiry,
    )
}

fn activate_standard_root(
    h: &Harness<'_>,
    expiry: u32,
    amount: u64,
    node_byte: u8,
    note_byte: u8,
) -> (BytesN<32>, RootBudgetNoteInput) {
    let session_id = create_standard_session(h, expiry);
    let root = RootBudgetNoteInput {
        node_id: id(&h.env, node_byte),
        note_id: id(&h.env, note_byte),
        commitment: U256::from_u32(&h.env, 31),
    };
    h.env.mock_all_auths();
    h.controller
        .activate_standard_session(&session_id, &root, &amount);
    (session_id, root)
}

fn agent_account(h: &Harness<'_>) -> Address {
    deploy_contract(&h.env, h.agent_account_wasm_hash.clone())
}

fn deploy_contract(env: &Env, wasm_hash: BytesN<32>) -> Address {
    env.deployer()
        .with_address(Address::generate(env), id(env, 0))
        .deploy_contract(ContractExecutable::Wasm(wasm_hash), ())
}

fn delegation(
    env: &Env,
    owner: Address,
    child_node_byte: u8,
    child_note_byte: u8,
    amount: u64,
    remainder: Option<u8>,
) -> StandardDelegationInput {
    StandardDelegationInput {
        child_node_id: id(env, child_node_byte),
        child_note_id: id(env, child_note_byte),
        child_owner: owner,
        child_policy: NodePolicy {
            category_mask: 0b0011,
            allowed_actions_mask: 0b0011,
            expiry: 1_900,
            remaining_delegation_depth: 2,
        },
        child_commitment: U256::from_u32(env, 47),
        delegated_amount: amount,
        remainder_note_id: remainder.map(|byte| id(env, byte)),
        remainder_commitment: remainder.map(|_| U256::from_u32(env, 53)),
    }
}

fn standard_settlement_fixture(h: &Harness<'_>) -> (StandardSettlementInput, Address, Address) {
    let expiry = 2_000;
    let provider = Address::generate(&h.env);
    let service_id_hash = id(&h.env, 90);
    let provider_spp_public_key = U256::from_u32(&h.env, 67);
    let category_id = 1;
    let allowed_settlement_modes = 1;
    let approved_provider_root = h.controller.get_provider_policy_leaf(
        &provider,
        &provider_spp_public_key,
        &service_id_hash,
        &category_id,
        &allowed_settlement_modes,
    );
    let mut draft_policy = policy(&h.env, &h.asset, SettlementMode::Standard, expiry);
    draft_policy.approved_provider_root = approved_provider_root;

    h.env.mock_all_auths();
    let session_id = h.controller.create_session(
        &h.company,
        &h.asset,
        &SettlementMode::Standard,
        &draft_policy,
        &expiry,
    );
    let root = RootBudgetNoteInput {
        node_id: id(&h.env, 80),
        note_id: id(&h.env, 81),
        commitment: U256::from_u32(&h.env, 31),
    };
    h.controller
        .activate_standard_session(&session_id, &root, &1_000);

    let agent = agent_account(h);
    let child = delegation(&h.env, agent.clone(), 82, 83, 600, Some(84));
    h.controller
        .delegate_standard_root(&session_id, &root.note_id, &child);

    (
        StandardSettlementInput {
            payment_id: id(&h.env, 85),
            session_id,
            source_budget_note_id: child.child_note_id,
            amount_atomic: 100,
            provider: provider.clone(),
            provider_spp_public_key,
            service_id_hash,
            category_id,
            allowed_settlement_modes,
            usage_root: U256::from_u32(&h.env, 69),
            offer_reference_hash: id(&h.env, 91),
            remainder_budget_note_id: Some(id(&h.env, 86)),
            remainder_commitment: Some(U256::from_u32(&h.env, 71)),
        },
        agent,
        provider,
    )
}

struct PrivateFixture {
    session_id: BytesN<32>,
    source_node_id: BytesN<32>,
    source_note_id: BytesN<32>,
    agent: Address,
    input: PrivateReservationInput,
}

fn private_reservation_fixture(h: &Harness<'_>) -> PrivateFixture {
    let expiry = 2_000;
    h.env.mock_all_auths();
    let session_id = h.controller.create_session(
        &h.company,
        &h.asset,
        &SettlementMode::Private,
        &policy(&h.env, &h.asset, SettlementMode::Private, expiry),
        &expiry,
    );
    let agent = agent_account(h);
    let root_node_id = id(&h.env, 120);
    let root_note_id = id(&h.env, 121);
    let source_node_id = id(&h.env, 122);
    let source_note_id = id(&h.env, 123);
    let current_ledger = h.env.ledger().sequence();
    let mut session = h.controller.get_session(&session_id).unwrap();
    session.lifecycle = SessionLifecycle::Active;
    session.root_budget_node_id = Some(root_node_id.clone());
    session.root_budget_note_id = Some(root_note_id.clone());
    session.treasury_spp_key_commitment = Some(U256::from_u32(&h.env, 73));

    let root_node = BudgetNode {
        id: root_node_id.clone(),
        session_id: session_id.clone(),
        parent_node_id: None,
        owner: BudgetNodeOwner::RootCompany,
        depth: 0,
        node_policy: NodePolicy {
            category_mask: u64::MAX,
            allowed_actions_mask: 0b111,
            expiry,
            remaining_delegation_depth: 3,
        },
        branch_frozen: false,
        created_at_ledger: current_ledger,
        state: BudgetNodeState::Active,
    };
    let root_note = BudgetNoteState {
        id: root_note_id.clone(),
        session_id: session_id.clone(),
        node_id: root_node_id.clone(),
        owner: BudgetNodeOwner::RootCompany,
        policy_hash: session.policy_hash.clone(),
        commitment: U256::from_u32(&h.env, 29),
        state: BudgetNoteStatus::Spent,
        created_at_ledger: current_ledger,
        spent_at_ledger: Some(current_ledger),
    };
    let source_node = BudgetNode {
        id: source_node_id.clone(),
        session_id: session_id.clone(),
        parent_node_id: Some(root_node_id.clone()),
        owner: BudgetNodeOwner::AgentSmartAccount(agent.clone()),
        depth: 1,
        node_policy: NodePolicy {
            category_mask: 0b10,
            allowed_actions_mask: 0b100,
            expiry: 1_900,
            remaining_delegation_depth: 2,
        },
        branch_frozen: false,
        created_at_ledger: current_ledger,
        state: BudgetNodeState::Active,
    };
    let source_note = BudgetNoteState {
        id: source_note_id.clone(),
        session_id: session_id.clone(),
        node_id: source_node_id.clone(),
        owner: source_node.owner.clone(),
        policy_hash: session.policy_hash.clone(),
        commitment: U256::from_u32(&h.env, 31),
        state: BudgetNoteStatus::Active,
        created_at_ledger: current_ledger,
        spent_at_ledger: None,
    };
    let audit_state = SessionAuditState {
        session_id: session_id.clone(),
        total_spend_commitment: U256::from_u32(&h.env, 37),
        settlement_count: 0,
        unresolved_reservation_count: 0,
        audit_version: 1,
        policy_hash: session.policy_hash.clone(),
        finalized: false,
        final_snapshot_hash: None,
        standard_total_spend_atomic: None,
    };
    h.env.as_contract(&h.contract_id, || {
        h.env
            .storage()
            .persistent()
            .set(&DataKey::Session(session_id.clone()), &session);
        h.env
            .storage()
            .persistent()
            .set(&DataKey::BudgetNode(root_node_id), &root_node);
        h.env
            .storage()
            .persistent()
            .set(&DataKey::BudgetNote(root_note_id), &root_note);
        h.env
            .storage()
            .persistent()
            .set(&DataKey::BudgetNode(source_node_id.clone()), &source_node);
        h.env
            .storage()
            .persistent()
            .set(&DataKey::BudgetNote(source_note_id.clone()), &source_note);
        h.env
            .storage()
            .persistent()
            .set(&DataKey::SessionAudit(session_id.clone()), &audit_state);
    });

    PrivateFixture {
        session_id: session_id.clone(),
        source_node_id,
        source_note_id: source_note_id.clone(),
        agent,
        input: PrivateReservationInput {
            reservation_id: id(&h.env, 124),
            session_id,
            source_budget_note_id: source_note_id,
            category_id: 1,
            offer_commitment: U256::from_u32(&h.env, 41),
            voucher_signer_public_key: id(&h.env, 125),
            amount_commitment: U256::from_u32(&h.env, 43),
            provider_commitment: U256::from_u32(&h.env, 47),
            claim_deadline_ledger: 1_800,
            remainder_budget_note_id: Some(id(&h.env, 126)),
            remainder_commitment: Some(U256::from_u32(&h.env, 53)),
        },
    }
}

fn dummy_proof(env: &Env) -> Groth16Proof {
    Groth16Proof {
        a: Bn254G1Affine::from_array(env, &[0_u8; BN254_G1_SERIALIZED_SIZE]),
        b: Bn254G2Affine::from_array(env, &[0_u8; BN254_G2_SERIALIZED_SIZE]),
        c: Bn254G1Affine::from_array(env, &[0_u8; BN254_G1_SERIALIZED_SIZE]),
    }
}

fn private_settlement_fixture(h: &Harness<'_>) -> (PrivateFixture, PrivateSettlementInput) {
    let mut fixture = private_reservation_fixture(h);
    let signing_key = SigningKey::from_bytes(&[77_u8; 32]);
    fixture.input.voucher_signer_public_key =
        BytesN::from_array(&h.env, signing_key.verifying_key().as_bytes());
    h.env.mock_all_auths();
    h.controller
        .open_private_reservation(&fixture.input, &dummy_proof(&h.env));

    let voucher = PrivateVoucher {
        protocol_version: 1,
        voucher_version: 1,
        network_id: h.env.ledger().network_id(),
        treasury_controller: h.contract_id.clone(),
        session_id: fixture.session_id.clone(),
        reservation_id: fixture.input.reservation_id.clone(),
        sequence: 1,
        cumulative_amount_commitment: U256::from_u32(&h.env, 61),
        usage_root: U256::from_u32(&h.env, 67),
        offer_commitment: fixture.input.offer_commitment.clone(),
        expiry_ledger: 1_700,
    };
    let signing_bytes = crate::voucher::signing_bytes_v1(&h.env, &voucher).unwrap();
    let signing_payload: std::vec::Vec<u8> = signing_bytes.iter().collect();
    let voucher_signature =
        BytesN::from_array(&h.env, &signing_key.sign(&signing_payload).to_bytes());

    (
        fixture,
        PrivateSettlementInput {
            voucher,
            voucher_signature,
            binding_proof: dummy_proof(&h.env),
            spp_proof: SppProof {
                proof: dummy_proof(&h.env),
                root: U256::from_u32(&h.env, 79),
                input_nullifiers: soroban_sdk::vec![&h.env, U256::from_u32(&h.env, 83)],
                output_commitment0: U256::from_u32(&h.env, 89),
                output_commitment1: U256::from_u32(&h.env, 97),
                public_amount: U256::from_u32(&h.env, 0),
                ext_data_hash: id(&h.env, 131),
                asp_membership_root: U256::from_u32(&h.env, 101),
                asp_non_membership_root: U256::from_u32(&h.env, 103),
            },
            spp_ext_data: SppExtData {
                recipient: h.spp_pool.clone(),
                ext_amount: soroban_sdk::I256::from_i32(&h.env, 0),
                encrypted_output0: Bytes::from_slice(&h.env, b"provider-ciphertext"),
                encrypted_output1: Bytes::from_slice(&h.env, b"treasury-ciphertext"),
            },
            new_audit_total_commitment: U256::from_u32(&h.env, 107),
            refund_budget_note_id: Some(id(&h.env, 132)),
            refund_budget_commitment: Some(U256::from_u32(&h.env, 109)),
        },
    )
}

#[test]
fn create_session_requires_company_authorization() {
    let h = setup();
    let expiry = 2_000;

    let result = h.controller.try_create_session(
        &h.company,
        &h.asset,
        &SettlementMode::Standard,
        &policy(&h.env, &h.asset, SettlementMode::Standard, expiry),
        &expiry,
    );

    assert!(result.is_err());
}

#[test]
fn constructor_pins_the_budget_transition_verifier() {
    let h = setup();

    assert_eq!(
        h.controller.get_budget_transition_verifier(),
        h.budget_transition_verifier
    );
    assert_eq!(
        h.controller.get_private_binding_verifier(),
        h.private_binding_verifier
    );
    assert_eq!(h.controller.get_spp_pool(), h.spp_pool);
}

#[test]
fn create_session_records_the_exact_company_authorization() {
    let h = setup();
    let expiry = 2_000;
    let draft_policy = policy(&h.env, &h.asset, SettlementMode::Standard, expiry);

    h.env.mock_all_auths();
    h.controller.create_session(
        &h.company,
        &h.asset,
        &SettlementMode::Standard,
        &draft_policy,
        &expiry,
    );

    assert_eq!(
        h.env.auths(),
        [(
            h.company.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    h.contract_id.clone(),
                    Symbol::new(&h.env, "create_session"),
                    (
                        h.company.clone(),
                        h.asset.clone(),
                        SettlementMode::Standard,
                        draft_policy,
                        expiry,
                    )
                        .into_val(&h.env),
                )),
                sub_invocations: [].into(),
            },
        )]
    );
}

#[test]
fn create_session_rejects_policy_mismatch_and_noncanonical_fields() {
    let h = setup();
    let expiry = 2_000;
    h.env.mock_all_auths();

    let mut mismatched = policy(&h.env, &h.asset, SettlementMode::Standard, expiry);
    mismatched.session_expiry = expiry + 1;
    assert!(
        h.controller
            .try_create_session(
                &h.company,
                &h.asset,
                &SettlementMode::Standard,
                &mismatched,
                &expiry,
            )
            .is_err()
    );

    let mut noncanonical = policy(&h.env, &h.asset, SettlementMode::Standard, expiry);
    noncanonical.policy_hash = U256::from_parts(
        &h.env,
        0x3064_4e72_e131_a029,
        0xb850_45b6_8181_585d,
        0x2833_e848_79b9_7091,
        0x43e1_f593_f000_0001,
    );
    assert!(
        h.controller
            .try_create_session(
                &h.company,
                &h.asset,
                &SettlementMode::Standard,
                &noncanonical,
                &expiry,
            )
            .is_err()
    );
}

#[test]
fn standard_activation_moves_real_sac_and_materializes_company_root() {
    let h = setup();
    let expiry = 2_000;
    let session_id = create_standard_session(&h, expiry);
    let root = RootBudgetNoteInput {
        node_id: id(&h.env, 1),
        note_id: id(&h.env, 2),
        commitment: U256::from_u32(&h.env, 31),
    };
    h.env.mock_all_auths();
    h.controller
        .activate_standard_session(&session_id, &root, &4_000);

    assert_eq!(
        h.env.auths(),
        [(
            h.company.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    h.contract_id.clone(),
                    Symbol::new(&h.env, "activate_standard_session"),
                    (session_id.clone(), root.clone(), 4_000u64).into_val(&h.env),
                )),
                sub_invocations: [AuthorizedInvocation {
                    function: AuthorizedFunction::Contract((
                        h.asset.clone(),
                        Symbol::new(&h.env, "transfer"),
                        (h.company.clone(), h.contract_id.clone(), 4_000i128,).into_val(&h.env),
                    )),
                    sub_invocations: [].into(),
                }]
                .into(),
            },
        )]
    );

    assert_eq!(h.token.balance(&h.company), 6_000);
    assert_eq!(h.token.balance(&h.contract_id), 4_000);

    let session = h.controller.get_session(&session_id).unwrap();
    assert_eq!(session.lifecycle, SessionLifecycle::Active);
    assert_eq!(session.root_budget_node_id, Some(root.node_id.clone()));
    assert_eq!(session.root_budget_note_id, Some(root.note_id.clone()));

    let node = h.controller.get_budget_node(&root.node_id).unwrap();
    assert_eq!(node.owner, BudgetNodeOwner::RootCompany);
    assert_eq!(node.depth, 0);

    let note = h.controller.get_budget_note(&root.note_id).unwrap();
    assert_eq!(note.owner, BudgetNodeOwner::RootCompany);
    assert_eq!(note.state, BudgetNoteStatus::Active);
    assert_eq!(
        h.controller.get_standard_note_amount(&root.note_id),
        Some(4_000)
    );
    let audit = h.controller.get_audit_state(&session_id).unwrap();
    let expected_audit_commitment = crate::audit::total_commitment_v1(
        &h.env,
        &h.controller.get_audit_context_hash(&session_id),
        0,
        &U256::from_u32(&h.env, 0),
    )
    .unwrap();
    assert_eq!(audit.total_spend_commitment, expected_audit_commitment);
    assert_eq!(audit.standard_total_spend_atomic, Some(0));
    assert_eq!(audit.settlement_count, 0);
    assert_eq!(audit.audit_version, 1);
}

#[test]
fn budget_note_context_is_derived_from_stored_root_identity() {
    let h = setup();
    let expiry = 2_000;
    let (session_id, root) = activate_standard_root(&h, expiry, 2_000, 72, 73);
    let session = h.controller.get_session(&session_id).unwrap();
    let expected = crate::budget::context_hash_v1(
        &h.env,
        &crate::budget::BudgetContextV1 {
            protocol_version: 1,
            network_id: &h.env.ledger().network_id(),
            controller: &h.contract_id,
            session_id: &session_id,
            node_id: &root.node_id,
            owner: &h.company,
            asset: &h.asset,
            policy_hash: &session.policy_hash,
            note_id: &root.note_id,
        },
    )
    .unwrap();

    assert_eq!(
        h.controller.get_budget_note_context_hash(&root.note_id),
        expected
    );
}

#[test]
fn failed_sac_transfer_rolls_back_activation_state() {
    let h = setup();
    let expiry = 2_000;
    let session_id = create_standard_session(&h, expiry);
    let root = RootBudgetNoteInput {
        node_id: id(&h.env, 3),
        note_id: id(&h.env, 4),
        commitment: U256::from_u32(&h.env, 37),
    };

    h.env.mock_all_auths();
    assert!(
        h.controller
            .try_activate_standard_session(&session_id, &root, &20_000)
            .is_err()
    );

    assert_eq!(h.token.balance(&h.company), 10_000);
    assert_eq!(h.token.balance(&h.contract_id), 0);
    assert_eq!(
        h.controller.get_session(&session_id).unwrap().lifecycle,
        SessionLifecycle::Draft
    );
    assert!(h.controller.get_budget_node(&root.node_id).is_none());
    assert!(h.controller.get_budget_note(&root.note_id).is_none());
}

#[test]
fn standard_activation_uses_a_deterministic_public_audit_total() {
    let h = setup();
    let expiry = 2_000;
    let session_id = create_standard_session(&h, expiry);
    let root = RootBudgetNoteInput {
        node_id: id(&h.env, 74),
        note_id: id(&h.env, 75),
        commitment: U256::from_u32(&h.env, 61),
    };

    h.env.mock_all_auths();
    h.controller
        .activate_standard_session(&session_id, &root, &1_000);

    assert_eq!(h.token.balance(&h.company), 9_000);
    assert_eq!(h.token.balance(&h.contract_id), 1_000);
    assert_eq!(
        h.controller.get_session(&session_id).unwrap().lifecycle,
        SessionLifecycle::Active
    );
    assert!(h.controller.get_budget_note(&root.note_id).is_some());
    assert_eq!(
        h.controller
            .get_audit_state(&session_id)
            .unwrap()
            .standard_total_spend_atomic,
        Some(0)
    );
}

#[test]
fn activation_is_single_use_and_cannot_double_fund() {
    let h = setup();
    let expiry = 2_000;
    let session_id = create_standard_session(&h, expiry);
    let root = RootBudgetNoteInput {
        node_id: id(&h.env, 5),
        note_id: id(&h.env, 6),
        commitment: U256::from_u32(&h.env, 41),
    };

    h.env.mock_all_auths();
    h.controller
        .activate_standard_session(&session_id, &root, &2_000);
    assert!(
        h.controller
            .try_activate_standard_session(&session_id, &root, &2_000)
            .is_err()
    );

    assert_eq!(h.token.balance(&h.company), 8_000);
    assert_eq!(h.token.balance(&h.contract_id), 2_000);
}

#[test]
fn private_session_cannot_use_standard_activation() {
    let h = setup();
    let expiry = 2_000;
    h.env.mock_all_auths();
    let session_id = h.controller.create_session(
        &h.company,
        &h.asset,
        &SettlementMode::Private,
        &policy(&h.env, &h.asset, SettlementMode::Private, expiry),
        &expiry,
    );
    let root = RootBudgetNoteInput {
        node_id: id(&h.env, 7),
        note_id: id(&h.env, 8),
        commitment: U256::from_u32(&h.env, 43),
    };

    assert!(
        h.controller
            .try_activate_standard_session(&session_id, &root, &1_000)
            .is_err()
    );
    assert_eq!(h.token.balance(&h.contract_id), 0);
}

#[test]
fn company_delegates_only_a_bounded_root_amount_with_exact_auth() {
    let h = setup();
    let (session_id, root) = activate_standard_root(&h, 2_000, 1_000, 20, 21);
    let supervisor = agent_account(&h);
    let input = delegation(&h.env, supervisor.clone(), 22, 23, 600, Some(24));

    h.env.mock_all_auths();
    h.controller
        .delegate_standard_root(&session_id, &root.note_id, &input);

    assert_eq!(
        h.env.auths(),
        [(
            h.company.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    h.contract_id.clone(),
                    Symbol::new(&h.env, "delegate_standard_root"),
                    (session_id.clone(), root.note_id.clone(), input.clone()).into_val(&h.env),
                )),
                sub_invocations: [].into(),
            },
        )]
    );
    assert_eq!(
        h.env.events().all(),
        [BudgetDelegated {
            session_id: session_id.clone(),
            child_node_id: input.child_node_id.clone(),
            source_note_id: root.note_id.clone(),
            child_note_id: input.child_note_id.clone(),
            remainder_note_id: input.remainder_note_id.clone(),
            delegated_amount: 600,
        }
        .to_xdr(&h.env, &h.contract_id)]
    );

    assert_eq!(
        h.controller.get_budget_note(&root.note_id).unwrap().state,
        BudgetNoteStatus::Spent
    );
    let child_node = h.controller.get_budget_node(&input.child_node_id).unwrap();
    assert_eq!(child_node.parent_node_id, Some(root.node_id));
    assert_eq!(
        child_node.owner,
        BudgetNodeOwner::AgentSmartAccount(supervisor)
    );
    assert_eq!(child_node.depth, 1);
    assert_eq!(
        h.controller.get_standard_note_amount(&input.child_note_id),
        Some(600)
    );
    assert_eq!(
        h.controller
            .get_standard_note_amount(&input.remainder_note_id.unwrap()),
        Some(400)
    );
    assert_eq!(h.token.balance(&h.contract_id), 1_000);
}

#[test]
fn agent_owner_delegates_its_note_but_cannot_consume_root_authority() {
    let h = setup();
    let (session_id, root) = activate_standard_root(&h, 2_000, 1_000, 30, 31);
    let supervisor = agent_account(&h);
    let supervisor_input = delegation(&h.env, supervisor.clone(), 32, 33, 800, Some(34));
    h.env.mock_all_auths();
    h.controller
        .delegate_standard_root(&session_id, &root.note_id, &supervisor_input);

    let child = agent_account(&h);
    let mut child_input = delegation(&h.env, child.clone(), 35, 36, 300, Some(37));
    child_input.child_policy.remaining_delegation_depth = 1;
    h.env.mock_all_auths();
    h.controller.delegate_standard_budget(
        &session_id,
        &supervisor_input.child_note_id,
        &child_input,
    );

    assert_eq!(
        h.env.auths(),
        [(
            supervisor.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    h.contract_id.clone(),
                    Symbol::new(&h.env, "delegate_standard_budget"),
                    (
                        session_id.clone(),
                        supervisor_input.child_note_id.clone(),
                        child_input.clone(),
                    )
                        .into_val(&h.env),
                )),
                sub_invocations: [].into(),
            },
        )]
    );
    assert_eq!(
        h.controller
            .get_standard_note_amount(&child_input.child_note_id),
        Some(300)
    );
    assert_eq!(
        h.controller
            .get_standard_note_amount(&child_input.remainder_note_id.clone().unwrap()),
        Some(500)
    );
    assert_eq!(
        h.controller
            .get_budget_node(&child_input.child_node_id)
            .unwrap()
            .owner,
        BudgetNodeOwner::AgentSmartAccount(child)
    );

    let root_remainder = supervisor_input.remainder_note_id.unwrap();
    let illegal = delegation(&h.env, agent_account(&h), 38, 39, 50, Some(40));
    h.env.mock_all_auths();
    assert!(
        h.controller
            .try_delegate_standard_budget(&session_id, &root_remainder, &illegal)
            .is_err()
    );
    assert_eq!(
        h.controller.get_budget_note(&root_remainder).unwrap().state,
        BudgetNoteStatus::Active
    );
}

#[test]
fn delegation_rejects_policy_widening_without_consuming_the_note() {
    let h = setup();
    let (session_id, root) = activate_standard_root(&h, 2_000, 1_000, 50, 51);
    let mut input = delegation(&h.env, agent_account(&h), 52, 53, 600, Some(54));
    input.child_policy.allowed_actions_mask = 0b1000;

    h.env.mock_all_auths();
    assert!(
        h.controller
            .try_delegate_standard_root(&session_id, &root.note_id, &input)
            .is_err()
    );

    assert_eq!(
        h.controller.get_budget_note(&root.note_id).unwrap().state,
        BudgetNoteStatus::Active
    );
    assert!(h.controller.get_budget_node(&input.child_node_id).is_none());
    assert_eq!(
        h.controller.get_standard_note_amount(&root.note_id),
        Some(1_000)
    );
}

#[test]
fn delegation_requires_exact_conservation_and_remainder_shape() {
    let h = setup();
    let (session_id, root) = activate_standard_root(&h, 2_000, 1_000, 60, 61);
    let agent = agent_account(&h);

    let excessive = delegation(&h.env, agent.clone(), 62, 63, 1_001, None);
    h.env.mock_all_auths();
    assert!(
        h.controller
            .try_delegate_standard_root(&session_id, &root.note_id, &excessive)
            .is_err()
    );

    let missing_remainder = delegation(&h.env, agent.clone(), 64, 65, 600, None);
    assert!(
        h.controller
            .try_delegate_standard_root(&session_id, &root.note_id, &missing_remainder)
            .is_err()
    );

    let unexpected_remainder = delegation(&h.env, agent, 66, 67, 1_000, Some(68));
    assert!(
        h.controller
            .try_delegate_standard_root(&session_id, &root.note_id, &unexpected_remainder)
            .is_err()
    );

    assert_eq!(
        h.controller.get_budget_note(&root.note_id).unwrap().state,
        BudgetNoteStatus::Active
    );
    assert_eq!(h.token.balance(&h.contract_id), 1_000);
}

#[test]
fn delegation_rejects_spent_notes_duplicate_ids_and_non_contract_owners() {
    let h = setup();
    let (session_id, root) = activate_standard_root(&h, 2_000, 1_000, 70, 71);
    let first = delegation(&h.env, agent_account(&h), 72, 73, 1_000, None);
    h.env.mock_all_auths();
    h.controller
        .delegate_standard_root(&session_id, &root.note_id, &first);

    let retry = delegation(&h.env, agent_account(&h), 74, 75, 1_000, None);
    assert!(
        h.controller
            .try_delegate_standard_root(&session_id, &root.note_id, &retry)
            .is_err()
    );

    let duplicate = delegation(&h.env, agent_account(&h), 76, 72, 1_000, None);
    assert!(
        h.controller
            .try_delegate_standard_budget(&session_id, &first.child_note_id, &duplicate)
            .is_err()
    );

    let account_owner = Address::generate(&h.env);
    let invalid_owner = delegation(&h.env, account_owner, 77, 78, 1_000, None);
    assert!(
        h.controller
            .try_delegate_standard_budget(&session_id, &first.child_note_id, &invalid_owner)
            .is_err()
    );

    let wrong_wasm_hash = h.env.upload(WrongAgentImplementation);
    let wrong_contract = deploy_contract(&h.env, wrong_wasm_hash);
    let wrong_implementation = delegation(&h.env, wrong_contract, 79, 80, 1_000, None);
    assert!(
        h.controller
            .try_delegate_standard_budget(&session_id, &first.child_note_id, &wrong_implementation,)
            .is_err()
    );
    assert_eq!(
        h.controller
            .get_budget_note(&first.child_note_id)
            .unwrap()
            .state,
        BudgetNoteStatus::Active
    );
}

#[test]
fn delegation_rejects_after_session_expiry() {
    let h = setup();
    let (session_id, root) = activate_standard_root(&h, 2_000, 1_000, 80, 81);
    let input = delegation(&h.env, agent_account(&h), 82, 83, 1_000, None);
    h.env.ledger().set_sequence_number(2_000);

    h.env.mock_all_auths();
    assert!(
        h.controller
            .try_delegate_standard_root(&session_id, &root.note_id, &input)
            .is_err()
    );
    assert_eq!(
        h.controller.get_budget_note(&root.note_id).unwrap().state,
        BudgetNoteStatus::Active
    );
}

#[test]
fn delegation_requires_the_company_or_source_agent_authorization() {
    let h = setup();
    let (session_id, root) = activate_standard_root(&h, 2_000, 1_000, 90, 91);
    let supervisor = agent_account(&h);
    let supervisor_input = delegation(&h.env, supervisor, 92, 93, 800, Some(94));

    h.env.set_auths(&[]);
    assert!(
        h.controller
            .try_delegate_standard_root(&session_id, &root.note_id, &supervisor_input)
            .is_err()
    );
    assert_eq!(
        h.controller.get_budget_note(&root.note_id).unwrap().state,
        BudgetNoteStatus::Active
    );

    h.env.mock_all_auths();
    h.controller
        .delegate_standard_root(&session_id, &root.note_id, &supervisor_input);
    let mut child_input = delegation(&h.env, agent_account(&h), 95, 96, 800, None);
    child_input.child_policy.remaining_delegation_depth = 1;

    h.env.set_auths(&[]);
    assert!(
        h.controller
            .try_delegate_standard_budget(
                &session_id,
                &supervisor_input.child_note_id,
                &child_input,
            )
            .is_err()
    );
    assert_eq!(
        h.controller
            .get_budget_note(&supervisor_input.child_note_id)
            .unwrap()
            .state,
        BudgetNoteStatus::Active
    );
}

#[test]
fn delegation_rejects_frozen_session_and_source_branch() {
    let h = setup();
    let (session_id, root) = activate_standard_root(&h, 2_000, 1_000, 100, 101);
    let input = delegation(&h.env, agent_account(&h), 102, 103, 1_000, None);

    let mut session = h.controller.get_session(&session_id).unwrap();
    session.safety = SafetyState::Frozen;
    h.env.as_contract(&h.contract_id, || {
        h.env
            .storage()
            .persistent()
            .set(&DataKey::Session(session_id.clone()), &session);
    });
    h.env.mock_all_auths();
    assert!(
        h.controller
            .try_delegate_standard_root(&session_id, &root.note_id, &input)
            .is_err()
    );

    session.safety = SafetyState::Normal;
    let mut root_node = h.controller.get_budget_node(&root.node_id).unwrap();
    root_node.branch_frozen = true;
    h.env.as_contract(&h.contract_id, || {
        h.env
            .storage()
            .persistent()
            .set(&DataKey::Session(session_id.clone()), &session);
        h.env
            .storage()
            .persistent()
            .set(&DataKey::BudgetNode(root.node_id.clone()), &root_node);
    });
    assert!(
        h.controller
            .try_delegate_standard_root(&session_id, &root.note_id, &input)
            .is_err()
    );
    assert_eq!(
        h.controller.get_budget_note(&root.note_id).unwrap().state,
        BudgetNoteStatus::Active
    );
}

#[test]
fn root_activation_rejects_cross_type_identifier_reuse() {
    let h = setup();
    let (_first_session_id, first_root) = activate_standard_root(&h, 2_000, 1_000, 110, 111);
    let second_session_id = create_standard_session(&h, 2_000);
    let reused = RootBudgetNoteInput {
        node_id: first_root.note_id,
        note_id: id(&h.env, 112),
        commitment: U256::from_u32(&h.env, 59),
    };

    h.env.mock_all_auths();
    assert!(
        h.controller
            .try_activate_standard_session(&second_session_id, &reused, &500)
            .is_err()
    );
    assert_eq!(h.token.balance(&h.company), 9_000);
    assert_eq!(h.token.balance(&h.contract_id), 1_000);
    assert_eq!(
        h.controller
            .get_session(&second_session_id)
            .unwrap()
            .lifecycle,
        SessionLifecycle::Draft
    );
}

#[test]
fn standard_settlement_is_agent_authorized_atomic_and_single_use() {
    let h = setup();
    let (input, _agent, provider) = standard_settlement_fixture(&h);

    h.env.set_auths(&[]);
    assert!(h.controller.try_settle_standard_payment(&input).is_err());
    assert_eq!(h.token.balance(&provider), 0);
    assert_eq!(
        h.controller
            .get_budget_note(&input.source_budget_note_id)
            .unwrap()
            .state,
        BudgetNoteStatus::Active
    );

    h.env.mock_all_auths();
    let record = h.controller.settle_standard_payment(&input);
    assert_eq!(record.status, PaymentStatus::Settled);
    assert_eq!(record.amount_atomic, 100);
    assert_eq!(record.provider, provider);
    assert_eq!(h.token.balance(&provider), 100);
    assert_eq!(h.token.balance(&h.contract_id), 900);
    assert_eq!(
        h.controller
            .get_budget_note(&input.source_budget_note_id)
            .unwrap()
            .state,
        BudgetNoteStatus::Spent
    );
    let remainder_id = input.remainder_budget_note_id.clone().unwrap();
    assert_eq!(
        h.controller.get_budget_note(&remainder_id).unwrap().state,
        BudgetNoteStatus::Active
    );
    assert_eq!(
        h.controller.get_standard_note_amount(&remainder_id),
        Some(500)
    );
    assert_eq!(
        h.controller.get_payment_record(&input.payment_id),
        Some(record.clone())
    );
    let session = h.controller.get_session(&input.session_id).unwrap();
    let audit = h.controller.get_audit_state(&input.session_id).unwrap();
    assert_eq!(session.settlement_count, 1);
    assert_eq!(session.audit_version, 2);
    assert_eq!(audit.settlement_count, 1);
    assert_eq!(audit.audit_version, 2);
    assert_eq!(audit.standard_total_spend_atomic, Some(100));
    assert_eq!(
        audit.total_spend_commitment,
        crate::audit::total_commitment_v1(
            &h.env,
            &h.controller.get_audit_context_hash(&input.session_id),
            100,
            &U256::from_u32(&h.env, 0),
        )
        .unwrap()
    );

    assert!(h.controller.try_settle_standard_payment(&input).is_err());
    assert_eq!(h.token.balance(&provider), 100);
}

#[test]
fn standard_settlement_rejects_wrong_provider_service_category_and_action() {
    let h = setup();
    let (input, _agent, provider) = standard_settlement_fixture(&h);
    h.env.mock_all_auths();

    let mut wrong_provider = input.clone();
    wrong_provider.provider = Address::generate(&h.env);
    assert!(
        h.controller
            .try_settle_standard_payment(&wrong_provider)
            .is_err()
    );

    let mut wrong_service = input.clone();
    wrong_service.service_id_hash = id(&h.env, 92);
    assert!(
        h.controller
            .try_settle_standard_payment(&wrong_service)
            .is_err()
    );

    let mut wrong_category = input.clone();
    wrong_category.category_id = 2;
    assert!(
        h.controller
            .try_settle_standard_payment(&wrong_category)
            .is_err()
    );

    let source_note = h
        .controller
        .get_budget_note(&input.source_budget_note_id)
        .unwrap();
    let mut source_node = h.controller.get_budget_node(&source_note.node_id).unwrap();
    source_node.node_policy.allowed_actions_mask = 1;
    h.env.as_contract(&h.contract_id, || {
        h.env
            .storage()
            .persistent()
            .set(&DataKey::BudgetNode(source_node.id.clone()), &source_node);
    });
    assert!(h.controller.try_settle_standard_payment(&input).is_err());

    assert_eq!(h.token.balance(&provider), 0);
    assert!(h.controller.get_payment_record(&input.payment_id).is_none());
    assert_eq!(
        h.controller
            .get_budget_note(&input.source_budget_note_id)
            .unwrap()
            .state,
        BudgetNoteStatus::Active
    );
    assert_eq!(
        h.controller
            .get_audit_state(&input.session_id)
            .unwrap()
            .settlement_count,
        0
    );
}

#[test]
fn standard_settlement_updates_the_public_audit_total_without_a_proof() {
    let h = setup();
    let (input, _agent, provider) = standard_settlement_fixture(&h);
    h.env.mock_all_auths();

    h.controller.settle_standard_payment(&input);
    assert_eq!(h.token.balance(&provider), 100);
    assert_eq!(h.token.balance(&h.contract_id), 900);
    assert!(h.controller.get_payment_record(&input.payment_id).is_some());
    assert_eq!(
        h.controller
            .get_budget_note(&input.source_budget_note_id)
            .unwrap()
            .state,
        BudgetNoteStatus::Spent
    );
}

#[test]
fn failed_provider_transfer_leaves_no_partial_settlement_state() {
    let h = setup();
    let (input, _agent, provider) = standard_settlement_fixture(&h);
    h.env.mock_all_auths();
    StellarAssetClient::new(&h.env, &h.asset).burn(&h.contract_id, &1_000);

    assert!(h.controller.try_settle_standard_payment(&input).is_err());
    assert_eq!(h.token.balance(&provider), 0);
    assert!(h.controller.get_payment_record(&input.payment_id).is_none());
    assert!(
        h.controller
            .get_budget_note(&input.remainder_budget_note_id.unwrap())
            .is_none()
    );
    assert_eq!(
        h.controller
            .get_budget_note(&input.source_budget_note_id)
            .unwrap()
            .state,
        BudgetNoteStatus::Active
    );
    assert_eq!(
        h.controller
            .get_audit_state(&input.session_id)
            .unwrap()
            .settlement_count,
        0
    );
}

#[test]
fn private_reservation_is_agent_authorized_and_consumes_the_source_once() {
    let h = setup_with_budget_verifier(true);
    let fixture = private_reservation_fixture(&h);
    let proof = dummy_proof(&h.env);

    h.env.set_auths(&[]);
    assert!(
        h.controller
            .try_open_private_reservation(&fixture.input, &proof)
            .is_err()
    );
    assert_eq!(
        h.controller
            .get_budget_note(&fixture.source_note_id)
            .unwrap()
            .state,
        BudgetNoteStatus::Active
    );

    h.env.mock_all_auths();
    let reservation = h
        .controller
        .open_private_reservation(&fixture.input, &proof);

    assert_eq!(reservation.status, PrivateReservationStatus::Open);
    assert_eq!(reservation.source_agent, fixture.agent);
    assert_eq!(reservation.source_node_id, fixture.source_node_id);
    assert_eq!(
        reservation.amount_commitment,
        fixture.input.amount_commitment
    );
    assert_eq!(
        reservation.provider_commitment,
        fixture.input.provider_commitment
    );
    assert_eq!(
        h.controller
            .get_private_reservation(&fixture.input.reservation_id),
        Some(reservation)
    );
    assert_eq!(
        h.controller
            .get_budget_note(&fixture.source_note_id)
            .unwrap()
            .state,
        BudgetNoteStatus::Spent
    );
    assert_eq!(
        h.controller
            .get_budget_note(&fixture.input.remainder_budget_note_id.clone().unwrap())
            .unwrap()
            .state,
        BudgetNoteStatus::Active
    );
    let session = h.controller.get_session(&fixture.session_id).unwrap();
    let audit = h.controller.get_audit_state(&fixture.session_id).unwrap();
    assert_eq!(session.unresolved_reservation_count, 1);
    assert_eq!(audit.unresolved_reservation_count, 1);
    assert_eq!(session.settlement_count, audit.settlement_count);
    assert_eq!(session.audit_version, audit.audit_version);

    assert!(
        h.controller
            .try_open_private_reservation(&fixture.input, &proof)
            .is_err()
    );
}

#[test]
fn rejected_private_reservation_proof_rolls_back_all_state() {
    let h = setup_with_budget_verifier(false);
    let fixture = private_reservation_fixture(&h);
    h.env.mock_all_auths();

    assert!(
        h.controller
            .try_open_private_reservation(&fixture.input, &dummy_proof(&h.env))
            .is_err()
    );
    assert!(
        h.controller
            .get_private_reservation(&fixture.input.reservation_id)
            .is_none()
    );
    assert!(
        h.controller
            .get_budget_note(&fixture.input.remainder_budget_note_id.unwrap())
            .is_none()
    );
    assert_eq!(
        h.controller
            .get_budget_note(&fixture.source_note_id)
            .unwrap()
            .state,
        BudgetNoteStatus::Active
    );
    assert_eq!(
        h.controller
            .get_session(&fixture.session_id)
            .unwrap()
            .unresolved_reservation_count,
        0
    );
    assert_eq!(
        h.controller
            .get_audit_state(&fixture.session_id)
            .unwrap()
            .unresolved_reservation_count,
        0
    );
}

#[test]
fn private_reservation_can_consume_the_full_hidden_budget_note() {
    let h = setup_with_budget_verifier(true);
    let mut fixture = private_reservation_fixture(&h);
    fixture.input.remainder_budget_note_id = None;
    fixture.input.remainder_commitment = None;
    h.env.mock_all_auths();

    let reservation = h
        .controller
        .open_private_reservation(&fixture.input, &dummy_proof(&h.env));

    assert_eq!(reservation.status, PrivateReservationStatus::Open);
    assert_eq!(
        h.controller
            .get_budget_note(&fixture.source_note_id)
            .unwrap()
            .state,
        BudgetNoteStatus::Spent
    );
    assert_eq!(
        h.controller
            .get_session(&fixture.session_id)
            .unwrap()
            .unresolved_reservation_count,
        1
    );
}

#[test]
fn payment_commitment_key_cannot_be_reused_across_private_reservations() {
    let h = setup_with_budget_verifier(true);
    let fixture = private_reservation_fixture(&h);
    h.env.mock_all_auths();
    h.controller
        .open_private_reservation(&fixture.input, &dummy_proof(&h.env));

    let second_note_id = id(&h.env, 127);
    let second_note = BudgetNoteState {
        id: second_note_id.clone(),
        session_id: fixture.session_id.clone(),
        node_id: fixture.source_node_id,
        owner: BudgetNodeOwner::AgentSmartAccount(fixture.agent),
        policy_hash: h
            .controller
            .get_session(&fixture.session_id)
            .unwrap()
            .policy_hash,
        commitment: U256::from_u32(&h.env, 59),
        state: BudgetNoteStatus::Active,
        created_at_ledger: h.env.ledger().sequence(),
        spent_at_ledger: None,
    };
    h.env.as_contract(&h.contract_id, || {
        h.env
            .storage()
            .persistent()
            .set(&DataKey::BudgetNote(second_note_id.clone()), &second_note);
    });

    let mut second_input = fixture.input.clone();
    second_input.reservation_id = id(&h.env, 128);
    second_input.source_budget_note_id = second_note_id.clone();
    second_input.remainder_budget_note_id = Some(id(&h.env, 129));
    assert!(
        h.controller
            .try_open_private_reservation(&second_input, &dummy_proof(&h.env))
            .is_err()
    );
    assert!(
        h.controller
            .get_private_reservation(&second_input.reservation_id)
            .is_none()
    );
    assert_eq!(
        h.controller.get_budget_note(&second_note_id).unwrap().state,
        BudgetNoteStatus::Active
    );
    assert_eq!(
        h.controller
            .get_session(&fixture.session_id)
            .unwrap()
            .unresolved_reservation_count,
        1
    );
}

#[test]
fn reservation_specific_key_signs_only_the_canonical_private_voucher() {
    let h = setup_with_budget_verifier(true);
    let mut fixture = private_reservation_fixture(&h);
    let signing_key = SigningKey::from_bytes(&[77_u8; 32]);
    fixture.input.voucher_signer_public_key =
        BytesN::from_array(&h.env, signing_key.verifying_key().as_bytes());
    h.env.mock_all_auths();
    h.controller
        .open_private_reservation(&fixture.input, &dummy_proof(&h.env));

    let voucher = PrivateVoucher {
        protocol_version: 1,
        voucher_version: 1,
        network_id: h.env.ledger().network_id(),
        treasury_controller: h.contract_id.clone(),
        session_id: fixture.session_id,
        reservation_id: fixture.input.reservation_id,
        sequence: 1,
        cumulative_amount_commitment: U256::from_u32(&h.env, 61),
        usage_root: U256::from_u32(&h.env, 67),
        offer_commitment: fixture.input.offer_commitment,
        expiry_ledger: 1_700,
    };
    let signing_bytes = crate::voucher::signing_bytes_v1(&h.env, &voucher).unwrap();
    let signing_payload: std::vec::Vec<u8> = signing_bytes.iter().collect();
    let signature = BytesN::from_array(&h.env, &signing_key.sign(&signing_payload).to_bytes());

    assert!(h.controller.verify_private_voucher(&voucher, &signature));

    let mut mutated = voucher.clone();
    mutated.usage_root = U256::from_u32(&h.env, 71);
    assert!(
        h.controller
            .try_verify_private_voucher(&mutated, &signature)
            .is_err()
    );

    let mut wrong_context = voucher;
    wrong_context.treasury_controller = Address::generate(&h.env);
    assert!(
        h.controller
            .try_verify_private_voucher(&wrong_context, &signature)
            .is_err()
    );
}

#[test]
fn private_settlement_atomically_updates_spp_reservation_refund_and_audit_state() {
    let h = setup_with_private_settlement();
    let (fixture, input) = private_settlement_fixture(&h);
    h.env.mock_all_auths();

    let record = h.controller.settle_private_payment(&input);

    assert_eq!(record.status, PaymentStatus::Settled);
    assert_eq!(record.reservation_id, fixture.input.reservation_id);
    assert_eq!(
        record.provider_spp_output_commitment,
        input.spp_proof.output_commitment0
    );
    assert_eq!(
        record.spp_refund_output_commitment,
        input.spp_proof.output_commitment1
    );
    assert_eq!(
        h.controller
            .get_private_reservation(&record.reservation_id)
            .unwrap()
            .status,
        PrivateReservationStatus::Settled
    );
    assert_eq!(
        h.controller
            .get_private_payment_record(&record.reservation_id),
        Some(record.clone())
    );
    assert_eq!(
        h.controller
            .get_budget_note(&input.refund_budget_note_id.clone().unwrap())
            .unwrap()
            .state,
        BudgetNoteStatus::Active
    );
    let session = h.controller.get_session(&fixture.session_id).unwrap();
    let audit = h.controller.get_audit_state(&fixture.session_id).unwrap();
    assert_eq!(session.unresolved_reservation_count, 0);
    assert_eq!(session.settlement_count, 1);
    assert_eq!(session.audit_version, 2);
    assert_eq!(audit.unresolved_reservation_count, 0);
    assert_eq!(audit.settlement_count, 1);
    assert_eq!(audit.audit_version, 2);
    assert_eq!(
        audit.total_spend_commitment,
        input.new_audit_total_commitment
    );
    assert_eq!(
        MockSppPoolClient::new(&h.env, &h.spp_pool).get_last_output0(),
        Some(input.spp_proof.output_commitment0.clone())
    );

    assert!(h.controller.try_settle_private_payment(&input).is_err());
}

#[test]
fn failed_spp_private_settlement_rolls_back_every_protocol_and_pool_write() {
    let h = setup_with_private_settlement();
    let (fixture, mut input) = private_settlement_fixture(&h);
    input.spp_proof.root = U256::from_u32(&h.env, 999);
    h.env.mock_all_auths();

    assert!(h.controller.try_settle_private_payment(&input).is_err());
    assert_eq!(
        MockSppPoolClient::new(&h.env, &h.spp_pool).get_last_output0(),
        None
    );
    assert_eq!(
        h.controller
            .get_private_reservation(&fixture.input.reservation_id)
            .unwrap()
            .status,
        PrivateReservationStatus::Open
    );
    assert!(
        h.controller
            .get_private_payment_record(&fixture.input.reservation_id)
            .is_none()
    );
    assert!(
        h.controller
            .get_budget_note(&input.refund_budget_note_id.unwrap())
            .is_none()
    );
    let session = h.controller.get_session(&fixture.session_id).unwrap();
    let audit = h.controller.get_audit_state(&fixture.session_id).unwrap();
    assert_eq!(session.unresolved_reservation_count, 1);
    assert_eq!(session.settlement_count, 0);
    assert_eq!(session.audit_version, 1);
    assert_eq!(audit.unresolved_reservation_count, 1);
    assert_eq!(audit.settlement_count, 0);
    assert_eq!(audit.audit_version, 1);
    assert_eq!(audit.total_spend_commitment, U256::from_u32(&h.env, 37));
}

#[test]
fn private_reservation_rejects_expired_or_ungranted_authority() {
    let h = setup_with_budget_verifier(true);
    let fixture = private_reservation_fixture(&h);
    h.env.mock_all_auths();

    let mut source_node = h
        .controller
        .get_budget_node(&fixture.source_node_id)
        .unwrap();
    source_node.node_policy.allowed_actions_mask = 0;
    h.env.as_contract(&h.contract_id, || {
        h.env.storage().persistent().set(
            &DataKey::BudgetNode(fixture.source_node_id.clone()),
            &source_node,
        );
    });
    assert!(
        h.controller
            .try_open_private_reservation(&fixture.input, &dummy_proof(&h.env))
            .is_err()
    );

    source_node.node_policy.allowed_actions_mask = 0b100;
    h.env.as_contract(&h.contract_id, || {
        h.env.storage().persistent().set(
            &DataKey::BudgetNode(fixture.source_node_id.clone()),
            &source_node,
        );
    });
    let mut expired = fixture.input.clone();
    expired.claim_deadline_ledger = h.env.ledger().sequence();
    assert!(
        h.controller
            .try_open_private_reservation(&expired, &dummy_proof(&h.env))
            .is_err()
    );
    assert!(
        h.controller
            .get_private_reservation(&fixture.input.reservation_id)
            .is_none()
    );
    assert_eq!(
        h.controller
            .get_budget_note(&fixture.source_note_id)
            .unwrap()
            .state,
        BudgetNoteStatus::Active
    );
}
