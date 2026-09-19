use soroban_sdk::{Address, Env, U256, Vec, contractclient};

use crate::Groth16Proof;

#[contractclient(name = "AuditAccumulatorVerifierClient")]
#[allow(dead_code)]
pub trait AuditAccumulatorVerifierInterface {
    fn verify(env: Env, proof: Groth16Proof, public_inputs: Vec<U256>) -> bool;
}

pub fn verify(
    env: &Env,
    verifier: &Address,
    proof: &Groth16Proof,
    public_inputs: &Vec<U256>,
) -> bool {
    AuditAccumulatorVerifierClient::new(env, verifier).verify(proof, public_inputs)
}
