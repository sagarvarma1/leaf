import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type TestServer } from "./helpers.js";

let s: TestServer;
let alice: { token: string; user: any; workspaces: any[] };
let bob: { token: string; user: any; workspaces: any[] };
let ws: string;

beforeAll(async () => {
  s = await startServer();
  alice = await s.login("alice@leaf.dev");
  bob = await s.login("bob@leaf.dev");
  ws = alice.workspaces[0].id;
});
afterAll(() => s.close());

const tree = async (token = alice.token) => (await s.api(token, "GET", `/api/workspaces/${ws}/pages`)).body;
const byTitle = async (title: string) => (await tree()).blocks.find((b: any) => b.properties.title === title);

describe("auth", () => {
  it("signs up, gets a personal workspace, logs out", async () => {
    const r = await s.api(null, "POST", "/api/auth/signup", { email: "Carol@Example.com", name: "Carol", password: "secret1" });
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toMatch(/leaf_session=.+HttpOnly/);
    expect(r.body.user.email).toBe("carol@example.com");
    expect(r.body.workspaces).toHaveLength(1);
    const me = await s.api(r.body.token, "GET", "/api/auth/me");
    expect(me.body.user.name).toBe("Carol");
    await s.api(r.body.token, "POST", "/api/auth/logout");
    expect((await s.api(r.body.token, "GET", "/api/auth/me")).body.user).toBeNull();
  });

  it("rejects bad credentials, duplicate emails and weak passwords", async () => {
    expect((await s.api(null, "POST", "/api/auth/login", { email: "alice@leaf.dev", password: "nope" })).status).toBe(401);
    expect((await s.api(null, "POST", "/api/auth/signup", { email: "alice@leaf.dev", name: "A", password: "secret1" })).status).toBe(409);
    expect((await s.api(null, "POST", "/api/auth/signup", { email: "x@y.z", name: "X", password: "123" })).status).toBe(400);
  });

  it("stores passwords hashed", () => {
    const row = s.leaf.db.prepare("SELECT password_hash FROM users WHERE email = 'alice@leaf.dev'").get() as any;
    expect(row.password_hash).toMatch(/^scrypt\$/);
    expect(row.password_hash).not.toContain("leafdemo");
  });
});

describe("seeded workspace and permissions", () => {
  it("both demo users see the shared workspace", async () => {
    expect(bob.workspaces.map((w: any) => w.id)).toContain(ws);
    const t = await tree(bob.token);
    expect(t.blocks.map((b: any) => b.properties.title)).toEqual(expect.arrayContaining(["Welcome to Leaf", "Product Roadmap", "Q4 Roadmap", "Oct 21 sync"]));
    expect(t.root.length).toBe(4);
  });

  it("non-members are rejected", async () => {
    const carol = await s.login("carol@example.com", "secret1");
    expect((await s.api(carol.token, "GET", `/api/workspaces/${ws}/pages`)).status).toBe(403);
    const welcome = await byTitle("Welcome to Leaf");
    expect((await s.api(carol.token, "GET", `/api/pages/${welcome.id}`)).status).toBe(403);
    expect((await s.api(null, "GET", `/api/pages/${welcome.id}`)).status).toBe(401);
  });

  it("share links grant view or edit on a page and its sub-pages", async () => {
    const roadmap = await byTitle("Product Roadmap");
    const notes = await byTitle("Oct 21 sync");
    const welcome = await byTitle("Welcome to Leaf");
    const share = (await s.api(alice.token, "PUT", `/api/pages/${roadmap.id}/share`, { enabled: true, access: "view" })).body.share;
    expect(share.token).toBeTruthy();
    const resolved = await s.api(null, "GET", `/api/share/${share.token}`);
    expect(resolved.body).toMatchObject({ pageId: roadmap.id, access: "view" });
    const h = { "x-leaf-share": share.token };
    expect((await s.api(null, "GET", `/api/pages/${notes.id}`, undefined, h)).body.access).toBe("view");
    expect((await s.api(null, "GET", `/api/pages/${welcome.id}`, undefined, h)).status).toBe(401);
    expect((await s.api(null, "PATCH", `/api/pages/${roadmap.id}`, { title: "hacked" }, h)).status).toBe(403);

    const carol = await s.login("carol@example.com", "secret1");
    await s.api(alice.token, "PUT", `/api/pages/${roadmap.id}/share`, { enabled: true, access: "edit" });
    expect((await s.api(carol.token, "GET", `/api/pages/${roadmap.id}`, undefined, h)).body.access).toBe("edit");
    expect((await s.api(null, "GET", `/api/pages/${roadmap.id}`, undefined, h)).body.access).toBe("view"); // anonymous: view only
    await s.api(alice.token, "PUT", `/api/pages/${roadmap.id}/share`, { enabled: false, access: "edit" });
    expect((await s.api(carol.token, "GET", `/api/pages/${roadmap.id}`, undefined, h)).status).toBe(403);
  });

  it("members can be invited by email", async () => {
    const r = await s.api(alice.token, "POST", `/api/workspaces/${ws}/members`, { email: "carol@example.com" });
    expect(r.body.members.map((m: any) => m.name)).toContain("Carol");
    const carol = await s.login("carol@example.com", "secret1");
    expect((await s.api(carol.token, "GET", `/api/workspaces/${ws}/pages`)).status).toBe(200);
    const carolId = r.body.members.find((m: any) => m.name === "Carol").id;
    await s.api(alice.token, "DELETE", `/api/workspaces/${ws}/members/${carolId}`);
    expect((await s.api(carol.token, "GET", `/api/workspaces/${ws}/pages`)).status).toBe(403);
  });
});

