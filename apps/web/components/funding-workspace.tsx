"use client";

import { useCallback, useState } from "react";

import { AnchorFundingPanel } from "./anchor-funding-panel";
import { CompatibilityPanel } from "./compatibility-panel";
import { WalletPanel, type WalletConnection } from "./wallet-panel";

export function FundingWorkspace() {
  const [balanceRefreshNonce, setBalanceRefreshNonce] = useState(0);
  const [wallet, setWallet] = useState<WalletConnection | null>(null);
  const handleWallet = useCallback((connection: WalletConnection | null) => setWallet(connection), []);
  const handleSettlement = useCallback(() => setBalanceRefreshNonce((current) => current + 1), []);

  return (
    <>
      <div className="workspace-grid">
        <WalletPanel balanceRefreshNonce={balanceRefreshNonce} onConnected={handleWallet} />
        <CompatibilityPanel />
      </div>
      <AnchorFundingPanel onSettlementCompleted={handleSettlement} wallet={wallet} />
    </>
  );
}
