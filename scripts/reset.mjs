#!/usr/bin/env node
// `pnpm reset`: delete local data. The demo workspace is re-seeded on the next `pnpm dev`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.resolve(ROOT, process.env.LEAF_DATA_DIR ?? "data");
fs.rmSync(dir, { recursive: true, force: true });
console.log(`Removed ${dir}. Run pnpm dev to re-seed the demo workspace.`);
console.log("Tip: browsers keep an offline copy of pages in IndexedDB; it is keyed by page id, so old copies are simply unused.");
