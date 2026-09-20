use soroban_sdk::{Address, BytesN, Env, U256, Vec};

use crate::{SessionPolicy, SettlementMode, encoding, poseidon2};

const SESSION_POLICY_INIT: u128 = 0x5048_4c4d_504f_4c31;
const SESSION_POLICY_FOLD: u128 = 0x5048_4c4d_504f_4c32;

pub fn hash_v1(
    env: &Env,
    network_id: &BytesN<32>,
    controller: &Address,
    policy: &SessionPolicy,
) -> Option<U256> {
    let mut fields = Vec::new(env);
    fields.push_back(U256::from_u32(env, policy.version));
    encoding::push_bytes32_limbs(env, &mut fields, network_id);
    encoding::push_address_fields(env, &mut fields, controller)?;
    encoding::push_address_fields(env, &mut fields, &policy.asset)?;
    fields.push_back(U256::from_u32(
        env,
        match policy.settlement_mode {
            SettlementMode::Standard => 1,
            SettlementMode::Private => 2,
        },
    ));
    fields.push_back(policy.approved_provider_root.clone());
    fields.push_back(U256::from_u32(env, policy.category_schema_version));
    fields.push_back(U256::from_u32(env, policy.max_delegation_depth));
    fields.push_back(U256::from_u128(env, policy.allowed_actions_mask as u128));
    fields.push_back(U256::from_u32(env, policy.session_expiry));

    poseidon2::hash_fields(
        env,
        &fields,
        &U256::from_u128(env, SESSION_POLICY_INIT),
        &U256::from_u128(env, SESSION_POLICY_FOLD),
    )
}

#[cfg(test)]
mod test {
    use soroban_sdk::{Address, Env, U256, bytesn};

    use super::hash_v1;
    use crate::{SessionPolicy, SettlementMode};

    #[test]
    fn session_policy_hash_matches_the_cross_language_v1_vector() {
        let env = Env::default();
        let network_id = bytesn!(
            &env,
            0xcee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472
        );
        let controller = Address::from_str(
            &env,
            "CB23C2OYMIDYC7OG2PK6NJFIVCYONYV43ABREOGVTW2LT4C2G53G2CWU",
        );
        let asset = Address::from_str(
            &env,
            "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        );
        let policy = SessionPolicy {
            version: 1,
            asset,
            settlement_mode: SettlementMode::Private,
            approved_provider_root: U256::from_parts(
                &env,
                0x1de7_ebff_05a5_5ee8,
                0x1df4_106c_b1e7_8bb3,
                0xc79d_a8d3_fff6_ec7c,
                0xb2ce_3f72_2744_e9bf,
            ),
            category_schema_version: 1,
            max_delegation_depth: 3,
            allowed_actions_mask: 7,
            session_expiry: 5_000_000,
            policy_hash: U256::from_u32(&env, 0),
        };
        let expected = U256::from_parts(
            &env,
            0x1e53_01c2_e097_6889,
            0x2bfb_cc0d_ec95_cfaa,
            0x07d6_6d55_41dc_355e,
            0x69d6_3639_bb30_3ecf,
        );

        assert_eq!(
            hash_v1(&env, &network_id, &controller, &policy),
            Some(expected)
        );
    }
}
