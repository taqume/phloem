use soroban_sdk::{Address, BytesN, Env, U256, Vec};

use crate::{encoding, poseidon2};

const PROVIDER_INIT: u128 = 0x5048_4c4d_5052_5631;
const PROVIDER_FOLD: u128 = 0x5048_4c4d_5052_5632;

pub struct ProviderPolicyLeafV1<'a> {
    pub provider_identity: &'a Address,
    pub provider_spp_public_key: &'a U256,
    pub service_id_hash: &'a BytesN<32>,
    pub category_id: u32,
    pub allowed_settlement_modes: u32,
}

pub fn leaf_hash_v1(env: &Env, leaf: &ProviderPolicyLeafV1<'_>) -> Option<U256> {
    let mut fields = Vec::new(env);
    fields.push_back(U256::from_u32(env, 1));
    encoding::push_address_fields(env, &mut fields, leaf.provider_identity)?;
    fields.push_back(leaf.provider_spp_public_key.clone());
    encoding::push_bytes32_limbs(env, &mut fields, leaf.service_id_hash);
    fields.push_back(U256::from_u32(env, leaf.category_id));
    fields.push_back(U256::from_u32(env, leaf.allowed_settlement_modes));

    poseidon2::hash_fields(
        env,
        &fields,
        &U256::from_u128(env, PROVIDER_INIT),
        &U256::from_u128(env, PROVIDER_FOLD),
    )
}

#[cfg(test)]
mod test {
    use soroban_sdk::{Address, BytesN, Env, U256};

    use super::{ProviderPolicyLeafV1, leaf_hash_v1};

    #[test]
    fn provider_leaf_matches_the_cross_language_v1_vector() {
        let env = Env::default();
        let provider = Address::from_str(
            &env,
            "GDDOPVIIK6PKY6URWPGRIWCO5W34AGOJFXCAYLZTDBP4Z6MVB3DHG5AD",
        );
        let service_id_hash = BytesN::from_array(
            &env,
            &[
                0xa8, 0xb5, 0xef, 0x55, 0xf4, 0x71, 0xd3, 0xb6, 0xea, 0x64, 0x75, 0x8e, 0x10, 0x6a,
                0xba, 0xf5, 0x29, 0x2f, 0x64, 0x24, 0x1f, 0x10, 0xcc, 0x5d, 0x66, 0x26, 0x48, 0x4f,
                0x64, 0x45, 0x36, 0x03,
            ],
        );
        let expected = U256::from_parts(
            &env,
            0x1de7_ebff_05a5_5ee8,
            0x1df4_106c_b1e7_8bb3,
            0xc79d_a8d3_fff6_ec7c,
            0xb2ce_3f72_2744_e9bf,
        );

        assert_eq!(
            leaf_hash_v1(
                &env,
                &ProviderPolicyLeafV1 {
                    provider_identity: &provider,
                    provider_spp_public_key: &U256::from_parts(
                        &env,
                        0x002f_bebe_0d0e_27d3,
                        0x491c_3e17_c4ef_e458,
                        0x574d_e21e_a001_1f0b,
                        0xffe5_b681_4360_15ad,
                    ),
                    service_id_hash: &service_id_hash,
                    category_id: 7,
                    allowed_settlement_modes: 2,
                },
            ),
            Some(expected),
        );
    }
}
