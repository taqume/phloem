pragma circom 2.2.3;

include "@taceo/circom-lib/circuits/poseidon2.circom";

// Matches protocol/ENCODING.md hash_fields exactly. The length and each
// subsequent field index are committed to prevent ordered-list ambiguity.
template HashFields(N) {
    assert(N >= 2);

    signal input fields[N];
    signal input initDomain;
    signal input foldDomain;
    signal output out;

    component first = Poseidon2(4);
    first.in[0] <== N;
    first.in[1] <== fields[0];
    first.in[2] <== fields[1];
    first.in[3] <== initDomain;

    signal accumulator[N - 1];
    accumulator[0] <== first.out[0];

    component folds[N - 2];
    for (var i = 2; i < N; i++) {
        folds[i - 2] = Poseidon2(4);
        folds[i - 2].in[0] <== accumulator[i - 2];
        folds[i - 2].in[1] <== i;
        folds[i - 2].in[2] <== fields[i];
        folds[i - 2].in[3] <== foldDomain;
        accumulator[i - 1] <== folds[i - 2].out[0];
    }

    out <== accumulator[N - 2];
}

template EncodingVectorV1() {
    signal input contextFields[19];
    signal input providerLeafFields[9];
    signal input offerCommitmentFields[4];
    signal input auditContextFields[13];
    signal input budgetAmount;
    signal input budgetBlind;
    signal input initialAuditTotal;
    signal input initialAuditBlind;
    signal input oldAuditTotal;
    signal input oldAuditBlind;
    signal input newAuditTotal;
    signal input newAuditBlind;

    signal input contextInitDomain;
    signal input contextFoldDomain;
    signal input budgetNoteDomain;
    signal input providerInitDomain;
    signal input providerFoldDomain;
    signal input offerInitDomain;
    signal input offerFoldDomain;
    signal input auditContextInitDomain;
    signal input auditContextFoldDomain;
    signal input auditTotalDomain;

    signal input expectedContextHash;
    signal input expectedBudgetCommitment;
    signal input expectedProviderLeaf;
    signal input expectedOfferCommitment;
    signal input expectedAuditContextHash;
    signal input expectedInitialAuditTotalCommitment;
    signal input expectedOldAuditTotalCommitment;
    signal input expectedNewAuditTotalCommitment;

    signal output contextHash;
    signal output budgetCommitment;
    signal output providerLeaf;
    signal output offerCommitment;
    signal output auditContextHash;
    signal output initialAuditTotalCommitment;
    signal output oldAuditTotalCommitment;
    signal output newAuditTotalCommitment;

    component context = HashFields(19);
    context.fields <== contextFields;
    context.initDomain <== contextInitDomain;
    context.foldDomain <== contextFoldDomain;
    contextHash <== context.out;

    component budget = Poseidon2(4);
    budget.in[0] <== contextHash;
    budget.in[1] <== budgetAmount;
    budget.in[2] <== budgetBlind;
    budget.in[3] <== budgetNoteDomain;
    budgetCommitment <== budget.out[0];

    component provider = HashFields(9);
    provider.fields <== providerLeafFields;
    provider.initDomain <== providerInitDomain;
    provider.foldDomain <== providerFoldDomain;
    providerLeaf <== provider.out;

    component offer = HashFields(4);
    offer.fields <== offerCommitmentFields;
    offer.initDomain <== offerInitDomain;
    offer.foldDomain <== offerFoldDomain;
    offerCommitment <== offer.out;

    component auditContext = HashFields(13);
    auditContext.fields <== auditContextFields;
    auditContext.initDomain <== auditContextInitDomain;
    auditContext.foldDomain <== auditContextFoldDomain;
    auditContextHash <== auditContext.out;

    component initialAudit = Poseidon2(4);
    initialAudit.in[0] <== auditContextHash;
    initialAudit.in[1] <== initialAuditTotal;
    initialAudit.in[2] <== initialAuditBlind;
    initialAudit.in[3] <== auditTotalDomain;
    initialAuditTotalCommitment <== initialAudit.out[0];

    component oldAudit = Poseidon2(4);
    oldAudit.in[0] <== auditContextHash;
    oldAudit.in[1] <== oldAuditTotal;
    oldAudit.in[2] <== oldAuditBlind;
    oldAudit.in[3] <== auditTotalDomain;
    oldAuditTotalCommitment <== oldAudit.out[0];

    component newAudit = Poseidon2(4);
    newAudit.in[0] <== auditContextHash;
    newAudit.in[1] <== newAuditTotal;
    newAudit.in[2] <== newAuditBlind;
    newAudit.in[3] <== auditTotalDomain;
    newAuditTotalCommitment <== newAudit.out[0];

    contextHash === expectedContextHash;
    budgetCommitment === expectedBudgetCommitment;
    providerLeaf === expectedProviderLeaf;
    offerCommitment === expectedOfferCommitment;
    auditContextHash === expectedAuditContextHash;
    initialAuditTotalCommitment === expectedInitialAuditTotalCommitment;
    oldAuditTotalCommitment === expectedOldAuditTotalCommitment;
    newAuditTotalCommitment === expectedNewAuditTotalCommitment;
}

component main = EncodingVectorV1();