describe("pages are blocks", () => {
  it("creates nested pages; sub-pages are child_page blocks in the parent's content", async () => {
    const parent = (await s.api(alice.token, "POST", "/api/pages", { workspaceId: ws, title: "Parent", icon: "🌳" })).body.page;
    expect(parent).toMatchObject({ type: "page", parent_id: null, properties: { title: "Parent", icon: "🌳" } });
    const child = (await s.api(alice.token, "POST", "/api/pages", { parentId: parent.id, title: "Child" })).body.page;
    expect(child.parent_id).toBe(parent.id);
    const p2 = (await s.api(alice.token, "GET", `/api/blocks/${parent.id}`)).body.block;
    expect(p2.content).toContain(child.id); // the child page itself sits in the parent's content array
    const crumbs = (await s.api(alice.token, "GET", `/api/pages/${child.id}`)).body.breadcrumbs;
    expect(crumbs.map((c: any) => c.title)).toEqual(["Parent", "Child"]);
  });

  it("renames through the document, sets icon and cover", async () => {
    const page = (await s.api(alice.token, "POST", "/api/pages", { workspaceId: ws, title: "Old" })).body.page;
    const r = await s.api(alice.token, "PATCH", `/api/pages/${page.id}`, { title: "New name", icon: "🔥", cover: "gradient-2" });
    expect(r.body.page.properties).toMatchObject({ title: "New name", icon: "🔥", cover: "gradient-2" });
    expect(s.leaf.exportMarkdown(page.id)).toContain("# 🔥 New name");
  });

  it("moves pages between parents and to the root, and refuses cycles", async () => {
    const a = (await s.api(alice.token, "POST", "/api/pages", { workspaceId: ws, title: "A" })).body.page;
    const b = (await s.api(alice.token, "POST", "/api/pages", { workspaceId: ws, title: "B" })).body.page;
    const c = (await s.api(alice.token, "POST", "/api/pages", { parentId: a.id, title: "C" })).body.page;
    await s.api(alice.token, "POST", `/api/pages/${c.id}/move`, { parentId: b.id });
    expect((await s.api(alice.token, "GET", `/api/blocks/${a.id}`)).body.block.content).not.toContain(c.id);
    expect((await s.api(alice.token, "GET", `/api/blocks/${b.id}`)).body.block.content).toContain(c.id);
    expect((await s.api(alice.token, "GET", `/api/blocks/${c.id}`)).body.block.archived).toBe(false);
    expect((await s.api(alice.token, "POST", `/api/pages/${b.id}/move`, { parentId: c.id })).status).toBe(400);
    await s.api(alice.token, "POST", `/api/pages/${c.id}/move`, { parentId: null, beforeId: a.id });
    const t = await tree();
    expect(t.root.indexOf(c.id)).toBe(t.root.indexOf(a.id) - 1);
  });

  it("trash, restore and permanent delete", async () => {
    const parent = (await s.api(alice.token, "POST", "/api/pages", { workspaceId: ws, title: "Trash parent" })).body.page;
    const child = (await s.api(alice.token, "POST", "/api/pages", { parentId: parent.id, title: "Trash child" })).body.page;
    await s.api(alice.token, "DELETE", `/api/pages/${child.id}`);
    let c = (await s.api(alice.token, "GET", `/api/blocks/${child.id}`)).body.block;
    expect(c.archived).toBe(true);
    expect((await s.api(alice.token, "GET", `/api/blocks/${parent.id}`)).body.block.content).not.toContain(child.id);
    await s.api(alice.token, "POST", `/api/pages/${child.id}/restore`);
    c = (await s.api(alice.token, "GET", `/api/blocks/${child.id}`)).body.block;
    expect(c.archived).toBe(false);
    expect((await s.api(alice.token, "GET", `/api/blocks/${parent.id}`)).body.block.content).toContain(child.id);
    expect((await s.api(alice.token, "DELETE", `/api/pages/${parent.id}/permanent`)).status).toBe(400);
    await s.api(alice.token, "DELETE", `/api/pages/${parent.id}`);
    await s.api(alice.token, "DELETE", `/api/pages/${parent.id}/permanent`);
    expect((await s.api(alice.token, "GET", `/api/blocks/${child.id}`)).status).toBe(404);
  });

  it("removing a sub-page block from the document trashes the page; undo restores it", async () => {
    const parent = (await s.api(alice.token, "POST", "/api/pages", { workspaceId: ws, title: "Doc parent" })).body.page;
    const child = (await s.api(alice.token, "POST", "/api/pages", { parentId: parent.id, title: "Doc child" })).body.page;
    // An editor removes the sub-page's link from the document: a delete op on the page block.
    const undo = s.leaf.sync.edit(alice.user.id, ({ apply }) => void apply({ op: "delete", id: child.id })).inverse;
    expect(s.leaf.store.get(child.id)!.archived).toBe(true);
    expect(s.leaf.store.get(parent.id)!.content).not.toContain(child.id);
    // Undo (the inverse op) restores it in place.
    s.leaf.sync.edit(alice.user.id, ({ apply }) => undo.forEach((op) => apply(op)));
    expect(s.leaf.store.get(child.id)!.archived).toBe(false);
    expect(s.leaf.store.get(parent.id)!.content).toContain(child.id);
  });

  it("favorites are per user", async () => {
    const page = (await s.api(alice.token, "POST", "/api/pages", { workspaceId: ws, title: "Fav" })).body.page;
    const r = await s.api(bob.token, "PUT", `/api/pages/${page.id}/favorite`);
    expect(r.body.favorites).toContain(page.id);
    expect((await s.api(alice.token, "GET", `/api/workspaces/${ws}/favorites`)).body.favorites).not.toContain(page.id);
    expect((await s.api(bob.token, "DELETE", `/api/pages/${page.id}/favorite`)).body.favorites).not.toContain(page.id);
  });
});

