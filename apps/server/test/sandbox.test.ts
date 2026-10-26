/** Guest sandboxes, invite links, the expiry sweep, and WebSocket tickets for cross-site deployments. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { signTicket, verifyTicket } from "../src/auth.js";
import { startServer, type TestServer } from "./helpers.js";

let s: TestServer;
beforeAll(async () => {
  s = await startServer();
});
afterAll(() => s.close());

const count = (sql: string, ...args: unknown[]) => (s.leaf.db.prepare(sql).get(...(args as any[])) as { n: number }).n;

describe("guest sandboxes", () => {
  it("'Try Leaf' gives a visitor a private copy of the demo workspace", async () => {
    const r = await s.api(null, "POST", "/api/auth/guest", undefined, { "x-forwarded-for": "10.0.0.1" });
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toMatch(/leaf_session=/);
    const [ws] = r.body.workspaces;
    expect(ws.expires_at).toBeGreaterThan(Date.now());
    const tree = (await s.api(r.body.token, "GET", `/api/workspaces/${ws.id}/pages`)).body;
    const titles = tree.blocks.map((b: any) => b.properties.title);
    expect(titles).toEqual(expect.arrayContaining(["Welcome to Leaf", "Product Roadmap", "Sprints", "Q4 Roadmap"]));
    // Isolated: the seeded Alice workspace is not visible, and Alice can't see the sandbox.
    const alice = await s.login("alice@leaf.dev");
    expect((await s.api(alice.token, "GET", `/api/workspaces/${ws.id}/pages`)).status).toBe(403);
    expect((await s.api(r.body.token, "GET", `/api/workspaces/${alice.workspaces[0].id}/pages`)).status).toBe(403);
  });

  it("an invite link brings a second person into the sandbox", async () => {
    const owner = (await s.api(null, "POST", "/api/auth/guest", undefined, { "x-forwarded-for": "10.0.0.2" })).body;
    const ws = owner.workspaces[0].id;
    const { token } = (await s.api(owner.token, "POST", `/api/workspaces/${ws}/join-links`)).body;
    const friend = await s.api(null, "POST", "/api/auth/join", { token }, { "x-forwarded-for": "10.0.0.3" });
    expect(friend.status).toBe(200);
    expect(friend.body.workspaces.map((w: any) => w.id)).toEqual([ws]);
    expect((await s.api(null, "POST", "/api/auth/join", { token: "nope" })).status).toBe(404);
  });

  it("rate limits sandboxes per address", async () => {
    let status = 200;
    for (let i = 0; i < 12 && status === 200; i++) status = (await s.api(null, "POST", "/api/auth/guest", undefined, { "x-forwarded-for": "10.9.9.9" })).status;
    expect(status).toBe(429);
  });

  it("the sweep deletes expired sandboxes completely, and nothing else", async () => {
    const before = count("SELECT COUNT(*) AS n FROM blocks WHERE workspace_id = (SELECT id FROM workspaces WHERE expires_at IS NULL LIMIT 1)");
    const swept = s.leaf.sweepExpired(Date.now() + 48 * 3_600_000);
    expect(swept).toBeGreaterThanOrEqual(2);
    expect(count("SELECT COUNT(*) AS n FROM workspaces WHERE expires_at IS NOT NULL")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM users WHERE guest = 1")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM blocks WHERE workspace_id NOT IN (SELECT id FROM workspaces)")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM ydocs WHERE doc_id NOT IN (SELECT id FROM blocks)")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM join_links")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM blocks WHERE workspace_id = (SELECT id FROM workspaces WHERE expires_at IS NULL LIMIT 1)")).toBe(before);
    await s.login("alice@leaf.dev"); // the real workspace still works
  });
});

describe("WebSocket tickets", () => {
  it("are signed, user-bound and expire", () => {
    const { ticket } = signTicket("u1", 1000);
    expect(verifyTicket(ticket, 2000)).toBe("u1");
    expect(verifyTicket(ticket, 1000 + 61 * 60_000)).toBeNull();
    expect(verifyTicket(ticket.replace(/.$/, (c) => (c === "A" ? "B" : "A")), 2000)).toBeNull();
    expect(verifyTicket("garbage", 2000)).toBeNull();
  });

  it("authenticate a WebSocket without the cookie", async () => {
    const alice = await s.login("alice@leaf.dev");
    const { ticket } = (await s.api(alice.token, "GET", "/api/auth/ws-ticket")).body;
    const page = (await s.api(alice.token, "GET", `/api/workspaces/${alice.workspaces[0].id}/pages`)).body.blocks.find((b: any) => b.type === "page");
    const open = (q: string) =>
      new Promise<number | "open">((resolve) => {
        const ws = new WebSocket(`${s.wsUrl}/ws/doc/${page.id}?${q}`);
        ws.on("open", () => (ws.close(), resolve("open")));
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      });
    expect(await open(`ticket=${encodeURIComponent(ticket)}`)).toBe("open");
    expect(await open("ticket=forged.ticket")).toBe(401);
  });
});
