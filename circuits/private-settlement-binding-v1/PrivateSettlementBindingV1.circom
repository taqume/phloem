pragma circom 2.2.3;

include "@taceo/circom-lib/circuits/poseidon2.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";

template PrivateSettlementBindingV1() {
    var CONTEXT_INIT_DOMAIN = 5784957616083195953;
    var CONTEXT_FOLD_DOMAIN = 5784957616083195954;
    var BUDGET_NOTE_DOMAIN = 5784957616066479153;
    var PROVIDER_INIT_DOMAIN = 5784957616301168177;
    var PROVIDER_FOLD_DOMAIN = 5784957616301168178;
    var RESERVATION_DOMAIN = 5784957616334788145;
    var VOUCHER_AMOUNT_DOMAIN = 5784957616401634609;
    var AUDIT_TOTAL_DOMAIN = 5784957616049701937;
    var SPP_TREASURY_KEY_DOMAIN = 5784957616351628081;
    var SPP_NOTE_DOMAIN = 1;

    signal input reservationContextHash;
    signal input reservationCommitment;
    signal input voucherContextHash;
    signal input voucherAmountCommitment;
    signal input providerCommitment;
    signal input providerSppOutputCommitment;
    signal input treasurySppKeyCommitment;
    signal input sppRefundOutputCommitment;
    signal input refundContextHash;
    signal input refundBudgetCommitment;
    signal input approvedProviderRoot;
    signal input auditContextHash;
    signal input oldAuditTotalCommitment;
    signal input newAuditTotalCommitment;
    signal input usageRoot;
    signal input offerCommitment;

    signal input reservationAmount;
    signal input reservationBlind;
    signal input voucherSignerPublicKeyFields[2];
    signal input claimAmount;
    signal input voucherAmountBlind;
    signal input providerLeafFields[9];
    signal input providerBlind;
    signal input sppProviderOutputBlind;
    signal input treasurySppPublicKey;
    signal input treasurySppKeyBlind;
    signal input sppRefundOutputBlind;
    signal input refundAmount;
    signal input refundBlind;
    signal input oldAuditTotal;
    signal input oldAuditBlind;
    signal input newAuditTotal;
    signal input newAuditBlind;

    component reservationRange = Num2Bits(64);
    reservationRange.in <== reservationAmount;
    component claimRange = Num2Bits(64);
    claimRange.in <== claimAmount;
    component refundRange = Num2Bits(64);
    refundRange.in <== refundAmount;
    component oldAuditRange = Num2Bits(64);
    oldAuditRange.in <== oldAuditTotal;
    component newAuditRange = Num2Bits(64);
    newAuditRange.in <== newAuditTotal;
    component voucherKeyHiRange = Num2Bits(128);
    voucherKeyHiRange.in <== voucherSignerPublicKeyFields[0];
    component voucherKeyLoRange = Num2Bits(128);
    voucherKeyLoRange.in <== voucherSignerPublicKeyFields[1];

    component claimIsZero = IsZero();
    claimIsZero.in <== claimAmount;
    claimIsZero.out === 0;
    component refundIsZero = IsZero();
    refundIsZero.in <== refundAmount;
    signal hasRefund;
    hasRefund <== 1 - refundIsZero.out;

    reservationAmount === claimAmount + refundAmount;

    component reservationHash = Poseidon2(4);
    reservationHash.in[0] <== reservationContextHash;
    reservationHash.in[1] <== reservationAmount;
    reservationHash.in[2] <== reservationBlind;
    reservationHash.in[3] <== RESERVATION_DOMAIN;
    reservationHash.out[0] === reservationCommitment;

    component voucherContextInit = Poseidon2(4);
    voucherContextInit.in[0] <== 5;
    voucherContextInit.in[1] <== reservationContextHash;
    voucherContextInit.in[2] <== offerCommitment;
    voucherContextInit.in[3] <== CONTEXT_INIT_DOMAIN;
    component voucherContextFold0 = Poseidon2(4);
    voucherContextFold0.in[0] <== voucherContextInit.out[0];
    voucherContextFold0.in[1] <== 2;
    voucherContextFold0.in[2] <== voucherSignerPublicKeyFields[0];
    voucherContextFold0.in[3] <== CONTEXT_FOLD_DOMAIN;
    component voucherContextFold1 = Poseidon2(4);
    voucherContextFold1.in[0] <== voucherContextFold0.out[0];
    voucherContextFold1.in[1] <== 3;
    voucherContextFold1.in[2] <== voucherSignerPublicKeyFields[1];
    voucherContextFold1.in[3] <== CONTEXT_FOLD_DOMAIN;
    component voucherContextFold2 = Poseidon2(4);
    voucherContextFold2.in[0] <== voucherContextFold1.out[0];
    voucherContextFold2.in[1] <== 4;
    voucherContextFold2.in[2] <== usageRoot;
    voucherContextFold2.in[3] <== CONTEXT_FOLD_DOMAIN;
    voucherContextFold2.out[0] === voucherContextHash;

    component voucherAmountHash = Poseidon2(4);
    voucherAmountHash.in[0] <== voucherContextHash;
    voucherAmountHash.in[1] <== claimAmount;
    voucherAmountHash.in[2] <== voucherAmountBlind;
    voucherAmountHash.in[3] <== VOUCHER_AMOUNT_DOMAIN;
    voucherAmountHash.out[0] === voucherAmountCommitment;

    component providerLeafInit = Poseidon2(4);
    providerLeafInit.in[0] <== 9;
    providerLeafInit.in[1] <== providerLeafFields[0];
    providerLeafInit.in[2] <== providerLeafFields[1];
    providerLeafInit.in[3] <== PROVIDER_INIT_DOMAIN;
    component providerLeafFolds[7];
    signal providerLeafAccumulators[8];
    providerLeafAccumulators[0] <== providerLeafInit.out[0];
    for (var i = 2; i < 9; i++) {
        providerLeafFolds[i - 2] = Poseidon2(4);
        providerLeafFolds[i - 2].in[0] <== providerLeafAccumulators[i - 2];
        providerLeafFolds[i - 2].in[1] <== i;
        providerLeafFolds[i - 2].in[2] <== providerLeafFields[i];
        providerLeafFolds[i - 2].in[3] <== PROVIDER_FOLD_DOMAIN;
        providerLeafAccumulators[i - 1] <== providerLeafFolds[i - 2].out[0];
    }
    providerLeafAccumulators[7] === approvedProviderRoot;

    component providerHash = Poseidon2(4);
    providerHash.in[0] <== reservationContextHash;
    providerHash.in[1] <== providerLeafFields[4];
    providerHash.in[2] <== providerBlind;
    providerHash.in[3] <== PROVIDER_INIT_DOMAIN;
    providerHash.out[0] === providerCommitment;

    component providerSppOutputHash = Poseidon2(4);
    providerSppOutputHash.in[0] <== claimAmount;
    providerSppOutputHash.in[1] <== providerLeafFields[4];
    providerSppOutputHash.in[2] <== sppProviderOutputBlind;
    providerSppOutputHash.in[3] <== SPP_NOTE_DOMAIN;
    providerSppOutputHash.out[0] === providerSppOutputCommitment;

    component treasuryKeyHash = Poseidon2(4);
    treasuryKeyHash.in[0] <== auditContextHash;
    treasuryKeyHash.in[1] <== treasurySppPublicKey;
    treasuryKeyHash.in[2] <== treasurySppKeyBlind;
    treasuryKeyHash.in[3] <== SPP_TREASURY_KEY_DOMAIN;
    treasuryKeyHash.out[0] === treasurySppKeyCommitment;

    signal sppRefundOwnerKey;
    sppRefundOwnerKey <== providerLeafFields[4]
        + hasRefund * (treasurySppPublicKey - providerLeafFields[4]);
    component sppRefundOutputHash = Poseidon2(4);
    sppRefundOutputHash.in[0] <== refundAmount;
    sppRefundOutputHash.in[1] <== sppRefundOwnerKey;
    sppRefundOutputHash.in[2] <== sppRefundOutputBlind;
    sppRefundOutputHash.in[3] <== SPP_NOTE_DOMAIN;
    sppRefundOutputHash.out[0] === sppRefundOutputCommitment;

    (1 - hasRefund) * refundContextHash === 0;
    component refundHash = Poseidon2(4);
    refundHash.in[0] <== refundContextHash;
    refundHash.in[1] <== refundAmount;
    refundHash.in[2] <== refundBlind;
    refundHash.in[3] <== BUDGET_NOTE_DOMAIN;
    refundBudgetCommitment === hasRefund * refundHash.out[0];

    newAuditTotal === oldAuditTotal + claimAmount;
    component oldAuditHash = Poseidon2(4);
    oldAuditHash.in[0] <== auditContextHash;
    oldAuditHash.in[1] <== oldAuditTotal;
    oldAuditHash.in[2] <== oldAuditBlind;
    oldAuditHash.in[3] <== AUDIT_TOTAL_DOMAIN;
    oldAuditHash.out[0] === oldAuditTotalCommitment;
    component newAuditHash = Poseidon2(4);
    newAuditHash.in[0] <== auditContextHash;
    newAuditHash.in[1] <== newAuditTotal;
    newAuditHash.in[2] <== newAuditBlind;
    newAuditHash.in[3] <== AUDIT_TOTAL_DOMAIN;
    newAuditHash.out[0] === newAuditTotalCommitment;
    component newAuditBlindIsZero = IsZero();
    newAuditBlindIsZero.in <== newAuditBlind;
    newAuditBlindIsZero.out === 0;
    component auditBlindingsEqual = IsZero();
    auditBlindingsEqual.in <== newAuditBlind - oldAuditBlind;
    auditBlindingsEqual.out === 0;

}

component main {public [
    reservationContextHash,
    reservationCommitment,
    voucherContextHash,
    voucherAmountCommitment,
    providerCommitment,
    providerSppOutputCommitment,
    treasurySppKeyCommitment,
    sppRefundOutputCommitment,
    refundContextHash,
    refundBudgetCommitment,
    approvedProviderRoot,
    auditContextHash,
    oldAuditTotalCommitment,
    newAuditTotalCommitment,
    usageRoot,
    offerCommitment
]} = PrivateSettlementBindingV1();
