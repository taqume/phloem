import assert from "node:assert/strict";
import test from "node:test";

import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";

import type { AnchorQuote, AnchorTransaction } from "../anchor-types.ts";
import { PHLOEM_NETWORK } from "../network.ts";
import {
  assertSignedProviderWithdrawalPayment,
  buildProviderWithdrawalPayment,
  createDegradedProviderOfframpReceipt,
  validateProviderOfframpCapability,
  validateProviderOfframpQuote,
} from "./provider-anchor-offramp.ts";

const provider = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 41));
const anchor = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 42));
const stellarAsset = `stellar:${PHLOEM_NETWORK.assetCode}:${PHLOEM_NETWORK.assetIssuer}`;

const quote: AnchorQuote = {
  buy_amount: "0.32",
  buy_asset: "iso4217:TRY",
  expires_at: "2099-01-01T00:00:00Z",
  id: "quote-1",
  price: "0.03125",
  sell_amount: "0.0100000",
  sell_asset: stellarAsset,
  total_price: "0.03125",
};

const withdrawal: AnchorTransaction = {
  amount_in: "0.0100000",
  amount_in_asset: stellarAsset,
  amount_out: "0.32",
  amount_out_asset: "iso4217:TRY",
  id: "withdrawal-1",
  kind: "withdrawal-exchange",
  quote_id: quote.id,
  status: "pending_user_transfer_start",
  withdraw_anchor_account: anchor.publicKey(),
  withdraw_memo: "7",
  withdraw_memo_type: "id",
};

test("requires the exact advertised authenticated USDC to TRY off-ramp", () => {
  const capability = validateProviderOfframpCapability({
    providerAccount: provider.publicKey(),
    sep6: {
      "withdraw-exchange": {
        USDC: { authentication_required: true, enabled: true, funding_methods: ["bank_account"] },
      },
    },
    sep38: {
      assets: [
        { asset: stellarAsset },
        { asset: "iso4217:TRY", buy_delivery_methods: [{ name: "bank_account" }] },
      ],
    },
  });
  assert.equal(capability.providerAccount, provider.publicKey());
  assert.equal(capability.withdrawalExchange, true);

  assert.throws(() => validateProviderOfframpCapability({
    providerAccount: provider.publicKey(),
    sep6: { "withdraw-exchange": { USDC: { enabled: false } } },
    sep38: { assets: [] },
  }), /does not currently advertise/u);
});

test("binds quote, withdrawal state, payment operation and provider signature", () => {
  validateProviderOfframpQuote(quote, "0.01");
  const preview = buildProviderWithdrawalPayment({
    accountSequence: "123",
    providerAccount: provider.publicKey(),
    quote,
    transaction: withdrawal,
  });
  assert.equal(preview.amount, "0.0100000");
  assert.equal(preview.destination, anchor.publicKey());
  assert.deepEqual(preview.memo, { type: "id", value: "7" });

  const signed = TransactionBuilder.fromXDR(preview.transactionXdr, PHLOEM_NETWORK.networkPassphrase);
  signed.sign(provider);
  assert.doesNotThrow(() => assertSignedProviderWithdrawalPayment({
    providerAccount: provider.publicKey(),
    quote,
    signedTransactionXdr: signed.toXDR(),
    transaction: withdrawal,
  }));

  assert.throws(() => assertSignedProviderWithdrawalPayment({
    providerAccount: provider.publicKey(),
    quote,
    signedTransactionXdr: signed.toXDR(),
    transaction: { ...withdrawal, amount_in: "0.0200000" },
  }), /does not match|differs/u);
});

test("degraded off-ramp evidence preserves real settlement while simulating no asset movement", () => {
  const receipt = createDegradedProviderOfframpReceipt({
    anchorStatus: "pending_anchor",
    anchorTransactionId: withdrawal.id,
    amountAtomic: "100000",
    observedAt: "2026-09-20T06:00:00.000Z",
    providerAccount: provider.publicKey(),
    sppExitTransactionHash: "ab".repeat(32),
  });
  assert.equal(receipt.reason, "OFFICIAL_ANCHOR_SETTLEMENT_STALLED");
  assert.deepEqual(receipt.scope, {
    anchorAttested: false,
    fiatLeg: "LOCAL_FIAT_SIMULATED_ONLY",
    protocolStateMutation: "NONE",
    stellarAssetMovement: "NONE",
  });
  assert.equal(receipt.providerSettlement.sppExitTransactionHash, "ab".repeat(32));
  assert.match(receipt.evidenceDigest, /^sha256:[0-9a-f]{64}$/u);

  assert.throws(() => createDegradedProviderOfframpReceipt({
    anchorStatus: "completed",
    anchorTransactionId: withdrawal.id,
    amountAtomic: "100000",
    observedAt: "2026-09-20T06:00:00.000Z",
    providerAccount: provider.publicKey(),
    sppExitTransactionHash: "ab".repeat(32),
  }), /cannot be represented as degraded/u);
});