describe("content blocks over REST", () => {
  it("appends, updates and deletes blocks; the records reflect each write", async () => {
    const page = (await s.api(alice.token, "POST", "/api/pages", { workspaceId: ws, title: "API page" })).body.page;
    const r = await s.api(alice.token, "POST", `/api/blocks/${page.id}/children`, {
      children: [
        { type: "heading_2", properties: { rich_text: [{ text: "From the API" }] } },
        { type: "to_do", properties: { rich_text: [{ text: "Do it" }], checked: false } },
        { type: "bulleted_list_item", properties: { rich_text: [{ text: "parent" }] }, children: [{ type: "bulleted_list_item", properties: { rich_text: [{ text: "kid" }] } }] },
      ],
    });
    expect(r.status).toBe(200);
    const [h2, todo, li] = r.body.results;
    expect(h2.type).toBe("heading_2");
    expect(h2.page_id).toBe(page.id);
    expect(li.content).toHaveLength(1);
    const kid = (await s.api(alice.token, "GET", `/api/blocks/${li.id}/children`)).body.results[0];
    expect(kid).toMatchObject({ type: "bulleted_list_item", parent_id: li.id });

    await s.api(alice.token, "PATCH", `/api/blocks/${todo.id}`, { checked: true, rich_text: [{ text: "Done it", marks: { bold: true } }] });
    const t2 = (await s.api(alice.token, "GET", `/api/blocks/${todo.id}`)).body.block;
    expect(t2.properties).toEqual({ rich_text: [{ text: "Done it", marks: { bold: true } }], checked: true });
    expect(t2.last_edited_by).toBe(alice.user.id);

    await s.api(alice.token, "DELETE", `/api/blocks/${h2.id}`);
    const kids = (await s.api(alice.token, "GET", `/api/blocks/${page.id}/children`)).body.results;
    expect(kids.map((k: any) => k.id)).not.toContain(h2.id);
    expect((await s.api(alice.token, "GET", `/api/blocks/${h2.id}`)).status).toBe(404);
  });

  it("exports Markdown from the block table", async () => {
    const welcome = await byTitle("Welcome to Leaf");
    const r = await s.api(alice.token, "GET", `/api/pages/${welcome.id}/export`);
    expect(r.headers.get("content-type")).toContain("text/markdown");
    expect(r.text).toContain("# 👋 Welcome to Leaf");
    expect(r.text).toContain("- [x] Open this page");
    expect(r.text).toContain("<details><summary>How does sync work?</summary>");
  });
});

