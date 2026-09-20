pragma circom 2.2.3;

include "@taceo/circom-lib/circuits/poseidon2.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";

template AuditTotalSpendLeqV1() {
    var AUDIT_TOTAL_DOMAIN = 5784957616049701937;
    var AUDIT_QUERY_INIT_DOMAIN = 5784957616049441073;
    var AUDIT_QUERY_FOLD_DOMAIN = 5784957616049440305;

    // Canonical final-state statement supplied by TreasuryController.
    signal input auditContextHash;
    signal input snapshotHigh;
    signal input snapshotLow;
    signal input totalSpendCommitment;
    signal input thresholdAtomic;
    signal input auditVersion;
    signal input statementHash;

    // Private opening retained by the encrypted PrivacyStateStore.
    signal input totalSpendAtomic;
    signal input totalSpendBlinding;

    component snapshotHighRange = Num2Bits(128);
    snapshotHighRange.in <== snapshotHigh;
    component snapshotLowRange = Num2Bits(128);
    snapshotLowRange.in <== snapshotLow;
    component auditVersionRange = Num2Bits(32);
    auditVersionRange.in <== auditVersion;
    component totalRange = Num2Bits(64);
    totalRange.in <== totalSpendAtomic;
    component thresholdRange = Num2Bits(64);
    thresholdRange.in <== thresholdAtomic;

    component opening = Poseidon2(4);
    opening.in[0] <== auditContextHash;
    opening.in[1] <== totalSpendAtomic;
    opening.in[2] <== totalSpendBlinding;
    opening.in[3] <== AUDIT_TOTAL_DOMAIN;
    totalSpendCommitment === opening.out[0];

    component leq = LessEqThan(64);
    leq.in[0] <== totalSpendAtomic;
    leq.in[1] <== thresholdAtomic;
    leq.out === 1;

    // Matches poseidon2HashFields over:
    // [auditContextHash, snapshotHigh, snapshotLow,
    //  totalSpendCommitment, auditVersion].
    component statementInit = Poseidon2(4);
    statementInit.in[0] <== 5;
    statementInit.in[1] <== auditContextHash;
    statementInit.in[2] <== snapshotHigh;
    statementInit.in[3] <== AUDIT_QUERY_INIT_DOMAIN;

    component statementFold2 = Poseidon2(4);
    statementFold2.in[0] <== statementInit.out[0];
    statementFold2.in[1] <== 2;
    statementFold2.in[2] <== snapshotLow;
    statementFold2.in[3] <== AUDIT_QUERY_FOLD_DOMAIN;

    component statementFold3 = Poseidon2(4);
    statementFold3.in[0] <== statementFold2.out[0];
    statementFold3.in[1] <== 3;
    statementFold3.in[2] <== totalSpendCommitment;
    statementFold3.in[3] <== AUDIT_QUERY_FOLD_DOMAIN;

    component statementFold4 = Poseidon2(4);
    statementFold4.in[0] <== statementFold3.out[0];
    statementFold4.in[1] <== 4;
    statementFold4.in[2] <== auditVersion;
    statementFold4.in[3] <== AUDIT_QUERY_FOLD_DOMAIN;
    statementHash === statementFold4.out[0];
}

component main {public [
    auditContextHash,
    snapshotHigh,
    snapshotLow,
    totalSpendCommitment,
    thresholdAtomic,
    auditVersion,
    statementHash
]} = AuditTotalSpendLeqV1();
