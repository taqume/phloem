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
  amount_out?: string;
  claimable_balance_id?: string;
  id: string;
  message?: string;
  more_info_url?: string;
  pending_reason?: string;
  stellar_transaction_id?: string;
  status: string;
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
