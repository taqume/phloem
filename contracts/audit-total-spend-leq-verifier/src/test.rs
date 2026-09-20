extern crate std;

use ark_bn254::{Fq, Fq2, Fr as ArkFr};
use ark_ff::{BigInteger, PrimeField};
use serde::Deserialize;
use soroban_sdk::{
    Bytes, BytesN, Env, U256, Vec, contract, contractimpl,
    crypto::bn254::{
        BN254_G1_SERIALIZED_SIZE, BN254_G2_SERIALIZED_SIZE, Bn254G1Affine, Bn254G2Affine,
    },
    vec,
};
use std::str::FromStr;

use crate::{
    AuditTotalSpendLeqVerifier, AuditTotalSpendLeqVerifierClient, Error, Proof, VerificationKey,
};

const VK_JSON: &str = include_str!("../test-fixtures/verification_key.json");
const PROOF_JSON: &str = include_str!("../test-fixtures/proof.json");
const PUBLIC_JSON: &str = include_str!("../test-fixtures/public.json");

#[contract]
struct MockFinalAuditController;

#[contractimpl]
impl MockFinalAuditController {
    pub fn __constructor(env: Env, expected_session_id: BytesN<32>, public_inputs: Vec<U256>) {
        env.storage().instance().set(&0u32, &expected_session_id);
        env.storage().instance().set(&1u32, &public_inputs);
    }

    pub fn get_total_spend_leq_inputs(
        env: Env,
        session_id: BytesN<32>,
        threshold_atomic: u64,
    ) -> Vec<U256> {
        let expected_session_id: BytesN<32> = env.storage().instance().get(&0u32).unwrap();
        let mut inputs: Vec<U256> = env.storage().instance().get(&1u32).unwrap();
        inputs.set(4, U256::from_u128(&env, threshold_atomic as u128));
        if session_id != expected_session_id {
            inputs.set(1, inputs.get_unchecked(1).add(&U256::from_u32(&env, 1)));
        }
        inputs
    }
}

#[contract]
struct MalformedAuditController;

#[contractimpl]
impl MalformedAuditController {
    pub fn get_total_spend_leq_inputs(
        env: Env,
        _session_id: BytesN<32>,
        _threshold_atomic: u64,
    ) -> Vec<U256> {
        vec![&env, U256::from_u32(&env, 1)]
    }
}

#[derive(Deserialize)]
struct VerificationKeyJson {
    vk_alpha_1: [std::string::String; 3],
    vk_beta_2: [[std::string::String; 2]; 3],
    vk_gamma_2: [[std::string::String; 2]; 3],
    vk_delta_2: [[std::string::String; 2]; 3],
    #[serde(rename = "IC")]
    ic: std::vec::Vec<[std::string::String; 3]>,
}

#[derive(Deserialize)]
struct ProofJson {
    pi_a: [std::string::String; 3],
    pi_b: [[std::string::String; 2]; 3],
    pi_c: [std::string::String; 3],
}

struct Fixture {
    verification_key: VerificationKey,
    proof: Proof,
    public_inputs: Vec<U256>,
}

fn fixture(env: &Env) -> Fixture {
    let vk: VerificationKeyJson = serde_json::from_str(VK_JSON).unwrap();
    let proof: ProofJson = serde_json::from_str(PROOF_JSON).unwrap();
    let public: std::vec::Vec<std::string::String> = serde_json::from_str(PUBLIC_JSON).unwrap();

    let mut ic = Vec::new(env);
    for point in vk.ic {
        ic.push_back(g1(env, &point[0], &point[1]));
    }
    let mut public_inputs = Vec::new(env);
    for value in public {
        public_inputs.push_back(fr_u256(env, &value));
    }
    Fixture {
        verification_key: VerificationKey {
            alpha: g1(env, &vk.vk_alpha_1[0], &vk.vk_alpha_1[1]),
            beta: g2(env, &vk.vk_beta_2),
            gamma: g2(env, &vk.vk_gamma_2),
            delta: g2(env, &vk.vk_delta_2),
            ic,
        },
        proof: Proof {
            a: g1(env, &proof.pi_a[0], &proof.pi_a[1]),
            b: g2(env, &proof.pi_b),
            c: g1(env, &proof.pi_c[0], &proof.pi_c[1]),
        },
        public_inputs,
    }
}

