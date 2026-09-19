use soroban_sdk::{Address, BytesN, Env, contracttype, panic_with_error};

use crate::Error;

const ARCHIVE_BUFFER_LEDGERS: u32 = 17_280;

#[contracttype]
#[derive(Clone)]
pub struct Config {
    pub standard_asset: Address,
    pub agent_account_wasm_hash: BytesN<32>,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    NextSessionNonce,
    Session(BytesN<32>),
    SessionPolicy(BytesN<32>),
    BudgetNode(BytesN<32>),
    BudgetNote(BytesN<32>),
    StandardNoteAmount(BytesN<32>),
}

pub fn get_config(env: &Env) -> Config {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .unwrap_or_else(|| panic_with_error!(env, Error::InvalidPolicy))
}

pub fn get_next_session_nonce(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::NextSessionNonce)
        .unwrap_or(0)
}

pub fn increment_session_nonce(env: &Env, current: u64) {
    let next = current
        .checked_add(1)
        .unwrap_or_else(|| panic_with_error!(env, Error::CounterOverflow));
    env.storage()
        .instance()
        .set(&DataKey::NextSessionNonce, &next);
}

pub fn extend_persistent_ttl(env: &Env, key: &DataKey, expires_at: u32) {
    let extend_to = desired_ttl(env, expires_at);
    env.storage()
        .persistent()
        .extend_ttl_with_limits(key, extend_to, 1, extend_to);
}

pub fn extend_instance_ttl(env: &Env, expires_at: u32) {
    let extend_to = desired_ttl(env, expires_at);
    env.storage()
        .instance()
        .extend_ttl_with_limits(extend_to, 1, extend_to);
}

fn desired_ttl(env: &Env, expires_at: u32) -> u32 {
    expires_at
        .saturating_sub(env.ledger().sequence())
        .saturating_add(ARCHIVE_BUFFER_LEDGERS)
}
