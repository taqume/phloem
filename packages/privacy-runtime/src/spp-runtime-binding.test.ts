import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SppDeploymentBindingError,
  bindSppUsdcTestnetDeployment,
} from "./spp-runtime-binding.js";

async function deploymentManifests(): Promise<{ canonical: unknown; sdk: unknown }> {
  const [canonical, sdk] = await Promise.all([
    readFile(new URL("../../../deployments/testnet.json", import.meta.url), "utf8"),
    readFile(new URL("../../../deployments/spp-usdc-testnet.sdk.json", import.meta.url), "utf8"),
  ]);
  return { canonical: JSON.parse(canonical) as unknown, sdk: JSON.parse(sdk) as unknown };
}

test("PRIVATE runtime binds the exact pinned USDC SPP Testnet deployment", async () => {
  const manifests = await deploymentManifests();
  const binding = bindSppUsdcTestnetDeployment(manifests.canonical, manifests.sdk);
  assert.equal(binding.sourceRevision, "5f3a5d41f452069caf8d0e1654675bca55cb94d3");
  assert.equal(binding.poolContractId, "CC57FDSWPIHALXW2XWVSKEA7FA72Z37Y7AP5ASRY6V3CXAZCWQAOSLB4");
  assert.equal(binding.tokenContractId, "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA");
  assert.equal(binding.asset.code, "USDC");
  assert.equal(binding.policy.flags, 2);
  assert.equal(binding.policy.maximumDepositAmount, 1_000_000_000n);
  assert.equal(Object.isFrozen(binding), true);
  assert.equal(Object.isFrozen(binding.asset), true);
});

test("runtime binding fails closed when canonical and SDK manifests diverge", async () => {
  const manifests = await deploymentManifests();
  const sdk = structuredClone(manifests.sdk) as {
    pools: Array<{ poolContractId: string }>;
  };
  sdk.pools[0]!.poolContractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
  assert.throws(
    () => bindSppUsdcTestnetDeployment(manifests.canonical, sdk),
    SppDeploymentBindingError,
  );
});
