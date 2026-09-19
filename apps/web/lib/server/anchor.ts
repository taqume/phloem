import { StrKey, WebAuth } from "@stellar/stellar-sdk";

import { normalizeTryAmount } from "../anchor-types";
import { PHLOEM_NETWORK } from "../network";

export interface AnchorDiscovery {
  kycServer: string;
  sep38Server: string;
  signingKey: string;
  transferServer: string;
  webAuthEndpoint: string;
}

export class AnchorRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function tomlString(source: string, key: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`^${escapedKey}\\s*=\\s*"([^"]+)"\\s*$`, "m"));
  if (!match?.[1]) throw new Error(`Anchor discovery is missing ${key}.`);
  return match[1];
}

function safeEndpoint(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`Anchor ${label} is not a safe HTTPS endpoint.`);
  }
  return url.toString().replace(/\/$/, "");
}

export async function discoverAnchor(): Promise<AnchorDiscovery> {
  const response = await fetch(`${PHLOEM_NETWORK.anchorBaseUrl}/.well-known/stellar.toml`, {
    cache: "no-store",
    headers: { accept: "text/plain" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new AnchorRequestError("Anchor discovery failed.", response.status);

  const source = await response.text();
  const networkPassphrase = tomlString(source, "NETWORK_PASSPHRASE");
  if (networkPassphrase !== PHLOEM_NETWORK.networkPassphrase) {
    throw new Error("Anchor discovery returned a non-Testnet network passphrase.");
  }

  const signingKey = tomlString(source, "SIGNING_KEY");
  if (!StrKey.isValidEd25519PublicKey(signingKey)) {
    throw new Error("Anchor discovery returned an invalid signing key.");
  }

  return {
    kycServer: safeEndpoint(tomlString(source, "KYC_SERVER"), "KYC_SERVER"),
    sep38Server: safeEndpoint(tomlString(source, "ANCHOR_QUOTE_SERVER"), "ANCHOR_QUOTE_SERVER"),
    signingKey,
    transferServer: safeEndpoint(tomlString(source, "TRANSFER_SERVER"), "TRANSFER_SERVER"),
    webAuthEndpoint: safeEndpoint(tomlString(source, "WEB_AUTH_ENDPOINT"), "WEB_AUTH_ENDPOINT"),
  };
}

export function assertAccount(address: unknown): asserts address is string {
  if (typeof address !== "string" || !StrKey.isValidEd25519PublicKey(address)) {
    throw new AnchorRequestError("A valid Stellar G-address is required.", 400);
  }
}

export function parseTryAmount(value: unknown): string {
  if (typeof value !== "string") throw new AnchorRequestError("TRY amount is required.", 400);
  try {
    return normalizeTryAmount(value);
  } catch (reason) {
    throw new AnchorRequestError(reason instanceof Error ? reason.message : "Invalid TRY amount.", 400);
  }
}

export function validateChallenge(transaction: string, account: string, discovery: AnchorDiscovery): void {
  const details = WebAuth.readChallengeTx(
    transaction,
    discovery.signingKey,
    PHLOEM_NETWORK.networkPassphrase,
    PHLOEM_NETWORK.anchorHomeDomain,
    new URL(discovery.webAuthEndpoint).hostname,
  );
  if (details.clientAccountID !== account) {
    throw new AnchorRequestError("SEP-10 challenge account does not match the connected wallet.", 400);
  }
}

export function validateSignedChallenge(transaction: string, account: string, discovery: AnchorDiscovery): void {
  const signers = WebAuth.verifyChallengeTxSigners(
    transaction,
    discovery.signingKey,
    PHLOEM_NETWORK.networkPassphrase,
    [account],
    PHLOEM_NETWORK.anchorHomeDomain,
    new URL(discovery.webAuthEndpoint).hostname,
  );
  if (!signers.includes(account)) {
    throw new AnchorRequestError("SEP-10 challenge is not signed by the connected wallet.", 400);
  }
}

function upstreamMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["error", "detail", "message", "type"]) {
      if (typeof record[key] === "string" && record[key]) return record[key];
    }
  }
  return fallback;
}

export async function anchorJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: {
      accept: "application/json",
      ...init?.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new AnchorRequestError(upstreamMessage(payload, `Anchor returned HTTP ${response.status}.`), response.status);
  }
  return payload as T;
}

export function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}
