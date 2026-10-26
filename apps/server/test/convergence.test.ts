/**
 * Multi-client convergence over the real WebSocket server.
 *
 * Several y-websocket clients (the same provider the browser uses) connect to one page,
 * make interleaved concurrent edits (text inserts/deletes at random positions, new
 * blocks, formatting, structural deletes), one goes offline and keeps editing, then
 * reconnects. We assert every replica ends byte-for-byte identical, that the server's
 * block-table projection matches the clients' documents, and that the state survives a
 * server restart.
 */
import { getFragment, newId, projectFragment } from "@leaf/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { Leaf } from "../src/app.js";
import { startServer, sleep, waitFor, type TestServer } from "./helpers.js";

let s: TestServer;
let alice: any;
let bob: any;
let pageId: string;
const providers: WebsocketProvider[] = [];

function client(token: string, name: string, extra: Record<string, string> = {}) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`${s.wsUrl}/ws/doc`, pageId, doc, {
    WebSocketPolyfill: WebSocket as any,
    params: { token, ...extra },
    disableBc: true,
  });
  provider.awareness.setLocalStateField("user", { name, color: "#e16259" });
  providers.push(provider);
  return { doc, provider, frag: getFragment(doc) };
}
type Client = ReturnType<typeof client>;

const synced = (c: Client) => new Promise<void>((r) => (c.provider.synced ? r() : c.provider.once("sync", (ok: boolean) => ok && r())));

// Seeded PRNG so failures are reproducible.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

function paragraphs(frag: Y.XmlFragment) {
  return frag.toArray().filter((e): e is Y.XmlElement => e instanceof Y.XmlElement && e.nodeName === "paragraph");
}

function textOf(p: Y.XmlElement): Y.XmlText {
  let t = p.toArray().find((c) => c instanceof Y.XmlText) as Y.XmlText | undefined;
  if (!t) {
    t = new Y.XmlText();
    p.insert(0, [t]);
  }
  return t;
}

/** One random edit, the kinds of change a ProseMirror binding makes. */
function randomEdit(c: Client, rand: () => number, tag: string) {
  c.doc.transact(() => {
    const ps = paragraphs(c.frag);
    const roll = rand();
    if (roll < 0.15 || ps.length === 0) {
      const p = new Y.XmlElement("paragraph");
      p.setAttribute("blockId", newId());
      p.insert(0, [new Y.XmlText(`${tag}-new `)]);
      c.frag.insert(1 + Math.floor(rand() * (c.frag.length - 1 + 1)), [p]);
    } else if (roll < 0.7) {
      const t = textOf(ps[Math.floor(rand() * ps.length)]!);
      t.insert(Math.floor(rand() * (t.length + 1)), tag);
    } else if (roll < 0.85) {
      const t = textOf(ps[Math.floor(rand() * ps.length)]!);
      if (t.length > 2) {
        const at = Math.floor(rand() * (t.length - 1));
        t.delete(at, Math.min(2, t.length - at));
      }
    } else if (roll < 0.95) {
      const t = textOf(ps[Math.floor(rand() * ps.length)]!);
      if (t.length > 1) t.format(0, Math.ceil(t.length / 2), { bold: {} });
    } else if (ps.length > 2) {
      const victim = ps[Math.floor(rand() * ps.length)]!;
      c.frag.delete(c.frag.toArray().indexOf(victim), 1);
    }
  });
}

beforeAll(async () => {
  s = await startServer();
  alice = await s.login("alice@leaf.dev");
  bob = await s.login("bob@leaf.dev");
  const ws = alice.workspaces[0].id;
  const r = await s.api(alice.token, "POST", "/api/pages", {
    workspaceId: ws,
    title: "Convergence",
    content: [
      { type: "paragraph", properties: { rich_text: [{ text: "alpha" }] } },
      { type: "paragraph", properties: { rich_text: [{ text: "beta" }] } },
      { type: "paragraph", properties: { rich_text: [{ text: "gamma" }] } },
    ],
  });
  pageId = r.body.page.id;
});

afterAll(async () => {
  for (const p of providers) p.destroy();
  await s.close();
});

