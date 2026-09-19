#![no_std]

use soroban_sdk::{Bytes, BytesN, Env, Vec, contract, contractimpl};
use stellar_accounts::verifiers::{Verifier, ed25519};

#[contract]
pub struct Ed25519Verifier;

#[contractimpl]
impl Verifier for Ed25519Verifier {
    type KeyData = BytesN<32>;
    type SigData = BytesN<64>;

    fn verify(
        env: &Env,
        signature_payload: Bytes,
        key_data: BytesN<32>,
        sig_data: BytesN<64>,
    ) -> bool {
        ed25519::verify(env, &signature_payload, &key_data, &sig_data)
    }

    fn canonicalize_key(env: &Env, key_data: BytesN<32>) -> Bytes {
        ed25519::canonicalize_key(env, &key_data)
    }

    fn batch_canonicalize_key(env: &Env, keys_data: Vec<BytesN<32>>) -> Vec<Bytes> {
        ed25519::batch_canonicalize_key(env, &keys_data)
    }
}

#[cfg(test)]
mod test;
