extern crate std;

use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{Bytes, BytesN, Env};

use crate::{Ed25519Verifier, Ed25519VerifierClient};

#[test]
fn verifies_a_real_ed25519_signature() {
    let env = Env::default();
    let contract_id = env.register(Ed25519Verifier, ());
    let client = Ed25519VerifierClient::new(&env, &contract_id);
    let signing_key = SigningKey::from_bytes(&[7u8; 32]);
    let payload_bytes = [11u8; 32];
    let payload = Bytes::from_array(&env, &payload_bytes);
    let signature = signing_key.sign(&payload_bytes);
    let public_key = BytesN::from_array(&env, signing_key.verifying_key().as_bytes());
    let signature = BytesN::from_array(&env, &signature.to_bytes());

    assert!(client.verify(&payload, &public_key, &signature));
    assert_eq!(
        client.canonicalize_key(&public_key),
        Bytes::from_array(&env, signing_key.verifying_key().as_bytes())
    );
}

#[test]
fn rejects_a_signature_for_a_different_payload() {
    let env = Env::default();
    let contract_id = env.register(Ed25519Verifier, ());
    let client = Ed25519VerifierClient::new(&env, &contract_id);
    let signing_key = SigningKey::from_bytes(&[9u8; 32]);
    let signed_payload_bytes = [13u8; 32];
    let different_payload = Bytes::from_array(&env, &[14u8; 32]);
    let signature = signing_key.sign(&signed_payload_bytes);
    let public_key = BytesN::from_array(&env, signing_key.verifying_key().as_bytes());
    let signature = BytesN::from_array(&env, &signature.to_bytes());

    assert!(
        client
            .try_verify(&different_payload, &public_key, &signature)
            .is_err()
    );
}
