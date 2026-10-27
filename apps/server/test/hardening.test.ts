/**
 * The sync service under hostile and unlucky conditions: re-sent transactions, failed
 * transactions, malformed ops, and attempts to reach text in another workspace.
 */
import { insertOps, readText, unitsText } from "@leaf/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NetClient } from "./client.js";
import { startServer, type TestServer } from "./helpers.js";

let s: TestServer;
let alice: any;
let carol: any;
let ws: string;
let pageId: string;
let blockIds: string[];

beforeAll(async () => {
  s = await startServer();
  alice = await s.login("alice@leaf.dev");
  ws = alice.workspaces[0].id;
  const page = await s.api(alice.token, "POST", "/api/pages", {
    workspaceId: ws,
    title: "Hardening",
    content: ["one", "two", "three"].map((text) => ({ type: "paragraph", properties: { rich_text: [{ text }] } })),
  });
  pageId = page.body.page.id;
  blockIds = s.leaf.store.get(pageId)!.content;
  carol = (await s.api(null, "POST", "/api/auth/signup", { email: "carol-hard@x.dev", name: "Carol", password: "secret1" })).body;
});
afterAll(() => s.close());

const save = (token: string, tx: unknown, session = "test") => s.api(token, "POST", "/api/saveTransactions", { transactions: [tx], session });
const textOf = (id: string) => s.leaf.store.get(id)!.properties.rich_text.map((r: any) => r.text).join("");

describe("hardening", () => {
  it("a re-sent transaction is applied once (its answer was lost)", async () => {
    const [one, , three] = blockIds;
    const tx = { id: "resend-1", ops: [{ op: "move", id: one, parent: pageId, after: three }] };
    expect((await save(alice.token, tx)).status).toBe(200);
    // Someone else moves it back to the top afterwards.
    expect((await save(alice.token, { id: "other-1", ops: [{ op: "move", id: one, parent: pageId, after: null }] }, "other")).status).toBe(200);
    expect(s.leaf.store.get(pageId)!.content[0]).toBe(one);
    // The first client re-sends: nothing is re-applied, and it gets the current records.
    const again = await save(alice.token, tx);
    expect(again.status).toBe(200);
    expect(s.leaf.store.get(pageId)!.content[0]).toBe(one);
    expect(again.body.commit.records.map((r: any) => r.id)).toContain(one);
  });

  it("a transaction that fails leaves no trace, in the database or in memory", async () => {
    const c = await new NetClient(s, alice.token, ws, pageId, alice.user.id).open();
    const id = blockIds[1]!;
    const before = textOf(id);
    const ins = insertOps(c.view, c.clock, c.view.getBlock(id)!, 0, [..."SHOULD NOT STAY "])!;
    // A valid insert, then an op the server refuses: the whole transaction is rejected.
    const db = s.leaf.store.structure(ws).find((b) => b.type === "database")!;
    const r = await save(alice.token, { id: "fails-1", ops: [ins, { op: "update", id: db.id, properties: { title: "hacked" } }] });
    expect(r.status).toBe(400);
    expect(textOf(id)).toBe(before);
    const fresh = await new NetClient(s, alice.token, ws, pageId, alice.user.id).open();
    expect(unitsText(readText(fresh.view, fresh.view.getBlock(id)!).units)).toBe(before);
    c.close();
    fresh.close();
  });

  it("rejects malformed ops", async () => {
    const id = blockIds[2]!;
    const bad = [
      { op: "text", instance: id, ops: [{ t: "ins", id: "x@1", parent: null, side: "R", value: ["two chars"] }] },
      { op: "text", instance: id, ops: [{ t: "ins", id: "no-clock", parent: null, side: "R", value: ["a"] }] },
      { op: "text", instance: id, ops: [{ t: "ins", id: "x@1", parent: null, side: "R", value: [], gc: 5 }] },
      { op: "text", instance: id, ops: [{ t: "mark", id: "x@2", mark: "script", value: true, start: null, end: null }] },
      { op: "create", id: "n1", type: "iframe", parent: pageId, after: null, properties: {}, text: null },
      { op: "create", id: "n2", type: "paragraph", parent: pageId, after: null, properties: { blob: "x".repeat(70_000) }, text: null },
      { op: "split", id, at: null, newId: "n3", newInstance: "someone-else", type: "paragraph", properties: {} },
      { op: "detach", id },
      { op: "nonsense" },
    ];
    for (const op of bad) expect((await save(alice.token, { id: `bad-${Math.random()}`, ops: [op] })).status).toBe(400);
  });

  it("can't read or write another workspace's text through slices or text ops", async () => {
    const carolWs = carol.workspaces[0].id;
    const carolPage = (await s.api(carol.token, "POST", "/api/pages", { workspaceId: carolWs, title: "Mine" })).body.page;
    const aliceBlock = blockIds[0]!;
    // Point a new block's text at Alice's block's instance: its derived text would leak.
    const steal = { op: "create", id: "steal-1", type: "paragraph", parent: carolPage.id, after: null, properties: {}, text: [{ i: aliceBlock, from: null, to: null }] };
    expect((await save(carol.token, { id: "steal-tx", ops: [steal] })).status).toBe(403);
    // Re-point one of her own blocks at it.
    const own = s.leaf.store.get(carolPage.id)!.content[0]!;
    expect((await save(carol.token, { id: "steal-tx2", ops: [{ op: "update", id: own, text: [{ i: aliceBlock, from: null, to: null }] }] })).status).toBe(403);
    // Write into it directly.
    const write = { op: "text", instance: aliceBlock, ops: [{ t: "ins", id: "carol@999", parent: null, side: "R", value: ["!"] }] };
    expect((await save(carol.token, { id: "steal-tx3", ops: [write] })).status).toBe(403);
    // Invent text nobody owns.
    const ghost = { op: "text", instance: "ghost-instance", ops: [{ t: "ins", id: "carol@1000", parent: null, side: "R", value: ["?"] }] };
    expect((await save(carol.token, { id: "steal-tx4", ops: [ghost] })).status).toBe(400);
    expect(textOf(aliceBlock)).not.toContain("!");
  });
});
