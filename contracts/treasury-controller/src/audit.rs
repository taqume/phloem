use soroban_sdk::{Address, BytesN, Env, U256, Vec};

use crate::{SettlementMode, encoding, poseidon2};

const AUDIT_CONTEXT_INIT: u128 = 0x5048_4c4d_4155_4331;
const AUDIT_CONTEXT_FOLD: u128 = 0x5048_4c4d_4155_4332;
const AUDIT_TOTAL: u128 = 0x5048_4c4d_4155_4431;
const AUDIT_QUERY_INIT: u128 = 0x5048_4c4d_4151_4931;
const AUDIT_QUERY_FOLD: u128 = 0x5048_4c4d_4151_4631;

pub fn context_hash_v1(
    env: &Env,
    network_id: &BytesN<32>,
    controller: &Address,
    session_id: &BytesN<32>,
    asset: &Address,
    settlement_mode: &SettlementMode,
    policy_hash: &U256,
) -> Option<U256> {
    let mut fields = Vec::new(env);
    fields.push_back(U256::from_u32(env, 1));
    encoding::push_bytes32_limbs(env, &mut fields, network_id);
    encoding::push_address_fields(env, &mut fields, controller)?;
    encoding::push_bytes32_limbs(env, &mut fields, session_id);
    encoding::push_address_fields(env, &mut fields, asset)?;
    fields.push_back(U256::from_u32(
        env,
        match settlement_mode {
            SettlementMode::Standard => 1,
            SettlementMode::Private => 2,
        },
    ));
    fields.push_back(policy_hash.clone());

    poseidon2::hash_fields(
        env,
        &fields,
        &U256::from_u128(env, AUDIT_CONTEXT_INIT),
        &U256::from_u128(env, AUDIT_CONTEXT_FOLD),
    )
}

pub fn total_commitment_v1(
    env: &Env,
    audit_context_hash: &U256,
    total_spend_atomic: u64,
    blinding: &U256,
) -> Option<U256> {
    poseidon2::hash3(
        env,
        audit_context_hash,
        &U256::from_u128(env, total_spend_atomic as u128),
        blinding,
        &U256::from_u128(env, AUDIT_TOTAL),
    )
}

pub fn final_query_statement_hash_v1(
    env: &Env,
    audit_context_hash: &U256,
    snapshot_hash: &BytesN<32>,
    total_spend_commitment: &U256,
    audit_version: u32,
) -> Option<U256> {
    let mut fields = Vec::new(env);
    fields.push_back(audit_context_hash.clone());
    encoding::push_bytes32_limbs(env, &mut fields, snapshot_hash);
    fields.push_back(total_spend_commitment.clone());
    fields.push_back(U256::from_u32(env, audit_version));
    poseidon2::hash_fields(
        env,
        &fields,
        &U256::from_u128(env, AUDIT_QUERY_INIT),
        &U256::from_u128(env, AUDIT_QUERY_FOLD),
    )
}

#[cfg(test)]
mod test {
    use soroban_sdk::{Address, Env, U256, bytesn};

    use super::{context_hash_v1, final_query_statement_hash_v1};
    use crate::SettlementMode;

    #[test]
    fn audit_context_matches_the_cross_language_v1_vector() {
        let env = Env::default();
        let network_id = bytesn!(
            &env,
            0xcee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472
        );
        let controller = Address::from_str(
            &env,
            "CB23C2OYMIDYC7OG2PK6NJFIVCYONYV43ABREOGVTW2LT4C2G53G2CWU",
        );
        let session_id = bytesn!(
            &env,
            0x567a5d7d681f7dbe4d5a3d326417200d1120966e5c810db10b092593c8a97027
        );
        let asset = Address::from_str(
            &env,
            "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        );
        let policy_hash = U256::from_parts(
            &env,
            0x0025_d432_9555_3cab,
            0x8fcd_d16b_39d2_0c2b,
            0x0077_aa45_f196_021c,
            0x0f3b_1f90_8e6a_fbbf,
        );
        let expected = U256::from_parts(
            &env,
            0x00c4_633f_e71e_c847,
            0xf300_bba4_3023_61ad,
            0x0ec6_e5b7_a257_bbbd,
            0x0c44_5eb2_7f4c_9c0a,
        );

        assert_eq!(
            context_hash_v1(
                &env,
                &network_id,
                &controller,
                &session_id,
                &asset,
                &SettlementMode::Private,
                &policy_hash,
            ),
            Some(expected)
        );
    }

    #[test]
    fn final_query_statement_matches_the_cross_language_v1_vector() {
        let env = Env::default();
        let audit_context_hash = U256::from_parts(
            &env,
            0x00c4_633f_e71e_c847,
            0xf300_bba4_3023_61ad,
            0x0ec6_e5b7_a257_bbbd,
            0x0c44_5eb2_7f4c_9c0a,
        );
        let snapshot_hash = bytesn!(
            &env,
            0x9fbf7f0b40e9ed59489b8cd5b60e8eae6cc0ff68b19f0daa2bc397fea9dc4695
        );
        let total_spend_commitment = U256::from_parts(
            &env,
            0x1ccc_ad32_2b59_2a95,
            0xf1f3_4114_49f6_5def,
            0x8580_35da_56b9_9c4f,
            0xf16a_47f4_5904_d918,
        );
        let expected = U256::from_parts(
            &env,
            0x08c2_c39e_ee03_629b,
            0x1f5e_d7ae_5cd6_992e,
            0x952e_c32d_c212_b3c6,
            0xb956_0e88_b100_6a1b,
        );

        assert_eq!(
            final_query_statement_hash_v1(
                &env,
                &audit_context_hash,
                &snapshot_hash,
                &total_spend_commitment,
                2,
            ),
            Some(expected)
        );
    }
}
