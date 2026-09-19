import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildProtocolVectorV1 } from "./vectors.js";

const target = resolve(dirname(fileURLToPath(import.meta.url)), "../../../protocol/test-vectors/v1.json");
const temporary = `${target}.tmp`;
await mkdir(dirname(target), { recursive: true });
await writeFile(temporary, `${JSON.stringify(buildProtocolVectorV1(), null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
await rename(temporary, target);
process.stdout.write(`generated ${target}\n`);
