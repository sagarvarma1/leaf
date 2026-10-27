/**
 * Multi-client sync over the real server: clients load a page (loadPageChunk), follow it
 * over the WebSocket, and send transactions (saveTransactions), exactly like the browser.
 * They make interleaved concurrent edits (typing, deletes, formatting, Enter / Backspace,
 * new blocks, moves, deletes), one goes offline and keeps editing, then reconnects. Every
 * replica must end identical to the server, and the state must survive a restart.
 */
import { deleteOps, insertOps, markOps, readText, type MemoryState } from "@leaf/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Leaf } from "../src/app.js";
import { NetClient } from "./client.js";
import { startServer, waitFor, type TestServer } from "./helpers.js";

let s: TestServer;
let alice: any;
let bob: any;
let ws: string;
let pageId: string;
const clients: NetClient[] = [];

beforeAll(async () => {
  s = await startServer();
  alice = await s.login("alice@leaf.dev");
  bob = await s.login("bob@leaf.dev");
  ws = alice.workspaces[0].id;
  const page = await s.api(alice.token, "POST", "/api/pages", {
    workspaceId: ws,
    title: "Sync test",
    content: [
      { type: "paragraph", properties: { rich_text: [{ text: "First paragraph" }] } },
      { type: "paragraph", properties: { rich_text: [{ text: "Second paragraph" }] } },
      { type: "to_do", properties: { rich_text: [{ text: "A task" }] } },
    ],
  });
  pageId = page.body.page.id;
});
afterAll(async () => {
  for (const c of clients) c.close();
  await s.close();
});

async function client(who: any) {
  const c = await new NetClient(s, who.token, ws, pageId, who.user.id).open();
  clients.push(c);
  return c;
}

/** The server's document, as a fresh client would see it. */
async function serverJSON() {
  const c = new NetClient(s, alice.token, ws, pageId, alice.user.id);
  await c.load();
  return { json: c.json(), texts: c.texts() };
}

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

let fresh = 0;
function randomEdit(c: NetClient, rand: () => number) {
  const blocks = c.blocks().filter((b) => b.text);
  if (!blocks.length) return;
  const b = blocks[Math.floor(rand() * blocks.length)]!;
  const len = readText(c.view, b).units.length;
  c.edit((v: MemoryState, apply) => {
    const k = rand();
    if (k < 0.5) {
      const op = insertOps(v, c.clock, v.getBlock(b.id)!, Math.floor(rand() * (len + 1)), [..."ab".slice(0, 1 + Math.floor(rand() * 2))]);
      if (op) apply(op);
    } else if (k < 0.65 && len) {
      const from = Math.floor(rand() * len);
      for (const op of deleteOps(v, c.clock, v.getBlock(b.id)!, from, Math.min(len, from + 2))) apply(op);
    } else if (k < 0.72 && len > 1) {
      for (const op of markOps(v, c.clock, v.getBlock(b.id)!, 0, 2, "bold", true)) apply(op);
    } else if (k < 0.82 && len > 2) {
      const id = `${c.session}-n${++fresh}`;
      apply({ op: "split", id: b.id, at: readText(v, v.getBlock(b.id)!).ids[1 + Math.floor(rand() * (len - 1))]!, newId: id, newInstance: id, type: "paragraph", properties: {} });
    } else if (k < 0.88) {
      const sibs = c.blocks().filter((x) => x.text && x.parent_id === b.parent_id);
      const i = sibs.findIndex((x) => x.id === b.id);
      if (i > 0) apply({ op: "merge", into: sibs[i - 1]!.id, from: b.id });
    } else if (k < 0.94) {
      const id = `${c.session}-n${++fresh}`;
      apply({ op: "create", id, type: "paragraph", parent: pageId, after: b.parent_id === pageId ? b.id : null, properties: {}, text: null });
    } else {
      apply({ op: "move", id: b.id, parent: pageId, after: null });
    }
  });
}

