extern crate std;

use soroban_sdk::{
    Address, Bytes, BytesN, Env, IntoVal, Map, Symbol, TryFromVal, Val, Vec,
    auth::{Context, ContractContext},
    contract, contractimpl,
    testutils::{Address as _, Ledger},
    vec,
};
use stellar_accounts::smart_account::{AuthPayload, ContextRuleType, Signer, SmartAccountError};

use crate::{AgentAccount, AgentAccountClient};

#[contract]
struct MockVerifier;

#[contractimpl]
impl MockVerifier {
    pub fn verify(_env: &Env, _hash: Bytes, _key_data: Val, _sig_data: Val) -> bool {
        true
    }

    pub fn canonicalize_key(env: &Env, key_data: Val) -> Bytes {
        Bytes::try_from_val(env, &key_data).unwrap()
    }

    pub fn batch_canonicalize_key(env: &Env, key_data: Vec<Val>) -> Vec<Bytes> {
        Vec::from_iter(
            env,
            key_data
                .iter()
                .map(|key| Bytes::try_from_val(env, &key).unwrap()),
        )
    }
}

struct Harness<'a> {
    env: Env,
    account_id: Address,
    account: AgentAccountClient<'a>,
    treasury: Address,
    verifier: Address,
    public_key: BytesN<32>,
    valid_until: u32,
}

fn setup<'a>() -> Harness<'a> {
    let env = Env::default();
    env.ledger().set_sequence_number(1_000);
    let treasury = Address::generate(&env);
    let verifier = env.register(MockVerifier, ());
    let public_key = BytesN::from_array(&env, &[7u8; 32]);
    let valid_until = 2_000;
    let account_id = env.register(
        AgentAccount,
        (
            treasury.clone(),
            verifier.clone(),
            public_key.clone(),
            valid_until,
        ),
    );
    let account = AgentAccountClient::new(&env, &account_id);

    Harness {
        env,
        account_id,
        account,
        treasury,
        verifier,
        public_key,
        valid_until,
    }
}

fn auth_payload(env: &Env, signer: Signer) -> AuthPayload {
    let mut signatures = Map::new(env);
    signatures.set(signer, Bytes::from_array(env, &[1u8; 64]));
    AuthPayload {
        signers: signatures,
        context_rule_ids: vec![env, 0u32],
    }
}

fn contract_context(env: &Env, contract: Address) -> Context {
    Context::Contract(ContractContext {
        contract,
        fn_name: Symbol::new(env, "agent_operation"),
        args: ().into_val(env),
    })
}

#[test]
fn constructor_creates_only_the_scoped_agent_rule() {
    let h = setup();
    let rule = h.account.get_context_rule(&0);
    let expected_signer = Signer::External(h.verifier.clone(), Bytes::from(h.public_key));

    assert_eq!(h.account.get_context_rules_count(), 1);
    assert_eq!(rule.context_type, ContextRuleType::CallContract(h.treasury));
    assert_eq!(rule.signers, Vec::from_array(&h.env, [expected_signer]));
    assert_eq!(rule.policies.len(), 0);
    assert_eq!(rule.valid_until, Some(h.valid_until));
}

#[test]
fn accepts_the_treasury_context_and_rejects_a_different_contract() {
    let h = setup();
    let signer = Signer::External(h.verifier.clone(), Bytes::from(h.public_key.clone()));
    let payload = auth_payload(&h.env, signer);
    let signature_payload = BytesN::from_array(&h.env, &[3u8; 32]);

    assert_eq!(
        h.env.try_invoke_contract_check_auth::<SmartAccountError>(
            &h.account_id,
            &signature_payload,
            payload.clone().into_val(&h.env),
            &Vec::from_array(&h.env, [contract_context(&h.env, h.treasury.clone())]),
        ),
        Ok(())
    );

    let other_contract = Address::generate(&h.env);
    assert_eq!(
        h.env.try_invoke_contract_check_auth::<SmartAccountError>(
            &h.account_id,
            &signature_payload,
            payload.into_val(&h.env),
            &Vec::from_array(&h.env, [contract_context(&h.env, other_contract)]),
        ),
        Err(Ok(SmartAccountError::UnvalidatedContext))
    );
}

#[test]
fn rejects_the_scoped_rule_after_session_expiry() {
    let h = setup();
    let signer = Signer::External(h.verifier.clone(), Bytes::from(h.public_key));
    let payload = auth_payload(&h.env, signer);
    let signature_payload = BytesN::from_array(&h.env, &[5u8; 32]);
    h.env
        .ledger()
        .set_sequence_number(h.valid_until.saturating_add(1));

    assert_eq!(
        h.env.try_invoke_contract_check_auth::<SmartAccountError>(
            &h.account_id,
            &signature_payload,
            payload.into_val(&h.env),
            &Vec::from_array(&h.env, [contract_context(&h.env, h.treasury)]),
        ),
        Err(Ok(SmartAccountError::UnvalidatedContext))
    );
}
