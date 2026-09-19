"use client";

import { useState } from "react";

type WalletState =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected"; address: string }
  | { kind: "error"; message: string };

function shortenAddress(address: string): string {
  return `${address.slice(0, 7)}…${address.slice(-7)}`;
}

export function WalletPanel() {
  const [wallet, setWallet] = useState<WalletState>({ kind: "idle" });

  async function connectFreighter() {
    setWallet({ kind: "connecting" });
    try {
      const [{ StellarWalletsKit, Networks }, { FREIGHTER_ID, FreighterModule }] = await Promise.all([
        import("@creit.tech/stellar-wallets-kit"),
        import("@creit.tech/stellar-wallets-kit/modules/freighter"),
      ]);
      StellarWalletsKit.init({
        modules: [new FreighterModule()],
        network: Networks.TESTNET,
        selectedWalletId: FREIGHTER_ID,
      });
      const { address } = await StellarWalletsKit.getAddress();
      setWallet({ kind: "connected", address });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Freighter connection was cancelled.";
      setWallet({ kind: "error", message });
    }
  }

  const connected = wallet.kind === "connected";

  return (
    <section className="panel wallet-panel" aria-labelledby="wallet-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Company authority</p>
          <h2 id="wallet-title">Connect the Root signer</h2>
        </div>
        <span className={`status-chip ${connected ? "is-ready" : "is-pending"}`}>
          <span aria-hidden="true" className="status-dot" />
          {connected ? "Connected" : "Action required"}
        </span>
      </div>

      <p className="panel-copy">
        Freighter authorizes company-level session operations. Agent Smart Accounts never receive this key.
      </p>

      {connected ? (
        <div className="address-block" aria-live="polite">
          <span>Freighter · Testnet</span>
          <strong title={wallet.address}>{shortenAddress(wallet.address)}</strong>
        </div>
      ) : (
        <button className="primary-button" disabled={wallet.kind === "connecting"} onClick={connectFreighter} type="button">
          {wallet.kind === "connecting" ? "Connecting…" : "Connect Freighter"}
        </button>
      )}

      {wallet.kind === "error" ? (
        <p className="inline-error" role="alert">
          {wallet.message}
        </p>
      ) : null}

      <p className="helper-text">Testnet only. No seed phrase or private key enters Phloem.</p>
    </section>
  );
}