describe("sync over HTTP + WebSocket", () => {
  it("loads the page with its records and text", async () => {
    const a = await client(alice);
    expect(a.texts()).toEqual(["First paragraph", "Second paragraph", "A task"]);
    expect(a.view.getBlock(pageId)!.properties.title).toBe("Sync test");
  });

  it("a transaction is confirmed to its sender and pushed to the others", async () => {
    const [a, b] = [clients[0]!, await client(bob)];
    const first = a.blocks()[0]!.id;
    a.edit((v, apply) => apply(insertOps(v, a.clock, v.getBlock(first)!, 5, [..." (Alice)"])!));
    await a.flush();
    expect(a.replica.pending).toHaveLength(0);
    await waitFor(() => b.texts()[0] === "First (Alice) paragraph", 3000, "Bob receives Alice's edit");
  });

  it("relays presence between clients on the page", async () => {
    const [a, b] = clients;
    a!.setPresence({ block: a!.blocks()[0]!.id, item: null });
    await waitFor(() => [...b!.presence.values()].some((p) => p.user?.name === "Alice Chen"), 3000, "Bob sees Alice's cursor");
  });

  it("converges after interleaved concurrent edits from 3 clients", async () => {
    const [a, b] = clients;
    const c = await client(bob);
    const r = rng(42);
    for (let i = 0; i < 120; i++) {
      const who = [a!, b!, c][Math.floor(r() * 3)]!;
      randomEdit(who, r);
      if (r() < 0.3) await who.flush();
    }
    await Promise.all([a!.flush(), b!.flush(), c.flush()]);
    const truth = await serverJSON();
    for (const x of [a!, b!, c]) await waitFor(() => x.json() === truth.json, 5000, "client converges");
  });

  it("merges offline edits on reconnect (both sides edited the same paragraph)", async () => {
    const [a, b] = clients;
    const id = a!.blocks().find((x) => x.text)!.id;
    b!.goOffline();
    b!.edit((v, apply) => apply(insertOps(v, b!.clock, v.getBlock(id)!, 0, [..."[Bob offline] "])!));
    a!.edit((v, apply) => apply(insertOps(v, a!.clock, v.getBlock(id)!, readText(v, v.getBlock(id)!).units.length, [..." [Alice online]"])!));
    await a!.flush();
    expect(b!.texts().join("")).not.toContain("Alice online");
    await b!.goOnline();
    const truth = await serverJSON();
    expect(truth.texts.join("|")).toContain("[Bob offline]");
    expect(truth.texts.join("|")).toContain("[Alice online]");
    for (const x of [a!, b!]) await waitFor(() => x.json() === truth.json, 5000, "converged after reconnect");
  });

  it("keeps the block table and derived text in step with the edits", async () => {
    const truth = await serverJSON();
    const { blocks } = (await s.api(alice.token, "GET", `/api/pages/${pageId}/blocks`)).body;
    const live = blocks.filter((b: any) => b.properties.rich_text);
    const restText = new Set(live.map((b: any) => b.properties.rich_text.map((r: any) => r.text).join("")));
    expect(truth.texts.filter((t) => !restText.has(t))).toEqual([]);
  });

  it("pushes server-side edits (REST rename) to connected editors", async () => {
    await s.api(alice.token, "PATCH", `/api/pages/${pageId}`, { title: "Renamed via REST" });
    await waitFor(() => clients[0]!.view.getBlock(pageId)!.properties.title === "Renamed via REST", 3000, "rename reaches the editor");
  });

  it("rejects transactions from read-only share-link viewers and non-members", async () => {
    const share = (await s.api(alice.token, "PUT", `/api/pages/${pageId}/share`, { enabled: true, access: "view" })).body.share;
    const carol = (await s.api(null, "POST", "/api/auth/signup", { email: "carol-sync@x.dev", name: "Carol", password: "secret1" })).body;
    const id = clients[0]!.blocks()[0]!.id;
    const tx = { id: "evil", ops: [{ op: "update", id, properties: { checked: true } }] };
    const r = await s.api(carol.token, "POST", "/api/saveTransactions", { transactions: [tx], session: "x" }, { "x-leaf-share": share.token });
    expect(r.status).toBe(403);
    expect((await s.api(null, "POST", "/api/saveTransactions", { transactions: [tx], session: "x" })).status).toBe(401);
  });

  it("rejects unauthenticated WebSocket connections", async () => {
    const sock = new WebSocket(`${s.wsUrl}/ws/events?workspace=${ws}`);
    const code = await new Promise<string>((r) => {
      sock.on("unexpected-response", (_req, res) => r(String(res.statusCode)));
      sock.on("open", () => r("open"));
    });
    expect(code).toBe("401");
  });

  it("logs ops per commit, compacts them, and collects old tombstones' content", async () => {
    const a = clients[0]!;
    const id = a.blocks().find((x) => x.text)!.id;
    const inst = a.view.getBlock(id)!.text![0]!.i;
    a.edit((v, apply) => apply(insertOps(v, a.clock, v.getBlock(id)!, 0, [..."TEMP "])!));
    await a.flush();
    a.edit((v, apply) => {
      for (const op of deleteOps(v, a.clock, v.getBlock(id)!, 0, 5)) apply(op);
    });
    await a.flush();
    const logged = () => (s.leaf.db.prepare("SELECT COUNT(*) AS n FROM text_ops WHERE instance_id = ?").get(inst) as { n: number }).n;
    expect(logged()).toBeGreaterThan(0);
    // Compaction with a zero TTL: the log folds into the state, and "TEMP " loses its content.
    (s.leaf.sync as any).opts.tombstoneTtlMs = -1;
    s.leaf.sync.compact(inst);
    (s.leaf.sync as any).opts.tombstoneTtlMs = undefined;
    expect(logged()).toBe(0);
    const stored = (s.leaf.db.prepare("SELECT state FROM text_instances WHERE id = ?").get(inst) as { state: string }).state;
    expect(stored).not.toContain("TEMP");
    // A fresh client still converges with the others.
    const fresh = await client(alice);
    await waitFor(() => fresh.json() === a.json(), 3000, "fresh client matches");
  });

  it("persists: a restarted server serves the identical document", async () => {
    const before = await serverJSON();
    // A second server process on the same data file (the first one's memory isn't used).
    const leaf2 = new Leaf({ dbFile: s.dbFile, aiModel: null });
    const { records, instances } = leaf2.sync.docRecords(pageId);
    const c = new NetClient(s, alice.token, ws, pageId, alice.user.id);
    c.replica.load(records, instances);
    expect(c.json()).toBe(before.json);
    leaf2.close();
  });
});
