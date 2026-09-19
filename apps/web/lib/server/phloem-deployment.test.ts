import assert from "node:assert/strict";
import test from "node:test";

import {
  PHLOEM_ARTIFACTS,
  PHLOEM_UPLOAD_FEE_LIMIT_STROOPS,
  PHLOEM_UPLOAD_STEPS,
  feeGuardrailStroops,
} from "../phloem-deployment-types";
import { preparePhloemUpload, recordPhloemUploadProgress } from "./phloem-deployment";

test("approved upload plan contains exactly the six preflight artifacts", () => {
  assert.equal(PHLOEM_UPLOAD_STEPS.length, 6);
  assert.equal(new Set(PHLOEM_UPLOAD_STEPS.map((step) => step.id)).size, 6);
  const feeTotal = Object.values(PHLOEM_ARTIFACTS)
    .reduce((total, artifact) => total + BigInt(artifact.maxFeeStroops), 0n);
  assert.equal(feeTotal.toString(), PHLOEM_UPLOAD_FEE_LIMIT_STROOPS);
  assert.equal(feeGuardrailStroops(PHLOEM_UPLOAD_FEE_LIMIT_STROOPS), "192218261");
  for (const artifact of Object.values(PHLOEM_ARTIFACTS)) {
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    assert.ok(artifact.size > 0);
  }
});

test("upload preparation rejects an unapproved signer before network access", async () => {
  await assert.rejects(
    preparePhloemUpload({
      address: "GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6",
      stepId: PHLOEM_UPLOAD_STEPS[0]!.id,
    }),
    /does not match the approved Testnet deployer/,
  );
});

test("upload evidence rejects reordered steps before network verification", async () => {
  const step = PHLOEM_UPLOAD_STEPS[1]!;
  await assert.rejects(
    recordPhloemUploadProgress("GBRFJEDXTYPKMZCQNXQV5LS63YBKRVNTQLE37GKKMQEO3TQ2N6HI4QUC", [{
      artifactId: step.artifactId,
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
      stepId: step.id,
      transactionHash: "0".repeat(64),
      wasmHash: PHLOEM_ARTIFACTS[step.artifactId].sha256,
    }]),
    /out of order/,
  );
});
