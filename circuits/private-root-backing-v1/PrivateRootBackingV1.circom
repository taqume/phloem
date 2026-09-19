pragma circom 2.2.3;

include "@taceo/circom-lib/circuits/poseidon2.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";

template PrivateRootBackingV1() {
    var BUDGET_NOTE_DOMAIN = 5784957616066479153;
    var AUDIT_TOTAL_DOMAIN = 5784957616049701937;
    var SPP_TREASURY_KEY_DOMAIN = 5784957616351628081;
    var SPP_NOTE_DOMAIN = 1;

    signal input rootContextHash;
    signal input rootBudgetCommitment;
    signal input auditContextHash;
    signal input initialAuditTotalCommitment;
    signal input treasurySppKeyCommitment;
    signal input sppFundingOutputCommitment;
    signal input fundingAmount;

    signal input rootBudgetBlind;
    signal input initialAuditBlind;
    signal input treasurySppPublicKey;
    signal input treasurySppKeyBlind;
    signal input sppFundingOutputBlind;

    component amountRange = Num2Bits(64);
    amountRange.in <== fundingAmount;
    component amountIsZero = IsZero();
    amountIsZero.in <== fundingAmount;
    amountIsZero.out === 0;

    component treasuryKeyIsZero = IsZero();
    treasuryKeyIsZero.in <== treasurySppPublicKey;
    treasuryKeyIsZero.out === 0;
    component auditBlindIsZero = IsZero();
    auditBlindIsZero.in <== initialAuditBlind;
    auditBlindIsZero.out === 0;

    component rootHash = Poseidon2(4);
    rootHash.in[0] <== rootContextHash;
    rootHash.in[1] <== fundingAmount;
    rootHash.in[2] <== rootBudgetBlind;
    rootHash.in[3] <== BUDGET_NOTE_DOMAIN;
    rootHash.out[0] === rootBudgetCommitment;

    component initialAuditHash = Poseidon2(4);
    initialAuditHash.in[0] <== auditContextHash;
    initialAuditHash.in[1] <== 0;
    initialAuditHash.in[2] <== initialAuditBlind;
    initialAuditHash.in[3] <== AUDIT_TOTAL_DOMAIN;
    initialAuditHash.out[0] === initialAuditTotalCommitment;

    component treasuryKeyHash = Poseidon2(4);
    treasuryKeyHash.in[0] <== auditContextHash;
    treasuryKeyHash.in[1] <== treasurySppPublicKey;
    treasuryKeyHash.in[2] <== treasurySppKeyBlind;
    treasuryKeyHash.in[3] <== SPP_TREASURY_KEY_DOMAIN;
    treasuryKeyHash.out[0] === treasurySppKeyCommitment;

    component sppFundingOutputHash = Poseidon2(4);
    sppFundingOutputHash.in[0] <== fundingAmount;
    sppFundingOutputHash.in[1] <== treasurySppPublicKey;
    sppFundingOutputHash.in[2] <== sppFundingOutputBlind;
    sppFundingOutputHash.in[3] <== SPP_NOTE_DOMAIN;
    sppFundingOutputHash.out[0] === sppFundingOutputCommitment;
}

component main {public [
    rootContextHash,
    rootBudgetCommitment,
    auditContextHash,
    initialAuditTotalCommitment,
    treasurySppKeyCommitment,
    sppFundingOutputCommitment,
    fundingAmount
]} = PrivateRootBackingV1();
