pragma circom 2.2.3;

include "@taceo/circom-lib/circuits/poseidon2.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";

template AuditAccumulatorV1() {
    var AUDIT_TOTAL_DOMAIN = 5784957616049701937;

    // Public inputs. transitionKind is INIT=0 or UPDATE=1.
    signal input auditContextHash;
    signal input transitionKind;
    signal input oldCommitment;
    signal input newCommitment;
    signal input settledAmount;

    // Private aggregate openings.
    signal input oldTotal;
    signal input oldBlinding;
    signal input newTotal;
    signal input newBlinding;

    transitionKind * (transitionKind - 1) === 0;

    component settledRange = Num2Bits(64);
    settledRange.in <== settledAmount;
    component oldRange = Num2Bits(64);
    oldRange.in <== oldTotal;
    component newRange = Num2Bits(64);
    newRange.in <== newTotal;

    // INIT has no prior state or spend; UPDATE must settle a positive amount.
    (1 - transitionKind) * oldCommitment === 0;
    (1 - transitionKind) * oldTotal === 0;
    (1 - transitionKind) * oldBlinding === 0;
    (1 - transitionKind) * settledAmount === 0;
    component settledIsZero = IsZero();
    settledIsZero.in <== settledAmount;
    transitionKind * settledIsZero.out === 0;

    component oldHash = Poseidon2(4);
    oldHash.in[0] <== auditContextHash;
    oldHash.in[1] <== oldTotal;
    oldHash.in[2] <== oldBlinding;
    oldHash.in[3] <== AUDIT_TOTAL_DOMAIN;
    oldCommitment === transitionKind * oldHash.out[0];

    // INIT commits to zero; UPDATE advances by exactly the public STANDARD amount.
    newTotal === transitionKind * (oldTotal + settledAmount);
    component newHash = Poseidon2(4);
    newHash.in[0] <== auditContextHash;
    newHash.in[1] <== newTotal;
    newHash.in[2] <== newBlinding;
    newHash.in[3] <== AUDIT_TOTAL_DOMAIN;
    newCommitment === newHash.out[0];

    // Every created accumulator uses a non-zero fresh blinding.
    component newBlindIsZero = IsZero();
    newBlindIsZero.in <== newBlinding;
    newBlindIsZero.out === 0;
    component blindingsEqual = IsZero();
    blindingsEqual.in <== newBlinding - oldBlinding;
    transitionKind * blindingsEqual.out === 0;
}

component main {public [
    auditContextHash,
    transitionKind,
    oldCommitment,
    newCommitment,
    settledAmount
]} = AuditAccumulatorV1();
