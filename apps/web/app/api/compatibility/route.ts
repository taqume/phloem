import { NextResponse } from "next/server";

import { PHLOEM_NETWORK } from "../../../lib/network";

export const dynamic = "force-dynamic";

interface CheckResult {
  detail: string;
  id: "anchor" | "rpc" | "sep6" | "sep38";
  label: string;
  ok: boolean;
}

async function readText(url: string): Promise<string> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { accept: "application/json, text/plain;q=0.9" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

async function checkAnchor(): Promise<CheckResult> {
  const body = await readText(`${PHLOEM_NETWORK.anchorBaseUrl}/.well-known/stellar.toml`);
  const ok = ["WEB_AUTH_ENDPOINT", "TRANSFER_SERVER", "KYC_SERVER", "ANCHOR_QUOTE_SERVER"].every(
    (key) => body.includes(key),
  );
  return { id: "anchor", label: "Anchor discovery", ok, detail: ok ? "SEP-10 / 6 / 12 / 38" : "Required endpoints missing" };
}

async function checkSep6(): Promise<CheckResult> {
  const body = await readText(`${PHLOEM_NETWORK.anchorBaseUrl}/sep6/info`);
  const ok = body.includes(PHLOEM_NETWORK.assetCode) && body.includes("bank_account");
  return { id: "sep6", label: "Funding rail", ok, detail: ok ? "USDC via bank_account" : "SEP-6 capability unavailable" };
}

async function checkSep38(): Promise<CheckResult> {
  const body = await readText(`${PHLOEM_NETWORK.anchorBaseUrl}/sep38/info`);
  const ok = body.includes(PHLOEM_NETWORK.assetCode) && body.includes(PHLOEM_NETWORK.anchorAssetCode);
  return { id: "sep38", label: "Quote assets", ok, detail: ok ? "TRY / USDC" : "SEP-38 pair unavailable" };
}

async function checkRpc(): Promise<CheckResult> {
  const response = await fetch(PHLOEM_NETWORK.rpcUrl, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const body = (await response.json()) as { result?: { status?: string } };
  const ok = body.result?.status === "healthy";
  return { id: "rpc", label: "Soroban RPC", ok, detail: ok ? "Testnet healthy" : "Health check failed" };
}

function failedResult(id: CheckResult["id"], label: string, reason: unknown): CheckResult {
  return {
    id,
    label,
    ok: false,
    detail: reason instanceof Error ? reason.message : "Request failed",
  };
}

export async function GET() {
  const checks = await Promise.allSettled([checkRpc(), checkAnchor(), checkSep6(), checkSep38()]);
  const fallbacks: Array<Pick<CheckResult, "id" | "label">> = [
    { id: "rpc", label: "Soroban RPC" },
    { id: "anchor", label: "Anchor discovery" },
    { id: "sep6", label: "Funding rail" },
    { id: "sep38", label: "Quote assets" },
  ];
  const results = checks.map((check, index) =>
    check.status === "fulfilled"
      ? check.value
      : failedResult(fallbacks[index]!.id, fallbacks[index]!.label, check.reason),
  );

  return NextResponse.json(
    { checkedAt: new Date().toISOString(), checks: results },
    { headers: { "cache-control": "no-store" } },
  );
}
