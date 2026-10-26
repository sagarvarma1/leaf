import { appendBlocks, getFragment, projectFragment } from "@leaf/shared";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Leaf } from "../src/app.js";

const dirs: string[] = [];
const fresh = (opts: Partial<ConstructorParameters<typeof Leaf>[0]> = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leaf-docs-"));
  dirs.push(dir);
  const dbFile = path.join(dir, "leaf.db");
  return { dbFile, leaf: new Leaf({ dbFile, persistDebounceMs: 10_000, projectDebounceMs: 10_000, ...opts }) };
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(leaf: Leaf) {
  const u = leaf.signup("t@t.dev", "T", "secret1");
  const ws = leaf.createWorkspace("W", u.id);
  return { u, ws };
}

describe("DocManager persistence and projection", () => {
  it("every update is durable before compaction (crash safety via the update log)", () => {
    const { leaf, dbFile } = fresh();
    const { u, ws } = setup(leaf);
    const page = leaf.createPage({ workspaceId: ws, userId: u.id, title: "Durable" });
    leaf.docs.persist(page.id); // compact once
    const live = leaf.docs.get(page.id);
    live.doc.transact(() => appendBlocks(getFragment(live.doc), [{ id: "late", type: "paragraph", properties: { rich_text: [{ text: "not compacted yet" }] } }]));
    const pending = leaf.db.prepare("SELECT COUNT(*) AS n FROM yupdates WHERE doc_id = ?").get(page.id) as { n: number };
    expect(pending.n).toBeGreaterThan(0);
    // "Crash": open the same database from a second process-like instance without closing the first.
    const other = new Leaf({ dbFile });
    expect(getFragment(other.docs.get(page.id).doc).toString()).toContain("not compacted yet");
    other.db.close();
    leaf.close();
  });

  it("compaction folds the log into one state row", () => {
    const { leaf } = fresh();
    const { u, ws } = setup(leaf);
    const page = leaf.createPage({ workspaceId: ws, userId: u.id, title: "Compact" });
    for (let i = 0; i < 20; i++) leaf.docs.mutate(page.id, u.id, (f) => appendBlocks(f, [{ type: "paragraph", properties: { rich_text: [{ text: `p${i}` }] } }]));
    leaf.docs.persist(page.id);
    expect((leaf.db.prepare("SELECT COUNT(*) AS n FROM yupdates WHERE doc_id = ?").get(page.id) as any).n).toBe(0);
    const row = leaf.db.prepare("SELECT state FROM ydocs WHERE doc_id = ?").get(page.id) as { state: Uint8Array };
    const d = new Y.Doc();
    Y.applyUpdate(d, row.state);
    expect(projectFragment(getFragment(d), page.id).blocks.filter((b) => b.type === "paragraph")).toHaveLength(21);
    leaf.close();
  });

  it("re-keys block ids copied from another page (paste across pages)", () => {
    const { leaf } = fresh();
    const { u, ws } = setup(leaf);
    const a = leaf.createPage({ workspaceId: ws, userId: u.id, title: "A", content: [{ id: "shared-id", type: "paragraph", properties: { rich_text: [{ text: "in A" }] } }] });
    const b = leaf.createPage({ workspaceId: ws, userId: u.id, title: "B" });
    leaf.docs.mutate(b.id, u.id, (f) => appendBlocks(f, [{ id: "shared-id", type: "paragraph", properties: { rich_text: [{ text: "pasted into B" }] } }]));
    expect(leaf.store.get("shared-id")!.page_id).toBe(a.id);
    expect(leaf.store.get("shared-id")!.properties.rich_text[0].text).toBe("in A");
    const bBlocks = leaf.store.contentOf(b.id);
    const pasted = bBlocks.find((x) => x.properties.rich_text?.[0]?.text === "pasted into B")!;
    expect(pasted.id).not.toBe("shared-id");
    leaf.close();
  });

  it("hydrates a document from the block table when no Yjs state exists", () => {
    const { leaf } = fresh();
    const { u, ws } = setup(leaf);
    const page = leaf.createPage({ workspaceId: ws, userId: u.id, title: "Hydrate", content: [{ type: "to_do", properties: { rich_text: [{ text: "from blocks" }], checked: true } }] });
    leaf.docs.unload(page.id);
    leaf.db.prepare("DELETE FROM ydocs WHERE doc_id = ?").run(page.id);
    leaf.db.prepare("DELETE FROM yupdates WHERE doc_id = ?").run(page.id);
    const xml = getFragment(leaf.docs.get(page.id).doc).toString();
    expect(xml).toContain("from blocks");
    expect(xml).toContain('checked="true"');
    leaf.close();
  });

  it("takes automatic snapshots at most once per interval", () => {
    const { leaf } = fresh({ snapshotIntervalMs: 60_000 });
    const { u, ws } = setup(leaf);
    const page = leaf.createPage({ workspaceId: ws, userId: u.id, title: "Snap" });
    leaf.docs.persist(page.id);
    leaf.docs.mutate(page.id, u.id, (f) => appendBlocks(f, [{ type: "paragraph" }]));
    leaf.docs.persist(page.id);
    expect(leaf.versions(page.id)).toHaveLength(1);
    leaf.close();
  });
});