describe("databases", () => {
  it("creates a database with rows that are pages, applies schema ops and cell writes", async () => {
    const page = (await s.api(alice.token, "POST", "/api/pages", { workspaceId: ws, title: "DB host" })).body.page;
    const db = (await s.api(alice.token, "POST", "/api/databases", { pageId: page.id, title: "Bugs", append: true })).body.database;
    expect(db.parent_id).toBe(page.id);
    expect((await s.api(alice.token, "GET", `/api/blocks/${page.id}`)).body.block.content).toContain(db.id);
    let got = (await s.api(alice.token, "GET", `/api/databases/${db.id}`)).body;
    expect(got.rows).toHaveLength(3);
    expect(got.rows[0]).toMatchObject({ type: "page", parent_id: db.id });

    await s.api(alice.token, "POST", `/api/databases/${db.id}/ops`, { op: "addProperty", id: "sev", name: "Severity", type: "number" });
    const row = (await s.api(bob.token, "POST", `/api/databases/${db.id}/rows`, { title: "Crash on save", values: { status: "doing", sev: "2" } })).body.row;
    expect(row.properties).toMatchObject({ title: "Crash on save", values: { status: "doing", sev: 2 } });

    // Concurrent writes to different cells of the same row both survive (per-cell LWW).
    await Promise.all([
      s.api(alice.token, "PATCH", `/api/rows/${row.id}`, { values: { sev: 5 } }),
      s.api(bob.token, "PATCH", `/api/rows/${row.id}`, { values: { status: "done" } }),
    ]);
    got = (await s.api(alice.token, "GET", `/api/databases/${db.id}`)).body;
    const r2 = got.rows.find((r: any) => r.id === row.id);
    expect(r2.properties.values).toMatchObject({ sev: 5, status: "done" });

    // Title cell edits rename the row page (through its document).
    await s.api(alice.token, "PATCH", `/api/rows/${row.id}`, { values: { title: "Crash on save (fixed)" } });
    expect(s.leaf.store.get(row.id)!.properties.title).toBe("Crash on save (fixed)");

    expect((await s.api(alice.token, "PATCH", `/api/rows/${row.id}`, { values: { nope: 1 } })).status).toBe(400);
    expect((await s.api(alice.token, "POST", `/api/databases/${db.id}/ops`, { op: "deleteProperty", id: "title" })).status).toBe(400);

    const moved = (await s.api(alice.token, "POST", `/api/databases/${db.id}/ops`, { op: "moveRow", rowId: row.id, beforeId: got.rows[0].id })).body.database;
    expect(moved.content[0]).toBe(row.id);
    const view = { ...moved.properties.views[0], filters: [{ property: "status", operator: "equals", value: "done" }] };
    const v = (await s.api(alice.token, "POST", `/api/databases/${db.id}/ops`, { op: "upsertView", view })).body.database;
    expect(v.properties.views[0].filters).toHaveLength(1);
  });
});

