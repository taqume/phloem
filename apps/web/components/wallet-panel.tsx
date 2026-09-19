"use client";

import { useEffect, useState } from "react";

import type { AccountReadiness } from "../lib/anchor-types";
import { PHLOEM_NETWORK } from "../lib/network";

export interface WalletConnection {
  address: string;
  network: string;
  readiness: AccountReadiness;
}

interface WalletPanelProps {
  balanceRefreshNonce: number;
  onConnected: (connection: WalletConnection | null) => void;
}

type WalletState =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected"; connection: WalletConnection }
  | { kind: "error"; message: string };

function shortenAddress(address: string): string {
  return `${address.slice(0, 7)}…${address.slice(-7)}`;
}

async function readAccount(address: string): Promise<AccountReadiness> {
  const response = await fetch(`/api/stellar/account?address=${encodeURIComponent(address)}`, { cache: "no-store" });
  const payload = (await response.json()) as AccountReadiness & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Account readiness returned HTTP ${response.status}.`);
  return payload;
}

function isFinanciallyReady(readiness: AccountReadiness): boolean {
  return readiness.exists && readiness.usdcTrustline && Number(readiness.xlmBalance ?? "0") > 0;
}

export function WalletPanel({ balanceRefreshNonce, onConnected }: WalletPanelProps) {
  const [wallet, setWallet] = useState<WalletState>({ kind: "idle" });
  const connectedAddress = wallet.kind === "connected" ? wallet.connection.address : null;
  const connectedNetwork = wallet.kind === "connected" ? wallet.connection.network : null;

  useEffect(() => {
    if (!connectedAddress || !connectedNetwork || balanceRefreshNonce === 0) return;
    let active = true;
    void readAccount(connectedAddress)
      .then((readiness) => {
        if (!active) return;
        const connection = { address: connectedAddress, network: connectedNetwork, readiness };
        setWallet({ kind: "connected", connection });
        onConnected(connection);
      })
      .catch((reason) => {
        if (!active) return;
        setWallet({ kind: "error", message: reason instanceof Error ? reason.message : "Balance refresh failed." });
        onConnected(null);
      });
    return () => {
      active = false;
    };
  }, [balanceRefreshNonce, connectedAddress, connectedNetwork, onConnected]);

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
      const [{ address }, network] = await Promise.all([
        StellarWalletsKit.fetchAddress(),
        StellarWalletsKit.getNetwork(),
      ]);
      if (network.networkPassphrase !== PHLOEM_NETWORK.networkPassphrase) {
        throw new Error("Freighter must be switched to Stellar Testnet before connecting.");
      }
      const readiness = await readAccount(address);
      const connection = { address, network: network.network, readiness };
      setWallet({ kind: "connected", connection });
      onConnected(connection);
    } catch (error) {
      onConnected(null);
      const message = error instanceof Error ? error.message : "Freighter connection was cancelled.";
      setWallet({ kind: "error", message });
    }
  }

  async function disconnectFreighter() {
    try {
      const { StellarWalletsKit } = await import("@creit.tech/stellar-wallets-kit");
      await StellarWalletsKit.disconnect();
    } finally {
      onConnected(null);
      setWallet({ kind: "idle" });
    }
  }

  async function refreshAccount() {
    if (wallet.kind !== "connected") return;
    try {
      const readiness = await readAccount(wallet.connection.address);
      const connection = { ...wallet.connection, readiness };
      setWallet({ kind: "connected", connection });
      onConnected(connection);
    } catch (error) {
      setWallet({ kind: "error", message: error instanceof Error ? error.message : "Account refresh failed." });
      onConnected(null);
    }
  }

  const connected = wallet.kind === "connected";
  const ready = connected && isFinanciallyReady(wallet.connection.readiness);

  return (
    <section className="panel wallet-panel" aria-labelledby="wallet-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Company authority</p>
          <h2 id="wallet-title">Connect the funding wallet</h2>
        </div>
        <span className={`status-chip ${ready ? "is-ready" : "is-pending"}`}>
          <span aria-hidden="true" className="status-dot" />
          {ready ? "Funding ready" : connected ? "Check account" : "Action required"}
        </span>
      </div>

      <p className="panel-copy">
        Freighter is the CompanyFundingAccount and SEP-10 signer. Agent Smart Accounts never receive this key.
      </p>

      {connected ? (
        <>
          <div className="address-block" aria-live="polite">
            <span>Freighter · Testnet</span>
            <strong title={wallet.connection.address}>{shortenAddress(wallet.connection.address)}</strong>
          </div>
          <dl className="balance-grid">
            <div><dt>Fee balance</dt><dd>{wallet.connection.readiness.xlmBalance ?? "Missing"} XLM</dd></div>
            <div><dt>Circle USDC</dt><dd>{wallet.connection.readiness.usdcBalance ?? "No trustline"}</dd></div>
          </dl>
          {!wallet.connection.readiness.exists ? <p className="inline-error" role="alert">This Testnet account is not funded.</p> : null}
          {!wallet.connection.readiness.usdcTrustline ? <p className="inline-error" role="alert">The required Circle Testnet USDC trustline is missing.</p> : null}
          <div className="button-row">
            <button className="secondary-button" onClick={() => void refreshAccount()} type="button">Refresh balances</button>
            <button className="text-button" onClick={() => void disconnectFreighter()} type="button">Disconnect</button>
          </div>
        </>
      ) : (
        <button className="primary-button" disabled={wallet.kind === "connecting"} onClick={connectFreighter} type="button">
          {wallet.kind === "connecting" ? "Connecting…" : "Connect Freighter"}
        </button>
      )}

      {wallet.kind === "error" ? <p className="inline-error" role="alert">{wallet.message}</p> : null}

      <p className="helper-text">Testnet only. No seed phrase or private key enters Phloem.</p>
    </section>
  );
}
