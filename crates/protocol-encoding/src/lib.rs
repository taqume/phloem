//! Canonical Phloem V1 encoding helpers shared with the circuit and TypeScript vectors.

use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use sha2::{Digest, Sha256};
use taceo_poseidon2::bn254::{t2, t4};

pub const CONTEXT_INIT: u64 = 0x5048_4c4d_4354_5831;
pub const CONTEXT_FOLD: u64 = 0x5048_4c4d_4354_5832;
pub const BUDGET_NOTE: u64 = 0x5048_4c4d_4255_4431;
pub const PROVIDER_INIT: u64 = 0x5048_4c4d_5052_5631;
pub const PROVIDER_FOLD: u64 = 0x5048_4c4d_5052_5632;
pub const OFFER_INIT: u64 = 0x5048_4c4d_4f46_4631;
pub const OFFER_FOLD: u64 = 0x5048_4c4d_4f46_4632;
pub const AUDIT_CONTEXT_INIT: u64 = 0x5048_4c4d_4155_4331;
pub const AUDIT_CONTEXT_FOLD: u64 = 0x5048_4c4d_4155_4332;
pub const AUDIT_TOTAL: u64 = 0x5048_4c4d_4155_4431;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncodingError {
    InvalidField,
    InvalidHex,
    InvalidLength { expected: usize, actual: usize },
    TooFewFields,
}

pub fn field_from_decimal(value: &str) -> Result<Fr, EncodingError> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(EncodingError::InvalidField);
    }
    let parsed: Fr = value.parse().map_err(|_| EncodingError::InvalidField)?;
    if field_to_decimal(parsed) != value {
        return Err(EncodingError::InvalidField);
    }
    Ok(parsed)
}

pub fn field_to_decimal(value: Fr) -> String {
    value.into_bigint().to_string()
}

pub fn field_to_bytes(value: Fr) -> [u8; 32] {
    let bytes = value.into_bigint().to_bytes_be();
    let mut output = [0_u8; 32];
    output[32 - bytes.len()..].copy_from_slice(&bytes);
    output
}

pub fn poseidon2_hash3(a: Fr, b: Fr, c: Fr, domain: Fr) -> Fr {
    t4::permutation(&[a, b, c, domain])[0]
}

pub fn poseidon2_hash_fields(
    fields: &[Fr],
    init_domain: Fr,
    fold_domain: Fr,
) -> Result<Fr, EncodingError> {
    if fields.len() < 2 {
        return Err(EncodingError::TooFewFields);
    }
    let mut accumulator = poseidon2_hash3(
        Fr::from(fields.len() as u64),
        fields[0],
        fields[1],
        init_domain,
    );
    for (index, value) in fields.iter().enumerate().skip(2) {
        accumulator = poseidon2_hash3(accumulator, Fr::from(index as u64), *value, fold_domain);
    }
    Ok(accumulator)
}

pub fn poseidon2_compress(left: Fr, right: Fr) -> Fr {
    t2::permutation(&[left, right])[0] + left
}

pub fn decode_fixed_hex<const N: usize>(value: &str) -> Result<[u8; N], EncodingError> {
    let decoded = hex::decode(value).map_err(|_| EncodingError::InvalidHex)?;
    decoded
        .try_into()
        .map_err(|bytes: Vec<u8>| EncodingError::InvalidLength {
            expected: N,
            actual: bytes.len(),
        })
}

fn u16be(value: usize) -> [u8; 2] {
    u16::try_from(value)
        .expect("V1 length must fit u16")
        .to_be_bytes()
}

fn u32be(value: usize) -> [u8; 4] {
    u32::try_from(value)
        .expect("V1 length must fit u32")
        .to_be_bytes()
}

pub fn signing_envelope(domain: &str, body: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(2 + domain.len() + 4 + body.len());
    output.extend_from_slice(&u16be(domain.len()));
    output.extend_from_slice(domain.as_bytes());
    output.extend_from_slice(&u32be(body.len()));
    output.extend_from_slice(body);
    output
}