describe("real-time convergence over WebSocket", () => {
  let a: Client, a2: Client, b: Client;

  it("syncs the initial document to every client", async () => {
    a = client(alice.token, "Alice");
    a2 = client(alice.token, "Alice (tab 2)");
    b = client(bob.token, "Bob");
    await Promise.all([synced(a), synced(a2), synced(b)]);
    for (const c of [a, a2, b]) expect(projectFragment(c.frag, pageId).title).toBe("Convergence");
  });

  it("shares presence (awareness) between clients", async () => {
    await waitFor(() => [...a.provider.awareness.getStates().values()].some((st: any) => st.user?.name === "Bob"), 5000, "Bob's presence at Alice");
    const names = [...b.provider.awareness.getStates().values()].map((st: any) => st.user?.name).sort();
    expect(names).toEqual(expect.arrayContaining(["Alice", "Alice (tab 2)", "Bob"]));
  });

  it("converges after interleaved concurrent edits from 3 clients", async () => {
    const r = rng(42);
    for (let round = 0; round < 60; round++) {
      randomEdit(a, r, "A");
      randomEdit(a2, r, "a");
      randomEdit(b, r, "B");
      if (round % 7 === 0) await sleep(5); // let some messages cross mid-stream
    }
    await waitFor(() => a.frag.toString() === b.frag.toString() && b.frag.toString() === a2.frag.toString(), 8000, "convergence");
    expect(Y.encodeStateVector(a.doc)).toEqual(Y.encodeStateVector(b.doc));
  });

  it("merges offline edits on reconnect (both sides edited the same paragraph)", async () => {
    b.provider.disconnect();
    await sleep(50);
    const pa = textOf(paragraphs(a.frag)[0]!);
    const pb = textOf(paragraphs(b.frag)[0]!);
    pa.insert(0, "[online-A]");
    pb.insert(pb.length, "[offline-B]");
    const extra = new Y.XmlElement("paragraph");
    extra.setAttribute("blockId", "offline-block");
    extra.insert(0, [new Y.XmlText("written while offline")]);
    b.frag.insert(b.frag.length, [extra]);
    await sleep(100);
    expect(a.frag.toString()).not.toContain("offline-B");
    b.provider.connect();
    await waitFor(() => a.frag.toString() === b.frag.toString() && a2.frag.toString() === b.frag.toString(), 8000, "offline merge");
    const first = textOf(paragraphs(a.frag)[0]!).toString();
    expect(first).toContain("[online-A]");
    expect(first).toContain("[offline-B]");
    expect(a.frag.toString()).toContain("written while offline");
  });

  it("projects the converged document into the block table", async () => {
    await waitFor(async () => {
      const server = (await s.api(alice.token, "GET", `/api/pages/${pageId}/blocks`)).body;
      const proj = projectFragment(a.frag, pageId);
      return JSON.stringify(server.page.content) === JSON.stringify(proj.content);
    }, 5000, "projection catches up");
    const server = (await s.api(alice.token, "GET", `/api/pages/${pageId}/blocks`)).body;
    const proj = projectFragment(a.frag, pageId);
    expect(server.page.properties.title).toBe("Convergence");
    const rows = new Map(server.blocks.map((blk: any) => [blk.id, blk]));
    expect(server.blocks).toHaveLength(proj.blocks.length);
    for (const blk of proj.blocks) {
      const row: any = rows.get(blk.id);
      expect(row, `block ${blk.id} in DB`).toBeTruthy();
      expect(row.type).toBe(blk.type);
      expect(row.properties).toEqual(blk.properties);
      expect(row.parent_id).toBe(pageId);
    }
    expect(rows.has("offline-block")).toBe(true);
    // Edits are attributed to the users who made them.
    const editors = new Set(server.blocks.map((blk: any) => blk.last_edited_by));
    expect(editors.has(bob.user.id) || editors.has(alice.user.id)).toBe(true);
  });

  it("pushes server-side edits (REST rename) to connected editors", async () => {
    await s.api(bob.token, "PATCH", `/api/pages/${pageId}`, { title: "Converged!" });
    await waitFor(() => projectFragment(a.frag, pageId).title === "Converged!" && projectFragment(b.frag, pageId).title === "Converged!", 5000, "title broadcast");
  });

  it("ignores edits from read-only share-link viewers", async () => {
    const share = (await s.api(alice.token, "PUT", `/api/pages/${pageId}/share`, { enabled: true, access: "view" })).body.share;
    const viewer = client("", "Viewer", { share: share.token });
    await synced(viewer);
    expect(viewer.frag.toString()).toBe(a.frag.toString());
    textOf(paragraphs(viewer.frag)[0]!).insert(0, "VANDAL");
    await sleep(300);
    expect(a.frag.toString()).not.toContain("VANDAL");
    viewer.provider.destroy();
  });

  it("rejects unauthenticated connections", async () => {
    const status = await new Promise<number>((resolve) => {
      const sock = new WebSocket(`${s.wsUrl}/ws/doc/${pageId}`);
      sock.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      sock.on("open", () => resolve(101));
    });
    expect(status).toBe(401);
  });

  it("persists: a restarted server serves the identical document", async () => {
    const expected = a.frag.toString();
    for (const p of providers) p.destroy();
    providers.length = 0;
    await sleep(100);
    const dbFile = s.dbFile;
    await s.close();
    const reopened = new Leaf({ dbFile });
    const live = reopened.docs.get(pageId);
    expect(getFragment(live.doc).toString()).toBe(expected);
    reopened.close();
    s = await startServer({ dir: s.dir, seed: false });
  });
});
