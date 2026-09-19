use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    SessionNotFound = 1,
    InvalidExpiry = 2,
    InvalidPolicy = 3,
    NonCanonicalField = 4,
    AssetNotAllowed = 5,
    InvalidLifecycle = 6,
    WrongSettlementMode = 7,
    SessionFrozen = 8,
    SessionExpired = 9,
    InvalidAmount = 10,
    IdentifierAlreadyUsed = 11,
    CounterOverflow = 12,
}
