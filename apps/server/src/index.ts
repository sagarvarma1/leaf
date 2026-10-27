import path from "node:path";
import { fileURLToPath } from "node:url";
import { Leaf } from "./app.js";
import { createHttpServer } from "./http.js";
import { seed } from "./seed.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dataDir = path.resolve(ROOT, process.env.LEAF_DATA_DIR ?? "data");
const port = Number(process.env.API_PORT ?? 4000);
// Like Next.js dev, listen on all interfaces by default: browsers may resolve "localhost"
// to ::1 or 127.0.0.1. Set API_HOST=127.0.0.1 to restrict.
const host = process.env.API_HOST || undefined;

const leaf = new Leaf({ dbFile: path.join(dataDir, "leaf.db") });
if (process.env.LEAF_SEED !== "0" && seed(leaf)) console.log("Seeded demo workspace (alice@leaf.dev / bob@leaf.dev, password: leafdemo)");

// Guest sandboxes expire; sweep them at boot and hourly.
const sweep = () => {
  const n = leaf.sweepExpired();
  leaf.sync.pruneTransactions();
  if (n) console.log(`Swept ${n} expired sandbox${n === 1 ? "" : "es"}`);
};
sweep();
setInterval(sweep, 3_600_000).unref();

const { server } = createHttpServer(leaf);
server.listen(port, host, () => console.log(`Leaf API + realtime on http://localhost:${port}  (data: ${dataDir})`));

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  try {
    leaf.close(); // projects + persists every open document
  } catch (err) {
    console.error(err);
  }
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