describe("comments, versions, search", () => {
  it("threads comments on blocks and resolves them", async () => {
    const welcome = await byTitle("Welcome to Leaf");
    const list = (await s.api(alice.token, "GET", `/api/pages/${welcome.id}/comments`)).body.comments;
    expect(list).toHaveLength(2);
    expect(list[1].thread_id).toBe(list[0].id);
    const reply = (await s.api(bob.token, "POST", `/api/pages/${welcome.id}/comments`, { threadId: list[0].id, body: "Ship it" })).body.comment;
    expect(reply.block_id).toBe(list[0].block_id);
    await s.api(alice.token, "PATCH", `/api/comments/${list[0].id}`, { resolved: true });
    const after = (await s.api(alice.token, "GET", `/api/pages/${welcome.id}/comments`)).body.comments;
    expect(after.every((c: any) => c.resolved)).toBe(true);
    expect((await s.api(alice.token, "DELETE", `/api/comments/${reply.id}`)).status).toBe(403);
    expect((await s.api(bob.token, "DELETE", `/api/comments/${reply.id}`)).status).toBe(200);
  });

  it("snapshots and restores a page version", async () => {
    const page = (await s.api(alice.token, "POST", "/api/pages", { workspaceId: ws, title: "Versioned", content: [{ type: "paragraph", properties: { rich_text: [{ text: "first draft" }] } }] })).body.page;
    const v1 = (await s.api(alice.token, "POST", `/api/pages/${page.id}/versions`, { label: "v1" })).body.id;
    const block = (await s.api(alice.token, "GET", `/api/blocks/${page.id}/children`)).body.results[0];
    await s.api(alice.token, "PATCH", `/api/blocks/${block.id}`, { rich_text: [{ text: "second draft" }] });
    await s.api(alice.token, "PATCH", `/api/pages/${page.id}`, { title: "Versioned (edited)" });
    const preview = (await s.api(alice.token, "GET", `/api/versions/${v1}`)).body;
    expect(preview.markdown).toContain("first draft");
    await s.api(alice.token, "POST", `/api/versions/${v1}/restore`);
    const kids = (await s.api(alice.token, "GET", `/api/blocks/${page.id}/children`)).body.results;
    expect(kids[0].properties.rich_text[0].text).toBe("first draft");
    expect(s.leaf.store.get(page.id)!.properties.title).toBe("Versioned");
    const versions = (await s.api(alice.token, "GET", `/api/pages/${page.id}/versions`)).body.versions;
    expect(versions.map((v: any) => v.label)).toEqual(expect.arrayContaining(["v1", "Before restore"]));
  });

  it("full-text search over titles and block text, excluding trash", async () => {
    const r = (await s.api(alice.token, "GET", `/api/workspaces/${ws}/search?q=prototyp`)).body.results;
    expect(r[0].title).toBe("Oct 21 sync");
    expect(r[0].snippet).toContain("\u0002");
    const title = (await s.api(alice.token, "GET", `/api/workspaces/${ws}/search?q=roadmap`)).body.results;
    expect(title[0].title).toBe("Product Roadmap"); // title matches rank first
    const p = (await s.api(alice.token, "POST", "/api/pages", { workspaceId: ws, title: "Zebra unique" })).body.page;
    expect((await s.api(alice.token, "GET", `/api/workspaces/${ws}/search?q=zebra`)).body.results).toHaveLength(1);
    await s.api(alice.token, "DELETE", `/api/pages/${p.id}`);
    expect((await s.api(alice.token, "GET", `/api/workspaces/${ws}/search?q=zebra`)).body.results).toHaveLength(0);
    expect((await s.api(alice.token, "GET", `/api/workspaces/${ws}/search?q=`)).body.results.length).toBeGreaterThan(3);
  });
});

