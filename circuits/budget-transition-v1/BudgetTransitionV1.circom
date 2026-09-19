pragma circom 2.2.3;

include "@taceo/circom-lib/circuits/poseidon2.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";

template TransitionOutput() {
    var BUDGET_NOTE_DOMAIN = 5784957616066479153;
    var RESERVATION_DOMAIN = 5784957616334788145;
    signal input contextHash;
    signal input commitment;
    signal input kind;
    signal input amount;
    signal input blinding;

    // NONE=0, BUDGET_NOTE=1, PRIVATE_RESERVATION=2.
    signal isBudget;
    signal isReservation;
    signal active;
    isBudget <-- kind == 1;
    isReservation <-- kind == 2;
    isBudget * (isBudget - 1) === 0;
    isReservation * (isReservation - 1) === 0;
    kind === isBudget + 2 * isReservation;
    active <== isBudget + isReservation;

    (1 - active) * contextHash === 0;
    (1 - active) * commitment === 0;
    (1 - active) * amount === 0;
    (1 - active) * blinding === 0;

    component amountRange = Num2Bits(64);
    amountRange.in <== amount;
    component amountIsZero = IsZero();
    amountIsZero.in <== amount;
    active * amountIsZero.out === 0;

    signal commitmentDomain;
    commitmentDomain <== BUDGET_NOTE_DOMAIN
        + isReservation * (RESERVATION_DOMAIN - BUDGET_NOTE_DOMAIN);

    component hash = Poseidon2(4);
    hash.in[0] <== contextHash;
    hash.in[1] <== amount;
    hash.in[2] <== blinding;
    hash.in[3] <== commitmentDomain;
    commitment === active * hash.out[0];
}

template BudgetTransitionV1() {
    var BUDGET_NOTE_DOMAIN = 5784957616066479153;
    signal input inputContextHash;
    signal input inputCommitment;
    signal input output1ContextHash;
    signal input output1Commitment;
    signal input output1Kind;
    signal input output2ContextHash;
    signal input output2Commitment;
    signal input output2Kind;

    signal input inputAmount;
    signal input inputBlinding;
    signal input output1Amount;
    signal input output1Blinding;
    signal input output2Amount;
    signal input output2Blinding;

    component inputRange = Num2Bits(64);
    inputRange.in <== inputAmount;
    component inputIsZero = IsZero();
    inputIsZero.in <== inputAmount;
    inputIsZero.out === 0;

    component inputHash = Poseidon2(4);
    inputHash.in[0] <== inputContextHash;
    inputHash.in[1] <== inputAmount;
    inputHash.in[2] <== inputBlinding;
    inputHash.in[3] <== BUDGET_NOTE_DOMAIN;
    inputHash.out[0] === inputCommitment;

    component output1 = TransitionOutput();
    output1.contextHash <== output1ContextHash;
    output1.commitment <== output1Commitment;
    output1.kind <== output1Kind;
    output1.amount <== output1Amount;
    output1.blinding <== output1Blinding;

    component output2 = TransitionOutput();
    output2.contextHash <== output2ContextHash;
    output2.commitment <== output2Commitment;
    output2.kind <== output2Kind;
    output2.amount <== output2Amount;
    output2.blinding <== output2Blinding;

    inputAmount === output1Amount + output2Amount;
}

component main {public [
    inputContextHash,
    inputCommitment,
    output1ContextHash,
    output1Commitment,
    output1Kind,
    output2ContextHash,
    output2Commitment,
    output2Kind
]} = BudgetTransitionV1();
