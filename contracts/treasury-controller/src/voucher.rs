use soroban_sdk::{Bytes, Env};

use crate::{PrivateVoucher, encoding};

const SIGNING_DOMAIN: &[u8] = b"PHLOEM_PRIVATE_VOUCHER_V1";

pub fn signing_bytes_v1(env: &Env, voucher: &PrivateVoucher) -> Option<Bytes> {
    let mut body = Bytes::new(env);
    body.extend_from_slice(&voucher.protocol_version.to_be_bytes());
    body.extend_from_slice(&voucher.voucher_version.to_be_bytes());
    body.append(voucher.network_id.as_bytes());
    encoding::append_address_bytes(&mut body, &voucher.treasury_controller)?;
    body.append(voucher.session_id.as_bytes());
    body.append(voucher.reservation_id.as_bytes());
    body.extend_from_slice(&voucher.sequence.to_be_bytes());
    body.append(&voucher.cumulative_amount_commitment.to_be_bytes());
    body.append(&voucher.usage_root.to_be_bytes());
    body.append(&voucher.offer_commitment.to_be_bytes());
    body.extend_from_slice(&voucher.expiry_ledger.to_be_bytes());

    let mut envelope = Bytes::new(env);
    envelope.extend_from_slice(&(SIGNING_DOMAIN.len() as u16).to_be_bytes());
    envelope.extend_from_slice(SIGNING_DOMAIN);
    envelope.extend_from_slice(&body.len().to_be_bytes());
    envelope.append(&body);
    Some(envelope)
}

#[cfg(test)]
mod test {
    use serde_json::Value;
    use soroban_sdk::{Address, Bytes, BytesN, Env, U256, address_payload::AddressPayload};

    use crate::PrivateVoucher;

    use super::signing_bytes_v1;

    const VECTOR_JSON: &str = include_str!("../../../protocol/test-vectors/v1.json");

    fn bytes32(env: &Env, value: &str) -> BytesN<32> {
        BytesN::from_array(env, &hex::decode(value).unwrap().try_into().unwrap())
    }

    fn address(env: &Env, value: &str) -> Address {
        let decoded = hex::decode(value).unwrap();
        let payload = BytesN::from_array(env, &decoded[1..].try_into().unwrap());
        match decoded[0] {
            0 => AddressPayload::AccountIdPublicKeyEd25519(payload).to_address(env),
            1 => AddressPayload::ContractIdHash(payload).to_address(env),
            _ => panic!("unsupported address kind"),
        }
    }

    fn decimal_u256(env: &Env, value: &str) -> U256 {
        let mut result = U256::from_u32(env, 0);
        for digit in value.bytes() {
            result = result
                .mul(&U256::from_u32(env, 10))
                .add(&U256::from_u32(env, u32::from(digit - b'0')));
        }
        result
    }

    #[test]
    fn voucher_signing_bytes_match_the_cross_language_v1_vector() {
        let env = Env::default();
        let vector: Value = serde_json::from_str(VECTOR_JSON).unwrap();
        let value = &vector["fixture"]["signingInputs"]["privateVoucher"];
        let voucher = PrivateVoucher {
            protocol_version: value["protocolVersion"].as_u64().unwrap() as u32,
            voucher_version: value["voucherVersion"].as_u64().unwrap() as u32,
            network_id: bytes32(&env, value["networkIdHex"].as_str().unwrap()),
            treasury_controller: address(&env, value["treasuryControllerHex"].as_str().unwrap()),
            session_id: bytes32(&env, value["sessionIdHex"].as_str().unwrap()),
            reservation_id: bytes32(&env, value["reservationIdHex"].as_str().unwrap()),
            sequence: value["sequence"].as_str().unwrap().parse().unwrap(),
            cumulative_amount_commitment: decimal_u256(
                &env,
                value["cumulativeAmountCommitment"].as_str().unwrap(),
            ),
            usage_root: decimal_u256(&env, value["usageRoot"].as_str().unwrap()),
            offer_commitment: decimal_u256(&env, value["offerCommitment"].as_str().unwrap()),
            expiry_ledger: value["expiryLedger"].as_u64().unwrap() as u32,
        };
        let expected = Bytes::from_slice(
            &env,
            &hex::decode(
                vector["signing"]["privateVoucher"]["bytesHex"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap(),
        );

        assert_eq!(signing_bytes_v1(&env, &voucher), Some(expected));
    }
}
