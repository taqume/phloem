extern crate std;

use soroban_sdk::{
    Address, BytesN, Env, IntoVal, Symbol, U256,
    testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation, Ledger},
    token::{StellarAssetClient, TokenClient},
};

use crate::{
    BudgetNodeOwner, BudgetNoteStatus, RootBudgetNoteInput, SessionLifecycle, SessionPolicy,
    SettlementMode, TreasuryController, TreasuryControllerClient,
};

struct Harness<'a> {
    env: Env,
    contract_id: Address,
    controller: TreasuryControllerClient<'a>,
    company: Address,
    asset: Address,
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

    let contract_id = env.register(TreasuryController, (asset.clone(),));
    let controller = TreasuryControllerClient::new(&env, &contract_id);
    let token = TokenClient::new(&env, &asset);

    Harness {
        env,
        contract_id,
        controller,
        company,
        asset,
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
