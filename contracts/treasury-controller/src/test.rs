extern crate std;

use soroban_sdk::{
    Address, BytesN, ContractExecutable, Env, Event as _, IntoVal, Symbol, U256, contract,
    contractimpl,
    testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation, Events as _, Ledger},
    token::{StellarAssetClient, TokenClient},
};

use crate::{
    BudgetNodeOwner, BudgetNoteStatus, NodePolicy, RootBudgetNoteInput, SafetyState,
    SessionLifecycle, SessionPolicy, SettlementMode, StandardDelegationInput, TreasuryController,
    TreasuryControllerClient, event::BudgetDelegated, storage::DataKey,
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

struct Harness<'a> {
    env: Env,
    contract_id: Address,
    controller: TreasuryControllerClient<'a>,
    company: Address,
    asset: Address,
    agent_account_wasm_hash: BytesN<32>,
    token: TokenClient<'a>,
}

fn setup<'a>() -> Harness<'a> {
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
    let contract_id = env.register(
        TreasuryController,
        (asset.clone(), agent_account_wasm_hash.clone()),
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