describe("block model: nesting, columns, synced blocks", () => {
  it("children of any block and columns project into the block table", async () => {
    const page = (await s.api(alice.token, "POST", "/api/pages", { workspaceId: ws, title: "Layouts" })).body.page;
    const r = await s.api(alice.token, "POST", `/api/blocks/${page.id}/children`, {
      children: [
        { type: "paragraph", properties: { rich_text: [{ text: "Parent" }] }, children: [{ type: "paragraph", properties: { rich_text: [{ text: "Child" }] } }] },
        { type: "column_list", children: [
          { type: "column", children: [{ type: "paragraph", properties: { rich_text: [{ text: "Left" }] } }] },
          { type: "column", children: [{ type: "paragraph", properties: { rich_text: [{ text: "Right" }] } }] },
        ] },
      ],
    });
    expect(r.status).toBe(200);
    const { blocks } = (await s.api(alice.token, "GET", `/api/pages/${page.id}/blocks`)).body;
    const parent = blocks.find((b: any) => b.properties.rich_text?.[0]?.text === "Parent");
    const child = blocks.find((b: any) => b.properties.rich_text?.[0]?.text === "Child");
    expect(parent.content).toEqual([child.id]);
    expect(child.parent_id).toBe(parent.id);
    const list = blocks.find((b: any) => b.type === "column_list");
    expect(list.content).toHaveLength(2);
    const cols = list.content.map((id: string) => blocks.find((b: any) => b.id === id));
    expect(cols.map((c: any) => c.type)).toEqual(["column", "column"]);
    const kids = (await s.api(alice.token, "GET", `/api/blocks/${cols[1].id}/children`)).body.results;
    expect(kids[0].properties.rich_text[0].text).toBe("Right");
    const md = (await s.api(alice.token, "GET", `/api/pages/${page.id}/export`)).text;
    expect(md).toContain("Parent\n\n  Child");
    expect(md).toContain("Left");
    expect(md).toContain("Right");
  });

  it("a synced block's content is shared by every page that shows it", async () => {
    const a = (await s.api(alice.token, "POST", "/api/pages", { workspaceId: ws, title: "Synced A" })).body.page;
    const b = (await s.api(alice.token, "POST", "/api/pages", { workspaceId: ws, title: "Synced B" })).body.page;
    const { container } = (await s.api(alice.token, "POST", "/api/synced-blocks", { pageId: a.id, content: [{ type: "paragraph", properties: { rich_text: [{ text: "Ship date is Friday" }] } }] })).body;
    expect(container.type).toBe("synced_block");
    expect(container.properties.synced_from).toBeNull();
    for (const pg of [a, b]) {
      await s.api(alice.token, "POST", `/api/blocks/${pg.id}/children`, { children: [{ type: "synced_block", properties: { synced_from: container.id } }] });
    }
    // Edit through the container: both pages see it.
    await s.api(bob.token, "POST", `/api/blocks/${container.id}/children`, { children: [{ type: "to_do", properties: { rich_text: [{ text: "zebracorn launch" }] } }] });
    for (const pg of [a, b]) {
      const md = (await s.api(alice.token, "GET", `/api/pages/${pg.id}/export`)).text;
      expect(md).toContain("Ship date is Friday");
      expect(md).toContain("- [ ] zebracorn launch");
    }
    const info = (await s.api(alice.token, "GET", `/api/synced-blocks/${container.id}`)).body;
    expect(info.original).toBe(a.id);
    expect(info.pages.map((p: any) => p.id).sort()).toEqual([a.id, b.id].sort());
    // Search credits every page that shows the synced text.
    const hits = (await s.api(alice.token, "GET", `/api/workspaces/${ws}/search?q=zebracorn`)).body.results;
    expect(hits.map((h: any) => h.id).sort()).toEqual([a.id, b.id].sort());
    // Non-members can't open the container's document.
    const carol = await s.login("carol@example.com", "secret1");
    expect((await s.api(carol.token, "GET", `/api/synced-blocks/${container.id}`)).status).toBe(403);
  });
});

