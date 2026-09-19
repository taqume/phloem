use soroban_sdk::{Address, Bytes, BytesN, Env, U256, Vec, address_payload::AddressPayload};

pub fn append_address_bytes(output: &mut Bytes, address: &Address) -> Option<()> {
    let (kind, payload) = match AddressPayload::from_address(address)? {
        AddressPayload::AccountIdPublicKeyEd25519(payload) => (0_u8, payload),
        AddressPayload::ContractIdHash(payload) => (1_u8, payload),
    };
    output.push_back(kind);
    output.append(payload.as_bytes());
    Some(())
}

pub fn push_address_fields(env: &Env, fields: &mut Vec<U256>, address: &Address) -> Option<()> {
    let (kind, payload) = match AddressPayload::from_address(address)? {
        AddressPayload::AccountIdPublicKeyEd25519(payload) => (0, payload),
        AddressPayload::ContractIdHash(payload) => (1, payload),
    };
    fields.push_back(U256::from_u32(env, kind));
    push_bytes32_limbs(env, fields, &payload);
    Some(())
}

pub fn push_bytes32_limbs(env: &Env, fields: &mut Vec<U256>, value: &BytesN<32>) {
    let bytes = value.to_array();
    let mut high = [0_u8; 16];
    let mut low = [0_u8; 16];
    high.copy_from_slice(&bytes[..16]);
    low.copy_from_slice(&bytes[16..]);
    fields.push_back(U256::from_u128(env, u128::from_be_bytes(high)));
    fields.push_back(U256::from_u128(env, u128::from_be_bytes(low)));
}
