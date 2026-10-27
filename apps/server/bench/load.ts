/**
 * Load test: N people typing on one page at once, against the real server over HTTP and
 * WebSockets (the same protocol the browser uses). Each client types `keys` characters
 * into its own line, one transaction per keystroke, as fast as the server confirms them.
 *
 *   pnpm --filter @leaf/server exec tsx bench/load.ts [clients=50] [keys=40]
 */
import { insertOps, readText } from "@leaf/shared";
import { NetClient } from "../test/client.js";
import { startServer, waitFor } from "../test/helpers.js";

export async function loadTest(clients: number, keys: number) {
  const s = await startServer();
  try {
    const alice = await s.login("alice@leaf.dev");
    const ws = alice.workspaces[0].id;
    const page = (
      await s.api(alice.token, "POST", "/api/pages", {
        workspaceId: ws,
        title: "Load",
        content: Array.from({ length: clients }, (_, i) => ({ type: "paragraph", properties: { rich_text: [{ text: `line ${i}: ` }] } })),
      })
    ).body.page;
    const lines = s.leaf.store.get(page.id)!.content;
    const cs = await Promise.all(Array.from({ length: clients }, () => new NetClient(s, alice.token, ws, page.id, alice.user.id).open()));
    const latencies: number[] = [];
    // Server CPU per commit (everything here shares one process with the clients).
    let serverMs = 0;
    const commit = s.leaf.sync.commit.bind(s.leaf.sync);
    s.leaf.sync.commit = (...args: Parameters<typeof commit>) => {
      const t = performance.now();
      try {
        return commit(...args);
      } finally {
        serverMs += performance.now() - t;
      }
    };
    const t0 = performance.now();
    await Promise.all(
      cs.map(async (c, i) => {
        for (let k = 0; k < keys; k++) {
          c.edit((v, apply) => {
            const b = v.getBlock(lines[i]!)!;
            apply(insertOps(v, c.clock, b, readText(v, b).units.length, ["x"])!);
          });
          const t = performance.now();
          await c.flush();
          latencies.push(performance.now() - t);
        }
      }),
    );
    const elapsed = performance.now() - t0;
    // Everyone ends with every line complete.
    const want = `x`.repeat(keys);
    await waitFor(() => cs.every((c) => lines.every((id, i) => c.text(id) === `line ${i}: ${want}`)), 20_000, "all clients converge");
    latencies.sort((a, b) => a - b);
    const commits = clients * keys;
    for (const c of cs) c.close();
    return {
      commits,
      seconds: elapsed / 1000,
      perSecond: commits / (elapsed / 1000),
      p50: latencies[Math.floor(latencies.length / 2)]!,
      p95: latencies[Math.floor(latencies.length * 0.95)]!,
      serverMsPerCommit: serverMs / commits,
    };
  } finally {
    await s.close();
  }
}

if (process.argv[1]?.endsWith("load.ts")) {
  const [clients = 50, keys = 40] = process.argv.slice(2).map(Number);
  const r = await loadTest(clients, keys);
  console.log(
    `${clients} clients × ${keys} keystrokes: ${r.commits} commits in ${r.seconds.toFixed(1)} s (${r.perSecond.toFixed(0)}/s), ` +
      `save latency p50 ${r.p50.toFixed(1)} ms, p95 ${r.p95.toFixed(1)} ms, server ${r.serverMsPerCommit.toFixed(2)} ms/commit, every client converged`,
  );
}
