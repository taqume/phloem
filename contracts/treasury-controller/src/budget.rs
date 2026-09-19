use soroban_sdk::{Address, BytesN, Env, U256, Vec};

use crate::{encoding, poseidon2};

const CONTEXT_INIT: u128 = 0x5048_4c4d_4354_5831;
const CONTEXT_FOLD: u128 = 0x5048_4c4d_4354_5832;

pub struct BudgetContextV1<'a> {
    pub protocol_version: u32,
    pub network_id: &'a BytesN<32>,
    pub controller: &'a Address,
    pub session_id: &'a BytesN<32>,
    pub node_id: &'a BytesN<32>,
    pub owner: &'a Address,
    pub asset: &'a Address,
    pub policy_hash: &'a U256,
    pub note_id: &'a BytesN<32>,
}

pub fn context_hash_v1(env: &Env, context: &BudgetContextV1<'_>) -> Option<U256> {
    let mut fields = Vec::new(env);
    fields.push_back(U256::from_u32(env, context.protocol_version));
    encoding::push_bytes32_limbs(env, &mut fields, context.network_id);
    encoding::push_address_fields(env, &mut fields, context.controller)?;
    encoding::push_bytes32_limbs(env, &mut fields, context.session_id);
    encoding::push_bytes32_limbs(env, &mut fields, context.node_id);
    encoding::push_address_fields(env, &mut fields, context.owner)?;
    encoding::push_address_fields(env, &mut fields, context.asset)?;
    fields.push_back(context.policy_hash.clone());
    encoding::push_bytes32_limbs(env, &mut fields, context.note_id);

    poseidon2::hash_fields(
        env,
        &fields,
        &U256::from_u128(env, CONTEXT_INIT),
        &U256::from_u128(env, CONTEXT_FOLD),
    )
}

#[cfg(test)]
mod test {
    use soroban_sdk::{Address, Env, U256, bytesn};

    use super::{BudgetContextV1, context_hash_v1};

    #[test]
    fn budget_context_matches_the_cross_language_v1_vector() {
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
        let node_id = bytesn!(
            &env,
            0xfd033c83c211361d851ac87bef0030b5ceecf314809142e56eee00824b327307
        );
        let note_id = bytesn!(
            &env,
            0x190179dd856bdb093b2e7e65de9df2011b552f1ed4e09918c8417f12193c8f47
        );
        let owner = Address::from_str(
            &env,
            "CB2P6OWRQTMIDLN2XSD4PYSRP2P2U5TTR4VNCLEDKMXAQWN7CHWLHI27",
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
            0x080f_d3ab_b7b1_34f3,
            0xbb76_592f_a937_2a38,
            0x86e1_d9ef_caae_cc63,
            0xf4d7_9fa8_426b_2851,
        );

        assert_eq!(
            context_hash_v1(
                &env,
                &BudgetContextV1 {
                    protocol_version: 1,
                    network_id: &network_id,
                    controller: &controller,
                    session_id: &session_id,
                    node_id: &node_id,
                    owner: &owner,
                    asset: &asset,
                    policy_hash: &policy_hash,
                    note_id: &note_id,
                },
            ),
            Some(expected)
        );
    }
}
