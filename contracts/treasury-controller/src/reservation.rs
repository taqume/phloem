use soroban_sdk::{BytesN, Env, U256, Vec};

use crate::{encoding, poseidon2};

const CONTEXT_INIT: u128 = 0x5048_4c4d_4354_5831;
const CONTEXT_FOLD: u128 = 0x5048_4c4d_4354_5832;

pub fn context_hash_v1(
    env: &Env,
    source_budget_context_hash: &U256,
    reservation_id: &BytesN<32>,
    approved_provider_root: &U256,
) -> Option<U256> {
    let mut fields = Vec::new(env);
    fields.push_back(source_budget_context_hash.clone());
    encoding::push_bytes32_limbs(env, &mut fields, reservation_id);
    fields.push_back(approved_provider_root.clone());
    poseidon2::hash_fields(
        env,
        &fields,
        &U256::from_u128(env, CONTEXT_INIT),
        &U256::from_u128(env, CONTEXT_FOLD),
    )
}

#[cfg(test)]
mod test {
    use soroban_sdk::{Env, U256, bytesn};

    use super::context_hash_v1;

    #[test]
    fn reservation_context_matches_the_cross_language_v1_vector() {
        let env = Env::default();
        let source = U256::from_parts(
            &env,
            0x080f_d3ab_b7b1_34f3,
            0xbb76_592f_a937_2a38,
            0x86e1_d9ef_caae_cc63,
            0xf4d7_9fa8_426b_2851,
        );
        let reservation_id = bytesn!(
            &env,
            0x73696d330b4da2807725243a035dba1b2cb275a104694ad255b6ec736d23b867
        );
        let provider_root = U256::from_parts(
            &env,
            0x1de7_ebff_05a5_5ee8,
            0x1df4_106c_b1e7_8bb3,
            0xc79d_a8d3_fff6_ec7c,
            0xb2ce_3f72_2744_e9bf,
        );
        let expected = U256::from_parts(
            &env,
            0x2f67_3d79_764c_c6d7,
            0xb698_7961_315d_d715,
            0x1c7f_b1f6_7fed_325e,
            0x0a84_2f70_7741_c717,
        );
        assert_eq!(
            context_hash_v1(&env, &source, &reservation_id, &provider_root),
            Some(expected)
        );
    }
}