describe("relations, rollups and formulas", () => {
  it("two-way relations stay mirrored; rollups and formulas compute; export shows them", async () => {
    const page = (await s.api(alice.token, "POST", "/api/pages", { workspaceId: ws, title: "Planning" })).body.page;
    const mk = async (title: string) => (await s.api(alice.token, "POST", "/api/databases", { pageId: page.id, title, append: true })).body.database;
    const projects = await mk("Projects");
    const tasks = await mk("Tasks");
    await s.api(alice.token, "POST", `/api/databases/${tasks.id}/ops`, { op: "addProperty", id: "points", name: "Points", type: "number" });
    let r = await s.api(alice.token, "POST", `/api/databases/${projects.id}/ops`, { op: "addProperty", id: "tasks", name: "Tasks", type: "relation", relation: { databaseId: tasks.id }, twoWay: true });
    expect(r.status).toBe(200);
    const mirrorId = r.body.database.properties.schema.tasks.relation.syncedPropertyId;
    expect(mirrorId).toBeTruthy();
    const tasksDb = (await s.api(alice.token, "GET", `/api/databases/${tasks.id}`)).body;
    expect(tasksDb.database.properties.schema[mirrorId]).toMatchObject({ type: "relation", name: "Projects", relation: { databaseId: projects.id, syncedPropertyId: "tasks" } });

    const [t1, t2] = tasksDb.rows;
    await s.api(alice.token, "PATCH", `/api/rows/${t1.id}`, { values: { points: 3 } });
    await s.api(alice.token, "PATCH", `/api/rows/${t2.id}`, { values: { points: 5 } });
    const proj = (await s.api(alice.token, "GET", `/api/databases/${projects.id}`)).body.rows[0];
    // Linking from the project side writes the mirror on each task; foreign ids are dropped.
    r = await s.api(bob.token, "PATCH", `/api/rows/${proj.id}`, { values: { tasks: [t1.id, t2.id, page.id] } });
    expect(r.body.row.properties.values.tasks).toEqual([t1.id, t2.id]);
    const task = async (id: string) => (await s.api(alice.token, "GET", `/api/blocks/${id}`)).body.block;
    expect((await task(t1.id)).properties.values[mirrorId]).toEqual([proj.id]);
    expect((await task(t2.id)).properties.values[mirrorId]).toEqual([proj.id]);
    // Unlinking removes the mirror.
    await s.api(bob.token, "PATCH", `/api/rows/${proj.id}`, { values: { tasks: [t2.id] } });
    expect((await task(t1.id)).properties.values[mirrorId]).toEqual([]);

    await s.api(alice.token, "PATCH", `/api/rows/${proj.id}`, { values: { tasks: [t1.id, t2.id] } });
    await s.api(alice.token, "POST", `/api/databases/${projects.id}/ops`, { op: "addProperty", id: "total", name: "Total", type: "rollup", rollup: { relationPropertyId: "tasks", targetPropertyId: "points", function: "sum" } });
    await s.api(alice.token, "POST", `/api/databases/${projects.id}/ops`, { op: "addProperty", id: "size", name: "Size", type: "formula", formula: { expression: 'if(prop("Total") > 5, "big", "small")' } });
    expect((await s.api(alice.token, "POST", `/api/databases/${projects.id}/ops`, { op: "addProperty", name: "Bad", type: "formula", formula: { expression: "prop(" } })).status).toBe(400);
    expect((await s.api(alice.token, "PATCH", `/api/rows/${proj.id}`, { values: { total: 1 } })).status).toBe(400);
    const md = (await s.api(alice.token, "GET", `/api/pages/${page.id}/export`)).text;
    expect(md).toMatch(/\| First task \| [^|]* \| First task, Second task \| 8 \| big \|/);

    // Deleting one side turns the other into a one-way relation.
    await s.api(alice.token, "POST", `/api/databases/${projects.id}/ops`, { op: "deleteProperty", id: "tasks" });
    const after = (await s.api(alice.token, "GET", `/api/databases/${tasks.id}`)).body.database;
    expect(after.properties.schema[mirrorId].relation.syncedPropertyId).toBeNull();
  });
});