pub fn sha256(value: &[u8]) -> [u8; 32] {
    Sha256::digest(value).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    const VECTOR_JSON: &str = include_str!("../../../protocol/test-vectors/v1.json");

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vector {
        fixture: Fixture,
        circom: Circom,
        expected: Expected,
        signing: Signing,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        signing_inputs: SigningInputs,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Circom {
        context_fields: Vec<String>,
        provider_leaf_fields: Vec<String>,
        offer_commitment_fields: Vec<String>,
        audit_context_fields: Vec<String>,
        budget_amount: String,
        budget_blind: String,
        initial_audit_total: String,
        initial_audit_blind: String,
        old_audit_total: String,
        old_audit_blind: String,
        new_audit_total: String,
        new_audit_blind: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Expected {
        context_hash: String,
        budget_commitment: String,
        provider_leaf: String,
        offer_commitment: String,
        audit_context_hash: String,
        initial_audit_total_commitment: String,
        old_audit_total_commitment: String,
        new_audit_total_commitment: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SigningInputs {
        service_offer: ServiceOffer,
        usage_evidence: UsageEvidence,
        private_voucher: PrivateVoucher,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Signing {
        service_offer: SignedOutput,
        usage_evidence: SignedOutput,
        private_voucher: SignedOutput,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SignedOutput {
        bytes_hex: String,
        digest_hex: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ServiceOffer {
        protocol_version: u32,
        offer_version: u32,
        network_id_hex: String,
        treasury_controller_hex: String,
        provider_identity_hex: String,
        service_id_hash_hex: String,
        category_id: u32,
        asset_hex: String,
        pricing_model: u8,
        fixed_price_atomic: String,
        supported_settlement_modes: u8,
        valid_until_ledger: u32,
        offer_nonce_hex: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct UsageEvidence {
        protocol_version: u32,
        evidence_version: u32,
        network_id_hex: String,
        treasury_controller_hex: String,
        session_id_hex: String,
        reservation_id_hex: String,
        provider_identity_hex: String,
        service_id_hash_hex: String,
        category_id: u32,
        request_id_hex: String,
        request_hash_hex: String,
        response_hash_hex: String,
        usage_units: String,
        offer_commitment: String,
        provider_sequence: String,
        issued_at_ledger: u32,
        valid_until_ledger: u32,
        evidence_nonce_hex: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PrivateVoucher {
        protocol_version: u32,
        voucher_version: u32,
        network_id_hex: String,
        treasury_controller_hex: String,
        session_id_hex: String,
        reservation_id_hex: String,
        sequence: String,
        cumulative_amount_commitment: String,
        usage_root: String,
        offer_commitment: String,
        expiry_ledger: u32,
    }

    fn append_hex(body: &mut Vec<u8>, value: &str, expected: usize) {
        let bytes = hex::decode(value).expect("fixture hex");
        assert_eq!(bytes.len(), expected);
        body.extend_from_slice(&bytes);
    }

    fn append_field(body: &mut Vec<u8>, value: &str) {
        body.extend_from_slice(&field_to_bytes(
            field_from_decimal(value).expect("fixture field"),
        ));
    }

    fn encode_offer(value: &ServiceOffer) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(&value.protocol_version.to_be_bytes());
        body.extend_from_slice(&value.offer_version.to_be_bytes());
        append_hex(&mut body, &value.network_id_hex, 32);
        append_hex(&mut body, &value.treasury_controller_hex, 33);
        append_hex(&mut body, &value.provider_identity_hex, 33);
        append_hex(&mut body, &value.service_id_hash_hex, 32);
        body.extend_from_slice(&value.category_id.to_be_bytes());
        append_hex(&mut body, &value.asset_hex, 33);
        body.push(value.pricing_model);
        body.extend_from_slice(
            &value
                .fixed_price_atomic
                .parse::<u64>()
                .unwrap()
                .to_be_bytes(),
        );
        body.push(value.supported_settlement_modes);
        body.extend_from_slice(&value.valid_until_ledger.to_be_bytes());
        append_hex(&mut body, &value.offer_nonce_hex, 32);
        signing_envelope("PHLOEM_SERVICE_OFFER_V1", &body)
    }

    fn encode_evidence(value: &UsageEvidence) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(&value.protocol_version.to_be_bytes());
        body.extend_from_slice(&value.evidence_version.to_be_bytes());
        append_hex(&mut body, &value.network_id_hex, 32);
        append_hex(&mut body, &value.treasury_controller_hex, 33);
        append_hex(&mut body, &value.session_id_hex, 32);
        append_hex(&mut body, &value.reservation_id_hex, 32);
        append_hex(&mut body, &value.provider_identity_hex, 33);
        append_hex(&mut body, &value.service_id_hash_hex, 32);
        body.extend_from_slice(&value.category_id.to_be_bytes());
        append_hex(&mut body, &value.request_id_hex, 32);
        append_hex(&mut body, &value.request_hash_hex, 32);
        append_hex(&mut body, &value.response_hash_hex, 32);
        body.extend_from_slice(&value.usage_units.parse::<u64>().unwrap().to_be_bytes());
        append_field(&mut body, &value.offer_commitment);
        body.extend_from_slice(
            &value
                .provider_sequence
                .parse::<u64>()
                .unwrap()
                .to_be_bytes(),
        );
        body.extend_from_slice(&value.issued_at_ledger.to_be_bytes());
        body.extend_from_slice(&value.valid_until_ledger.to_be_bytes());
        append_hex(&mut body, &value.evidence_nonce_hex, 32);
        signing_envelope("PHLOEM_USAGE_EVIDENCE_V1", &body)
    }

    fn encode_voucher(value: &PrivateVoucher) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(&value.protocol_version.to_be_bytes());
        body.extend_from_slice(&value.voucher_version.to_be_bytes());
        append_hex(&mut body, &value.network_id_hex, 32);
        append_hex(&mut body, &value.treasury_controller_hex, 33);
        append_hex(&mut body, &value.session_id_hex, 32);
        append_hex(&mut body, &value.reservation_id_hex, 32);
        body.extend_from_slice(&value.sequence.parse::<u64>().unwrap().to_be_bytes());
        append_field(&mut body, &value.cumulative_amount_commitment);
        append_field(&mut body, &value.usage_root);
        append_field(&mut body, &value.offer_commitment);
        body.extend_from_slice(&value.expiry_ledger.to_be_bytes());
        signing_envelope("PHLOEM_PRIVATE_VOUCHER_V1", &body)
    }

    fn fields(values: &[String]) -> Vec<Fr> {
        values
            .iter()
            .map(|value| field_from_decimal(value).unwrap())
            .collect()
    }

    #[test]
    fn rust_poseidon_matches_typescript_vector() {
        let vector: Vector = serde_json::from_str(VECTOR_JSON).unwrap();
        let context = poseidon2_hash_fields(
            &fields(&vector.circom.context_fields),
            Fr::from(CONTEXT_INIT),
            Fr::from(CONTEXT_FOLD),
        )
        .unwrap();
        assert_eq!(field_to_decimal(context), vector.expected.context_hash);

        let provider = poseidon2_hash_fields(
            &fields(&vector.circom.provider_leaf_fields),
            Fr::from(PROVIDER_INIT),
            Fr::from(PROVIDER_FOLD),
        )
        .unwrap();
        assert_eq!(field_to_decimal(provider), vector.expected.provider_leaf);

        let offer = poseidon2_hash_fields(
            &fields(&vector.circom.offer_commitment_fields),
            Fr::from(OFFER_INIT),
            Fr::from(OFFER_FOLD),
        )
        .unwrap();
        assert_eq!(field_to_decimal(offer), vector.expected.offer_commitment);

        let budget = poseidon2_hash3(
            context,
            field_from_decimal(&vector.circom.budget_amount).unwrap(),
            field_from_decimal(&vector.circom.budget_blind).unwrap(),
            Fr::from(BUDGET_NOTE),
        );
        assert_eq!(field_to_decimal(budget), vector.expected.budget_commitment);

        let audit_context = poseidon2_hash_fields(
            &fields(&vector.circom.audit_context_fields),
            Fr::from(AUDIT_CONTEXT_INIT),
            Fr::from(AUDIT_CONTEXT_FOLD),
        )
        .unwrap();
        assert_eq!(
            field_to_decimal(audit_context),
            vector.expected.audit_context_hash
        );

        let audit_commitment = |total: &str, blinding: &str| {
            poseidon2_hash3(
                audit_context,
                field_from_decimal(total).unwrap(),
                field_from_decimal(blinding).unwrap(),
                Fr::from(AUDIT_TOTAL),
            )
        };
        assert_eq!(
            field_to_decimal(audit_commitment(
                &vector.circom.initial_audit_total,
                &vector.circom.initial_audit_blind,
            )),
            vector.expected.initial_audit_total_commitment
        );
        assert_eq!(
            field_to_decimal(audit_commitment(
                &vector.circom.old_audit_total,
                &vector.circom.old_audit_blind,
            )),
            vector.expected.old_audit_total_commitment
        );
        assert_eq!(
            field_to_decimal(audit_commitment(
                &vector.circom.new_audit_total,
                &vector.circom.new_audit_blind,
            )),
            vector.expected.new_audit_total_commitment
        );
    }

    #[test]
    fn rust_signing_bytes_match_typescript_vector() {
        let vector: Vector = serde_json::from_str(VECTOR_JSON).unwrap();
        let cases = [
            (
                encode_offer(&vector.fixture.signing_inputs.service_offer),
                &vector.signing.service_offer,
            ),
            (
                encode_evidence(&vector.fixture.signing_inputs.usage_evidence),
                &vector.signing.usage_evidence,
            ),
            (
                encode_voucher(&vector.fixture.signing_inputs.private_voucher),
                &vector.signing.private_voucher,
            ),
        ];
        for (encoded, expected) in cases {
            assert_eq!(hex::encode(&encoded), expected.bytes_hex);
            assert_eq!(hex::encode(sha256(&encoded)), expected.digest_hex);
        }
    }

    #[test]
    fn field_parser_rejects_the_modulus() {
        assert_eq!(
            field_from_decimal(
                "21888242871839275222246405745257275088548364400416034343698204186575808495617"
            ),
            Err(EncodingError::InvalidField)
        );
    }
}
