use soroban_sdk::{Address, Env, contractclient};

use crate::{SppExtData, SppPoolError, SppProof};

#[contractclient(crate_path = "soroban_sdk", name = "SppPoolClient")]
#[allow(dead_code)]
pub trait SppPoolInterface {
    fn transact(
        env: Env,
        proof: SppProof,
        ext_data: SppExtData,
        sender: Address,
    ) -> Result<(), SppPoolError>;
}
