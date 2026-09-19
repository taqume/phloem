use soroban_poseidon::{Poseidon2Config, Poseidon2Sponge};
use soroban_sdk::{Env, U256, crypto::bn254::Bn254Fr, symbol_short, vec};

type Bn254T4 = Poseidon2Sponge<4, Bn254Fr>;

pub fn hash3(env: &Env, a: &U256, b: &U256, c: &U256, domain: &U256) -> Option<U256> {
    let modulus = U256::from_parts(
        env,
        0x3064_4e72_e131_a029,
        0xb850_45b6_8181_585d,
        0x2833_e848_79b9_7091,
        0x43e1_f593_f000_0001,
    );
    if a >= &modulus || b >= &modulus || c >= &modulus || domain >= &modulus {
        return None;
    }

    let state = vec![env, a.clone(), b.clone(), c.clone(), domain.clone()];
    let diagonal = <Bn254T4 as Poseidon2Config<4, Bn254Fr>>::get_m_diag(env);
    let round_constants = <Bn254T4 as Poseidon2Config<4, Bn254Fr>>::get_rc(env);
    let output = env.crypto_hazmat().poseidon2_permutation(
        &state,
        symbol_short!("BN254"),
        4,
        5,
        <Bn254T4 as Poseidon2Config<4, Bn254Fr>>::ROUNDS_F,
        <Bn254T4 as Poseidon2Config<4, Bn254Fr>>::ROUNDS_P,
        &diagonal,
        &round_constants,
    );
    Some(output.get_unchecked(0))
}

#[cfg(test)]
mod test {
    use soroban_sdk::{Env, U256};

    use super::hash3;

    #[test]
    fn host_permutation_matches_the_frozen_taceo_bn254_t4_vector() {
        let env = Env::default();
        let actual = hash3(
            &env,
            &U256::from_u32(&env, 0),
            &U256::from_u32(&env, 1),
            &U256::from_u32(&env, 2),
            &U256::from_u32(&env, 3),
        )
        .unwrap();
        let expected = U256::from_parts(
            &env,
            0x01bd_538c_2ee0_14ed,
            0x5141_b29e_9ae2_40bf,
            0x8db3_fe5b_9a38_629a,
            0x9647_cf8d_76c0_1737,
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn host_permutation_matches_the_cross_language_budget_commitment_vector() {
        let env = Env::default();
        let context_hash = U256::from_parts(
            &env,
            0x080f_d3ab_b7b1_34f3,
            0xbb76_592f_a937_2a38,
            0x86e1_d9ef_caae_cc63,
            0xf4d7_9fa8_426b_2851,
        );
        let amount = U256::from_u32(&env, 2_000_000);
        let blinding = U256::from_parts(
            &env,
            0x00b8_0a47_3536_4830,
            0x5ed2_e9dc_47f1_5515,
            0xaf94_65ba_5929_9748,
            0xdefc_5fbf_b997_b4df,
        );
        let domain = U256::from_u128(&env, 0x5048_4c4d_4255_4431);
        let expected = U256::from_parts(
            &env,
            0x2a71_6d12_8e10_b546,
            0x3ecf_7a04_6459_3a52,
            0x33a1_6e85_e8b3_ce1a,
            0xbf8b_ea87_52d1_77fd,
        );

        assert_eq!(
            hash3(&env, &context_hash, &amount, &blinding, &domain),
            Some(expected)
        );
    }

    #[test]
    fn host_permutation_rejects_noncanonical_field_inputs() {
        let env = Env::default();
        let modulus = U256::from_parts(
            &env,
            0x3064_4e72_e131_a029,
            0xb850_45b6_8181_585d,
            0x2833_e848_79b9_7091,
            0x43e1_f593_f000_0001,
        );

        assert!(
            hash3(
                &env,
                &modulus,
                &U256::from_u32(&env, 1),
                &U256::from_u32(&env, 2),
                &U256::from_u32(&env, 3),
            )
            .is_none()
        );
    }
}