#[test]
fn verifies_a_real_final_total_spend_leq_proof_against_controller_state() {
    let env = Env::default();
    let fixture = fixture(&env);
    let session_id = BytesN::from_array(&env, &[7u8; 32]);
    let controller = env.register(
        MockFinalAuditController,
        (session_id.clone(), fixture.public_inputs.clone()),
    );
    let verifier = env.register(
        AuditTotalSpendLeqVerifier,
        (controller.clone(), fixture.verification_key.clone()),
    );
    let client = AuditTotalSpendLeqVerifierClient::new(&env, &verifier);

    assert_eq!(client.get_controller(), controller);
    assert!(client.verify_final(&session_id, &500_000, &fixture.proof));
    assert!(env.auths().is_empty());
}

#[test]
fn rejects_threshold_and_session_replay() {
    let env = Env::default();
    let fixture = fixture(&env);
    let session_id = BytesN::from_array(&env, &[7u8; 32]);
    let controller = env.register(
        MockFinalAuditController,
        (session_id.clone(), fixture.public_inputs.clone()),
    );
    let verifier = env.register(
        AuditTotalSpendLeqVerifier,
        (controller, fixture.verification_key.clone()),
    );
    let client = AuditTotalSpendLeqVerifierClient::new(&env, &verifier);

    assert!(!client.verify_final(&session_id, &399_999, &fixture.proof));
    assert!(!client.verify_final(
        &BytesN::from_array(&env, &[8u8; 32]),
        &500_000,
        &fixture.proof,
    ));
}

#[test]
fn rejects_malformed_controller_statements() {
    let env = Env::default();
    let fixture = fixture(&env);
    let controller = env.register(MalformedAuditController, ());
    let verifier = env.register(
        AuditTotalSpendLeqVerifier,
        (controller, fixture.verification_key.clone()),
    );
    let client = AuditTotalSpendLeqVerifierClient::new(&env, &verifier);

    assert_eq!(
        client.try_verify_final(
            &BytesN::from_array(&env, &[7u8; 32]),
            &500_000,
            &fixture.proof,
        ),
        Err(Ok(Error::MalformedPublicInputs))
    );
}

fn fq_bytes(value: &Fq) -> [u8; 32] {
    let bytes = value.into_bigint().to_bytes_be();
    let mut output = [0_u8; 32];
    output[32 - bytes.len()..].copy_from_slice(&bytes);
    output
}

fn g1(env: &Env, x: &str, y: &str) -> Bn254G1Affine {
    let point = ark_bn254::G1Affine::new(Fq::from_str(x).unwrap(), Fq::from_str(y).unwrap());
    let mut bytes = [0_u8; BN254_G1_SERIALIZED_SIZE];
    bytes[..32].copy_from_slice(&fq_bytes(&point.x));
    bytes[32..].copy_from_slice(&fq_bytes(&point.y));
    Bn254G1Affine::from_array(env, &bytes)
}

fn g2(env: &Env, coordinates: &[[std::string::String; 2]; 3]) -> Bn254G2Affine {
    let x = Fq2::new(
        Fq::from_str(&coordinates[0][0]).unwrap(),
        Fq::from_str(&coordinates[0][1]).unwrap(),
    );
    let y = Fq2::new(
        Fq::from_str(&coordinates[1][0]).unwrap(),
        Fq::from_str(&coordinates[1][1]).unwrap(),
    );
    let point = ark_bn254::G2Affine::new(x, y);
    let mut bytes = [0_u8; BN254_G2_SERIALIZED_SIZE];
    bytes[..32].copy_from_slice(&fq_bytes(&point.x.c1));
    bytes[32..64].copy_from_slice(&fq_bytes(&point.x.c0));
    bytes[64..96].copy_from_slice(&fq_bytes(&point.y.c1));
    bytes[96..].copy_from_slice(&fq_bytes(&point.y.c0));
    Bn254G2Affine::from_array(env, &bytes)
}

fn fr_u256(env: &Env, value: &str) -> U256 {
    let bigint = <ArkFr as PrimeField>::BigInt::from_str(value).unwrap();
    assert!(bigint < ArkFr::MODULUS);
    let bytes = bigint.to_bytes_be();
    let mut output = [0_u8; 32];
    output[32 - bytes.len()..].copy_from_slice(&bytes);
    U256::from_be_bytes(env, &Bytes::from_array(env, &output))
}
