use soroban_sdk::{Address, BytesN, Env, U256, Vec, address_payload::AddressPayload};

use crate::{SettlementMode, poseidon2};

const AUDIT_CONTEXT_INIT: u128 = 0x5048_4c4d_4155_4331;
const AUDIT_CONTEXT_FOLD: u128 = 0x5048_4c4d_4155_4332;

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
    push_bytes32_limbs(env, &mut fields, network_id);
    push_address_fields(env, &mut fields, controller)?;
    push_bytes32_limbs(env, &mut fields, session_id);
    push_address_fields(env, &mut fields, asset)?;
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

fn push_address_fields(env: &Env, fields: &mut Vec<U256>, address: &Address) -> Option<()> {
    let (kind, payload) = match AddressPayload::from_address(address)? {
        AddressPayload::AccountIdPublicKeyEd25519(payload) => (0, payload),
        AddressPayload::ContractIdHash(payload) => (1, payload),
    };
    fields.push_back(U256::from_u32(env, kind));
    push_bytes32_limbs(env, fields, &payload);
    Some(())
}

fn push_bytes32_limbs(env: &Env, fields: &mut Vec<U256>, value: &BytesN<32>) {
    let bytes = value.to_array();
    let mut high = [0_u8; 16];
    let mut low = [0_u8; 16];
    high.copy_from_slice(&bytes[..16]);
    low.copy_from_slice(&bytes[16..]);
    fields.push_back(U256::from_u128(env, u128::from_be_bytes(high)));
    fields.push_back(U256::from_u128(env, u128::from_be_bytes(low)));
}

#[cfg(test)]
mod test {
    use soroban_sdk::{Address, Env, U256, bytesn};

    use super::context_hash_v1;
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
}
