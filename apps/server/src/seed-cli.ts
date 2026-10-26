import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Leaf } from "./app.js";
import { seed } from "./seed.js";

// `pnpm seed`: wipe the local database and re-create the demo workspace.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dataDir = path.resolve(ROOT, process.env.LEAF_DATA_DIR ?? "data");
for (const f of ["leaf.db", "leaf.db-wal", "leaf.db-shm"]) fs.rmSync(path.join(dataDir, f), { force: true });
const leaf = new Leaf({ dbFile: path.join(dataDir, "leaf.db") });
seed(leaf);
leaf.close();
console.log(`Fresh demo data in ${dataDir}. Log in as alice@leaf.dev or bob@leaf.dev (password: leafdemo).`);
