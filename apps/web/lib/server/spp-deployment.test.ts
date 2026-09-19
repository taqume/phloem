import assert from "node:assert/strict";
import test from "node:test";

import { SPP_ARTIFACTS, SPP_DEPLOYMENT_STEPS } from "../spp-deployment-types";
import { prepareSppDeploymentStep, recordSppDeploymentProgress } from "./spp-deployment";

test("deployment plan uploads only the missing pool WASM, then creates every contract", () => {
  assert.equal(SPP_DEPLOYMENT_STEPS.length, 6);
  assert.equal(SPP_DEPLOYMENT_STEPS[0]?.id, "upload-pool");
  assert.equal(SPP_DEPLOYMENT_STEPS[0]?.kind, "upload");
  assert.deepEqual(SPP_DEPLOYMENT_STEPS.slice(1).map((step) => step.kind), Array(5).fill("create"));
  assert.equal(new Set(SPP_DEPLOYMENT_STEPS.map((step) => step.id)).size, SPP_DEPLOYMENT_STEPS.length);
  for (const artifact of Object.values(SPP_ARTIFACTS)) {
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    assert.ok(artifact.size > 0);
  }
});

test("deployment preparation rejects non-account signers before network access", async () => {
  await assert.rejects(
    prepareSppDeploymentStep({ address: "not-a-stellar-account", stepId: "upload-pool" }),
    /valid Freighter G-address/,
  );
});

test("progress recorder rejects reordered or forged deployment evidence", async () => {
  await assert.rejects(
    recordSppDeploymentProgress("GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6", [
      {
        ledger: 1,
        resource: {
          diskReadBytes: 0,
          envelopeBytes: 1,
          footprintReadOnlyEntries: 0,
          footprintReadWriteEntries: 1,
          inclusionFeeStroops: "100",
          instructions: 1,
          latestLedger: 1,
          minResourceFeeStroops: "1",
          totalFeeStroops: "101",
          writeBytes: 1,
        },
        stepId: "create-asp-membership",
        transactionHash: "0".repeat(64),
        wasmHash: SPP_ARTIFACTS.aspMembership.sha256,
      },
    ]),
    /out of order/,
  );
});
