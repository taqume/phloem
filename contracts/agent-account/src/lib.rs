#![no_std]

use soroban_sdk::{
    Address, Bytes, BytesN, Env, Map, String, Val, Vec,
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractimpl, panic_with_error,
};
use stellar_accounts::smart_account::{
    self, AuthPayload, ContextRule, ContextRuleType, Signer, SmartAccount, SmartAccountError,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum AgentAccountError {
    InvalidExpiry = 1,
}

#[contract]
pub struct AgentAccount;

#[contractimpl]
impl AgentAccount {
    pub fn __constructor(
        env: &Env,
        treasury_controller: Address,
        ed25519_verifier: Address,
        agent_public_key: BytesN<32>,
        valid_until: u32,
    ) {
        if valid_until <= env.ledger().sequence() {
            panic_with_error!(env, AgentAccountError::InvalidExpiry);
        }

        let signer = Signer::External(ed25519_verifier, Bytes::from(agent_public_key));
        smart_account::add_context_rule(
            env,
            &ContextRuleType::CallContract(treasury_controller),
            &String::from_str(env, "phloem-agent"),
            Some(valid_until),
            &Vec::from_array(env, [signer]),
            &Map::<Address, Val>::new(env),
        );
    }
}

#[contractimpl]
impl CustomAccountInterface for AgentAccount {
    type Error = SmartAccountError;
    type Signature = AuthPayload;

    fn __check_auth(
        env: Env,
        signature_payload: soroban_sdk::crypto::Hash<32>,
        signatures: AuthPayload,
        auth_contexts: Vec<Context>,
    ) -> Result<(), Self::Error> {
        smart_account::do_check_auth(&env, &signature_payload, &signatures, &auth_contexts)
    }
}

#[contractimpl(contracttrait)]
impl SmartAccount for AgentAccount {}

#[cfg(test)]
mod test;
