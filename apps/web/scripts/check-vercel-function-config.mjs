import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const HOBBY_MAX_DURATION_SECONDS = 300;
const manifestPath = resolve(".next/server/functions-config-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const invalidFunctions = Object.entries(manifest.functions).filter(
  ([, config]) =>
    typeof config.maxDuration === "number" &&
    config.maxDuration > HOBBY_MAX_DURATION_SECONDS,
);

if (invalidFunctions.length > 0) {
  const details = invalidFunctions
    .map(([route, config]) => `- ${route}: ${config.maxDuration} seconds`)
    .join("\n");

  throw new Error(
    `Vercel Hobby functions must use maxDuration <= ${HOBBY_MAX_DURATION_SECONDS}.\n${details}`,
  );
}

console.log(
  `Verified ${Object.keys(manifest.functions).length} Vercel function configs (maxDuration <= ${HOBBY_MAX_DURATION_SECONDS}).`,
);
