export interface AccountReadiness {
  address: string;
  exists: boolean;
  usdcBalance: string | null;
  usdcTrustline: boolean;
  xlmBalance: string | null;
}

export interface AnchorQuote {
  buy_amount: string;
  buy_asset: string;
  expires_at: string;
  fee?: { asset?: string; total?: string };
  id: string;
  price: string;
  sell_amount: string;
  sell_asset: string;
  total_price: string;
}

export interface AnchorInstruction {
  description?: string;
  value: string;
}

export interface AnchorDeposit {
  eta?: number;
  extra_info?: { message?: string };
  how?: string;
  id: string;
  instructions?: Record<string, AnchorInstruction>;
  more_info_url?: string;
}

export interface AnchorTransaction {
  amount_fee?: string;
  amount_in?: string;
  amount_in_asset?: string;
  amount_out?: string;
  amount_out_asset?: string;
  claimable_balance_id?: string;
  id: string;
  kind?: string;
  message?: string;
  more_info_url?: string;
  pending_reason?: string;
  quote_id?: string;
  stellar_transaction_id?: string;
  status: string;
  withdraw_anchor_account?: string;
  withdraw_memo?: string;
  withdraw_memo_type?: string;
}

export interface AnchorWithdrawal {
  account_id: string;
  eta?: number;
  extra_info?: { message?: string };
  id: string;
  memo?: string;
  memo_type?: string;
  min_amount?: number;
  max_amount?: number;
}

export interface ProviderOfframpCapability {
  anchorDomain: string;
  asset: string;
  destinationAsset: "iso4217:TRY";
  fundingMethod: "bank_account";
  providerAccount: string;
  sep38FirmQuote: true;
  withdrawalExchange: true;
}

export interface DegradedProviderOfframpReceipt {
  anchorObservation: {
    domain: string;
    error?: string;
    observedAt: string;
    reachable: boolean;
    status: string | null;
    transactionId: string | null;
  };
  evidenceDigest: string;
  mode: "DEGRADED_DEMO";
  providerSettlement: {
    account: string;
    amountAtomic: string;
    asset: "Circle Testnet USDC";
    sppExitTransactionHash: string;
  };
  reason: "OFFICIAL_ANCHOR_SETTLEMENT_STALLED" | "OFFICIAL_ANCHOR_UNREACHABLE";
  receiptId: string;
  schema: "phloem.degraded-provider-offramp/v1";
  scope: {
    anchorAttested: false;
    fiatLeg: "LOCAL_FIAT_SIMULATED_ONLY";
    protocolStateMutation: "NONE";
    stellarAssetMovement: "NONE";
  };
}

export interface DegradedRailReceipt {
  anchorObservation: {
    domain: string;
    error?: string;
    observedAt: string;
    reachable: boolean;
    status: string | null;
    transactionId: string;
  };
  evidenceDigest: string;
  mode: "DEGRADED_DEMO";
  reason: "OFFICIAL_ANCHOR_SETTLEMENT_STALLED";
  receiptId: string;
  schema: "phloem.degraded-fiat-rail/v1";
  scope: {
    anchorAttested: false;
    fiatLeg: "SIMULATED_ONLY";
    protocolStateMutation: "NONE";
    stellarAssetMovement: "NONE";
  };
  walletAccount: string;
}

export function normalizeTryAmount(value: string): string {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(trimmed)) {
    throw new Error("TRY amount must be a positive decimal with at most two fractional digits.");
  }

  const [whole = "0", fraction = ""] = trimmed.split(".");
  const minorUnits = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (minorUnits <= 0n) throw new Error("TRY amount must be greater than zero.");

  return `${minorUnits / 100n}.${(minorUnits % 100n).toString().padStart(2, "0")}`;
}

export function normalizeUsdcAmount(value: string): string {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,7})?$/.test(trimmed)) {
    throw new Error("USDC amount must be a positive decimal with at most seven fractional digits.");
  }

  const [whole = "0", fraction = ""] = trimmed.split(".");
  const atomic = BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0"));
  if (atomic <= 0n) throw new Error("USDC amount must be greater than zero.");

  return `${atomic / 10_000_000n}.${(atomic % 10_000_000n).toString().padStart(7, "0")}`;
}
