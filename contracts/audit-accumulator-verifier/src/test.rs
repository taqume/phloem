extern crate std;

use ark_bn254::{Fq, Fq2, Fr as ArkFr};
use ark_ff::{BigInteger, PrimeField};
use serde::Deserialize;
use soroban_sdk::{
    Bytes, Env, U256, Vec,
    crypto::bn254::{
        BN254_G1_SERIALIZED_SIZE, BN254_G2_SERIALIZED_SIZE, Bn254G1Affine, Bn254G2Affine,
    },
    vec,
};
use std::str::FromStr;

use crate::{
    AuditAccumulatorVerifier, AuditAccumulatorVerifierClient, Error, Proof, VerificationKey,
};

const VK_JSON: &str = include_str!("../test-fixtures/verification_key.json");
const PROOF_JSON: &str = include_str!("../test-fixtures/proof.json");
const PUBLIC_JSON: &str = include_str!("../test-fixtures/public.json");
const INIT_PROOF_JSON: &str = include_str!("../test-fixtures/proof-init.json");
const INIT_PUBLIC_JSON: &str = include_str!("../test-fixtures/public-init.json");

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
    fixture_from(env, PROOF_JSON, PUBLIC_JSON)
}

fn fixture_from(env: &Env, proof_json: &str, public_json: &str) -> Fixture {
    let vk: VerificationKeyJson = serde_json::from_str(VK_JSON).unwrap();
    let proof: ProofJson = serde_json::from_str(proof_json).unwrap();
    let public: std::vec::Vec<std::string::String> = serde_json::from_str(public_json).unwrap();

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
fn verifies_the_real_audit_accumulator_v1_init_proof() {
    let env = Env::default();
    let fixture = fixture_from(&env, INIT_PROOF_JSON, INIT_PUBLIC_JSON);
    let client = client(&env, &fixture.verification_key);

    assert!(client.verify(&fixture.proof, &fixture.public_inputs));
}

fn client<'a>(env: &'a Env, vk: &VerificationKey) -> AuditAccumulatorVerifierClient<'a> {
    let contract_id = env.register(AuditAccumulatorVerifier, (vk.clone(),));
    AuditAccumulatorVerifierClient::new(env, &contract_id)
}

#[test]
fn verifies_the_real_audit_accumulator_v1_update_proof() {
    let env = Env::default();
    let fixture = fixture(&env);
    let client = client(&env, &fixture.verification_key);

    assert!(client.verify(&fixture.proof, &fixture.public_inputs));
}

#[test]
fn rejects_a_proof_replayed_with_a_mutated_amount_or_context() {
    let env = Env::default();
    let fixture = fixture(&env);
    let client = client(&env, &fixture.verification_key);

    let mut amount_mutated = fixture.public_inputs.clone();
    amount_mutated.set(
        4,
        amount_mutated
            .get_unchecked(4)
            .add(&U256::from_u32(&env, 1)),
    );
    assert!(!client.verify(&fixture.proof, &amount_mutated));

    let mut context_mutated = fixture.public_inputs.clone();
    context_mutated.set(
        0,
        context_mutated
            .get_unchecked(0)
            .add(&U256::from_u32(&env, 1)),
    );
    assert!(!client.verify(&fixture.proof, &context_mutated));
}

#[test]
fn rejects_wrong_length_and_noncanonical_public_inputs() {
    let env = Env::default();
    let fixture = fixture(&env);
    let client = client(&env, &fixture.verification_key);

    assert_eq!(
        client.try_verify(&fixture.proof, &vec![&env]),
        Err(Ok(Error::MalformedPublicInputs))
    );

    let mut noncanonical = fixture.public_inputs.clone();
    noncanonical.set(
        0,
        U256::from_parts(
            &env,
            0x3064_4e72_e131_a029,
            0xb850_45b6_8181_585d,
            0x2833_e848_79b9_7091,
            0x43e1_f593_f000_0001,
        ),
    );
    assert_eq!(
        client.try_verify(&fixture.proof, &noncanonical),
        Err(Ok(Error::NonCanonicalField))
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
