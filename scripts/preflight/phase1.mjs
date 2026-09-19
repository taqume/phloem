import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dependencies = JSON.parse(await readFile(resolve(root, "config/dependencies.lock.json"), "utf8"));
const anchor = JSON.parse(await readFile(resolve(root, "config/anchor.testnet.json"), "utf8"));

function command(commandName, args) {
  const result = spawnSync(commandName, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${commandName} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function getText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

async function getJson(url) {
  return JSON.parse(await getText(url));
}

expect(process.version === `v${dependencies.toolchain.node}`, `Node mismatch: ${process.version}`);
expect(command("pnpm", ["--version"]) === dependencies.toolchain.pnpm, "pnpm version mismatch");
expect(command("stellar", ["--version"]).startsWith(`stellar ${dependencies.toolchain.stellarCli} `), "Stellar CLI version mismatch");
expect(command("rustup", ["run", dependencies.toolchain.rust, "rustc", "--version"]).startsWith(`rustc ${dependencies.toolchain.rust} `), "Rust version mismatch");

const rpcResponse = await fetch("https://soroban-testnet.stellar.org", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
  signal: AbortSignal.timeout(15_000),
});
expect(rpcResponse.ok, `Testnet RPC returned HTTP ${rpcResponse.status}`);
const rpc = await rpcResponse.json();
expect(rpc.result?.status === "healthy", "Testnet RPC is not healthy");

const stellarToml = await getText(`${anchor.baseUrl}/.well-known/stellar.toml`);
for (const expected of [
  `NETWORK_PASSPHRASE="${anchor.networkPassphrase}"`,
  `WEB_AUTH_ENDPOINT="${anchor.endpoints.sep10}"`,
  `TRANSFER_SERVER="${anchor.endpoints.sep6}"`,
  `KYC_SERVER="${anchor.endpoints.sep12}"`,
  `ANCHOR_QUOTE_SERVER="${anchor.endpoints.sep38}"`,
  `code="${anchor.asset.code}"`,
  `issuer="${anchor.asset.issuer}"`,
]) expect(stellarToml.includes(expected), `Anchor discovery mismatch: ${expected}`);

const sep6 = await getJson(`${anchor.endpoints.sep6}/info`);
expect(sep6.deposit?.USDC?.enabled === true, "SEP-6 USDC deposit is disabled");
expect(sep6["deposit-exchange"]?.USDC?.enabled === true, "SEP-6 USDC deposit-exchange is disabled");
expect(sep6.deposit.USDC.authentication_required === true, "SEP-6 should require SEP-10 authentication");
expect(sep6.withdraw?.USDC?.enabled === true, "SEP-6 USDC withdraw is disabled");
expect(sep6["withdraw-exchange"]?.USDC?.enabled === true, "SEP-6 USDC withdraw-exchange is disabled");
expect(sep6.withdraw.USDC.authentication_required === true, "SEP-6 withdrawal should require SEP-10 authentication");
expect(sep6.withdraw.USDC.funding_methods?.includes("bank_account"), "SEP-6 withdrawal missing bank_account funding method");

const sep38 = await getJson(`${anchor.endpoints.sep38}/info`);
const assets = sep38.assets?.map((entry) => entry.asset) ?? [];
expect(assets.includes(`stellar:${anchor.asset.code}:${anchor.asset.issuer}`), "SEP-38 missing configured USDC");
expect(assets.includes("iso4217:TRY"), "SEP-38 missing TRY");

process.stdout.write(JSON.stringify({
  status: "PASS_WITH_INTERACTIVE_GATES_PENDING",
  toolchain: "PASS",
  testnetRpc: { status: rpc.result.status, latestLedger: rpc.result.latestLedger },
  anchorDiscovery: "PASS",
  sep6Info: "PASS",
  sep38Info: "PASS",
  pending: [
    "successful Freighter address retrieval with an installed, unlocked user wallet",
    "SEP-10 challenge signing with CompanyFundingAccount",
    "SEP-12 sandbox KYC when requested",
    "SEP-6 deposit/deposit-exchange completion",
    "USDC trustline and real Testnet receipt",
    "wallet-authorized Phloem session funding",
    "provider SPP exit to its Stellar account",
    "provider-authorized SEP-6 withdraw/withdraw-exchange completion",
  ],
}, null, 2) + "\n");
