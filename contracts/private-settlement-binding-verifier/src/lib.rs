#![no_std]

use soroban_sdk::{
    Env, U256, Vec, contract, contracterror, contractimpl, contracttype,
    crypto::bn254::{Bn254Fr, Bn254G1Affine, Bn254G2Affine},
};

const PUBLIC_INPUT_COUNT: u32 = 16;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    MalformedVerifyingKey = 1,
    MalformedPublicInputs = 2,
    NonCanonicalField = 3,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerificationKey {
    pub alpha: Bn254G1Affine,
    pub beta: Bn254G2Affine,
    pub gamma: Bn254G2Affine,
    pub delta: Bn254G2Affine,
    pub ic: Vec<Bn254G1Affine>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proof {
    pub a: Bn254G1Affine,
    pub b: Bn254G2Affine,
    pub c: Bn254G1Affine,
}

#[contracttype]
enum DataKey {
    VerificationKey,
}

#[contract]
pub struct PrivateSettlementBindingVerifier;

#[contractimpl]
impl PrivateSettlementBindingVerifier {
    pub fn __constructor(env: Env, verification_key: VerificationKey) -> Result<(), Error> {
        if verification_key.ic.len() != PUBLIC_INPUT_COUNT + 1 {
            return Err(Error::MalformedVerifyingKey);
        }
        env.storage()
            .instance()
            .set(&DataKey::VerificationKey, &verification_key);
        Ok(())
    }

    pub fn verify(env: Env, proof: Proof, public_inputs: Vec<U256>) -> Result<bool, Error> {
        if public_inputs.len() != PUBLIC_INPUT_COUNT {
            return Err(Error::MalformedPublicInputs);
        }
        let verification_key: VerificationKey = env
            .storage()
            .instance()
            .get(&DataKey::VerificationKey)
            .ok_or(Error::MalformedVerifyingKey)?;
        if verification_key.ic.len() != public_inputs.len() + 1 {
            return Err(Error::MalformedVerifyingKey);
        }

        let modulus = U256::from_parts(
            &env,
            0x3064_4e72_e131_a029,
            0xb850_45b6_8181_585d,
            0x2833_e848_79b9_7091,
            0x43e1_f593_f000_0001,
        );
        let mut canonical_inputs = Vec::<Bn254Fr>::new(&env);
        for input in public_inputs {
            if input >= modulus {
                return Err(Error::NonCanonicalField);
            }
            canonical_inputs.push_back(Bn254Fr::from_u256(input));
        }

        let bn = env.crypto().bn254();
        let mut vk_x = verification_key
            .ic
            .get(0)
            .ok_or(Error::MalformedVerifyingKey)?;
        for index in 0..canonical_inputs.len() {
            let scalar = canonical_inputs
                .get(index)
                .ok_or(Error::MalformedPublicInputs)?;
            let point = verification_key
                .ic
                .get(index + 1)
                .ok_or(Error::MalformedVerifyingKey)?;
            vk_x = bn.g1_add(&vk_x, &bn.g1_mul(&point, &scalar));
        }

        let lhs = soroban_sdk::vec![&env, -proof.a, verification_key.alpha, vk_x, proof.c];
        let rhs = soroban_sdk::vec![
            &env,
            proof.b,
            verification_key.beta,
            verification_key.gamma,
            verification_key.delta
        ];
        Ok(bn.pairing_check(lhs, rhs))
    }
}

#[cfg(test)]
mod test;
