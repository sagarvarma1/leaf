/**
 * DocManager: owns the in-memory Yjs document of every open page.
 *
 *  - Loads a page's document from SQLite (compacted state + update log), or hydrates it
 *    from the block table the first time.
 *  - Appends every incoming update to the `yupdates` log immediately (durability) and
 *    compacts into `ydocs` on a debounce.
 *  - Projects the document into the `blocks` table on a short debounce, so the block
 *    model stays queryable (REST, search, export, backlinks) while users type.
 *  - Applies server-originated edits (rename, add sub-page link, REST block writes,
 *    version restore) as ordinary Yjs transactions, so connected editors receive them
 *    like any collaborator's change.
 *
 * Two kinds of block own a document: pages, and synced block containers (a synced
 * block's content is one document embedded in every page that references it).
 */
import {
  collectBlockIds,
  ensureBlockIds,
  getFragment,
  hydrateFragment,
  projectFragment,
  type Block,
  type BlockInput,
  type Projection,
} from "@leaf/shared";
import { randomUUID } from "node:crypto";
import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";
import { tx, type DB } from "./db.js";
import type { Hub } from "./hub.js";
import { BlockStore, HttpError } from "./store.js";

export interface ConnInfo {
  userId: string | null;
  readOnly: boolean;
  awarenessIds: Set<number>;
  send(data: Uint8Array): void;
}

export interface Origin {
  server?: boolean;
  userId?: string | null;
  conn?: ConnInfo;
}

export class LiveDoc {
  readonly doc = new Y.Doc();
  readonly awareness: awarenessProtocol.Awareness;
  readonly conns = new Set<ConnInfo>();
  lastEditor: string | null = null;
  persistTimer: NodeJS.Timeout | null = null;
  projectTimer: NodeJS.Timeout | null = null;
  unloadTimer: NodeJS.Timeout | null = null;
  dirty = false;
  changedSinceSnapshot = false;
  /** Server-side work (an AI run) holding the doc in memory without a socket. */
  holds = 0;
  constructor(
    readonly pageId: string,
    readonly workspaceId: string,
  ) {
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null); // the server itself has no presence
  }
}

export interface DocOptions {
  persistDebounceMs: number;
  projectDebounceMs: number;
  snapshotIntervalMs: number;
  unloadAfterMs: number;
}

export class DocManager {
  readonly docs = new Map<string, LiveDoc>();
  /** Listeners for doc updates (the websocket layer broadcasts with this). */
  onUpdate: (live: LiveDoc, update: Uint8Array, origin: unknown) => void = () => {};

  constructor(
    private db: DB,
    private store: BlockStore,
    private hub: Hub,
    private opts: DocOptions,
  ) {}

  get(pageId: string): LiveDoc {
    const existing = this.docs.get(pageId);
    if (existing) return existing;
    const page = this.store.require(pageId, ["page", "synced_block"]);
    if (page.page_id) throw new HttpError(400, "not a synced block container");
    const live = new LiveDoc(pageId, page.workspace_id);
    const row = this.db.prepare("SELECT state FROM ydocs WHERE doc_id = ?").get(pageId) as { state: Uint8Array } | undefined;
    if (row) Y.applyUpdate(live.doc, row.state);
    for (const u of this.db.prepare("SELECT update_blob FROM yupdates WHERE doc_id = ? ORDER BY seq").all(pageId) as Array<{
      update_blob: Uint8Array;
    }>) {
      Y.applyUpdate(live.doc, u.update_blob);
    }
    live.doc.on("update", (update: Uint8Array, origin: unknown) => this.handleUpdate(live, update, origin));
    this.docs.set(pageId, live);
    if (getFragment(live.doc).length === 0) {
      // First open: build the document from the block table (seeded / API-created content).
      hydrateFragment(getFragment(live.doc), page.type === "page" ? (page.properties.title ?? "") : null, this.blockInputs(page));
      this.project(pageId);
    }
    return live;
  }

  private handleUpdate(live: LiveDoc, update: Uint8Array, origin: unknown) {
    this.db
      .prepare("INSERT INTO yupdates (doc_id, update_blob, created_at) VALUES (?,?,?)")
      .run(live.pageId, update, Date.now());
    const o = (origin ?? {}) as Origin;
    if (o.userId) live.lastEditor = o.userId;
    else if (o.conn?.userId) live.lastEditor = o.conn.userId;
    live.dirty = true;
    live.changedSinceSnapshot = true;
    this.onUpdate(live, update, origin);
    if (!live.persistTimer) live.persistTimer = setTimeout(() => this.persist(live.pageId), this.opts.persistDebounceMs);
    if (live.projectTimer) clearTimeout(live.projectTimer);
    live.projectTimer = setTimeout(() => this.project(live.pageId), this.opts.projectDebounceMs);
  }

  /** Tree of BlockInput for hydration, read from the projected block table. */
  private blockInputs(page: Block): BlockInput[] {
    const map = new Map(this.store.contentOf(page.id).map((b) => [b.id, b]));
    const build = (ids: string[]): BlockInput[] =>
      ids.flatMap((id): BlockInput[] => {
        const b = map.get(id) ?? this.store.get(id);
        if (!b) return [];
        if (b.type === "page") return [{ id, type: b.parent_id === page.id ? "child_page" : "link_to_page", properties: { page_id: id } }];
        if (b.type === "database") return [{ id, type: "child_database" }];
        return [{ id, type: b.type, properties: b.properties, children: build(b.content) }];
      });
    return build(page.content);
  }

  /** Apply a server-side edit as a Yjs transaction, then project synchronously. */
  mutate(pageId: string, userId: string | null, fn: (frag: Y.XmlFragment, doc: Y.Doc) => void): Projection | null {
    const live = this.get(pageId);
    live.doc.transact(() => fn(getFragment(live.doc), live.doc), { server: true, userId } satisfies Origin);
    return this.project(pageId);
  }

  /** Project a page's document into the block table. */
  project(pageId: string): Projection | null {
    const live = this.docs.get(pageId);
    if (!live) return null;
    if (live.projectTimer) {
      clearTimeout(live.projectTimer);
      live.projectTimer = null;
    }
    const page = this.store.get(pageId);
    if (!page) return null;
    const isPage = page.type === "page";
    const frag = getFragment(live.doc);

    // 1. Make block ids unique and owned by this page (re-key copies pasted from elsewhere).
    const ids = collectBlockIds(frag);
    const foreign = new Set<string>();
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const rows = this.db
        .prepare(`SELECT id FROM blocks WHERE id IN (${chunk.map(() => "?").join(",")}) AND (page_id IS NULL OR page_id != ?)`)
        .all(...chunk, pageId) as Array<{ id: string }>;
      for (const r of rows) foreign.add(r.id);
    }
    live.doc.transact(() => ensureBlockIds(frag, (id) => foreign.has(id)), { server: true } satisfies Origin);

    // 2. Project.
    const proj = projectFragment(frag, pageId, {
      isChildPage: (id) => {
        const b = this.store.get(id);
        return b?.type === "page" && b.parent_id === pageId;
      },
    });
    const now = Date.now();
    const editor = live.lastEditor;
    const changedStructure: Block[] = [];

    tx(this.db, () => {
      const existing = new Map(this.store.contentOf(pageId).map((b) => [b.id, b]));
      const prevRefs = new Set<string>(page.content);
      for (const b of existing.values()) for (const c of b.content) prevRefs.add(c);

      for (const b of proj.blocks) {
        const old = existing.get(b.id);
        if (!old) {
          this.store.insert({
            ...b,
            workspace_id: page.workspace_id,
            page_id: pageId,
            created_by: editor,
            created_at: now,
            last_edited_by: editor,
            last_edited_at: now,
            archived: false,
          });
        } else {
          existing.delete(b.id);
          const same =
            old.type === b.type &&
            old.parent_id === b.parent_id &&
            JSON.stringify(old.properties) === JSON.stringify(b.properties) &&
            JSON.stringify(old.content) === JSON.stringify(b.content);
          if (!same) {
            this.db
              .prepare("UPDATE blocks SET type=?, parent_id=?, properties=?, content=?, last_edited_by=?, last_edited_at=? WHERE id=?")
              .run(b.type, b.parent_id, JSON.stringify(b.properties), JSON.stringify(b.content), editor, now, b.id);
          }
        }
      }
      this.store.delete([...existing.keys()]);

      // The page block itself: title + ordered top-level content.
      const titleChanged = isPage && (page.properties.title ?? "") !== proj.title;
      const contentChanged = JSON.stringify(page.content) !== JSON.stringify(proj.content);
      if (titleChanged || contentChanged || live.dirty) {
        this.store.update(pageId, {
          properties: isPage ? { ...page.properties, title: proj.title } : page.properties,
          content: proj.content,
          last_edited_by: editor ?? page.last_edited_by,
          last_edited_at: live.dirty ? now : page.last_edited_at,
        });
        if (titleChanged || contentChanged) changedStructure.push(this.store.get(pageId)!);
      }
      live.dirty = false;

      // Removing a sub-page / database block from the document moves it to the trash
      // (as in Notion); undoing the removal brings it back.
      const nowRefs = new Set([...proj.childPages, ...proj.databases]);
      for (const id of prevRefs) {
        if (nowRefs.has(id)) continue;
        const b = this.store.get(id);
        if (b && (b.type === "page" || b.type === "database") && b.parent_id === pageId && !b.archived) {
          this.store.update(id, { archived: true });
          changedStructure.push(this.store.get(id)!);
        }
      }
      for (const id of nowRefs) {
        const b = this.store.get(id);
        if (b && b.archived && b.parent_id === pageId) {
          this.store.update(id, { archived: false });
          changedStructure.push(this.store.get(id)!);
        }
      }

      // Synced block text is indexed under the container; search maps it back to pages.
      this.db.prepare("DELETE FROM page_search WHERE page_id = ?").run(pageId);
      this.db
        .prepare("INSERT INTO page_search (page_id, workspace_id, title, body) VALUES (?,?,?,?)")
        .run(pageId, page.workspace_id, isPage ? proj.title : "", proj.text);
    });

    if (changedStructure.length) this.hub.publishBlocks(page.workspace_id, changedStructure);
    return proj;
  }

  /** Compact the update log into a single state row. Also takes periodic snapshots. */
  persist(pageId: string) {
    const live = this.docs.get(pageId);
    if (!live) return;
    if (live.persistTimer) {
      clearTimeout(live.persistTimer);
      live.persistTimer = null;
    }
    const state = Y.encodeStateAsUpdate(live.doc);
    const now = Date.now();
    tx(this.db, () => {
      this.db
        .prepare("INSERT INTO ydocs (doc_id, state, updated_at) VALUES (?,?,?) ON CONFLICT(doc_id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at")
        .run(pageId, state, now);
      this.db.prepare("DELETE FROM yupdates WHERE doc_id = ?").run(pageId);
    });
    if (live.changedSinceSnapshot && this.store.get(pageId)?.type === "page") {
      const last = this.db.prepare("SELECT MAX(created_at) AS t FROM snapshots WHERE page_id = ?").get(pageId) as { t: number | null };
      if (!last.t || now - last.t >= this.opts.snapshotIntervalMs) {
        this.snapshot(pageId, live.lastEditor, null);
      }
    }
  }

  snapshot(pageId: string, userId: string | null, label: string | null): string {
    const live = this.get(pageId);
    const id = randomUUID();
    const proj = projectFragment(getFragment(live.doc), pageId);
    this.db
      .prepare("INSERT INTO snapshots (id, page_id, state, title, label, created_by, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, pageId, Y.encodeStateAsUpdate(live.doc), proj.title, label, userId, Date.now());
    live.changedSinceSnapshot = false;
    this.hub.publish(live.workspaceId, { type: "versions", pageId });
    return id;
  }

  /** Called by the websocket layer when the last client leaves a document. */
  scheduleUnload(pageId: string) {
    const live = this.docs.get(pageId);
    if (!live) return;
    if (live.unloadTimer) clearTimeout(live.unloadTimer);
    live.unloadTimer = setTimeout(() => {
      if (live.conns.size || live.holds) return;
      this.unload(pageId);
    }, this.opts.unloadAfterMs);
  }

  /** Keep a page's doc loaded while server-side work edits it. */
  hold(pageId: string): LiveDoc {
    const live = this.get(pageId);
    live.holds++;
    return live;
  }

  release(pageId: string) {
    const live = this.docs.get(pageId);
    if (!live) return;
    live.holds = Math.max(0, live.holds - 1);
    this.project(pageId);
    if (!live.holds && !live.conns.size) this.scheduleUnload(pageId);
  }

  unload(pageId: string) {
    const live = this.docs.get(pageId);
    if (!live) return;
    this.project(pageId);
    this.persist(pageId);
    if (live.unloadTimer) clearTimeout(live.unloadTimer);
    live.awareness.destroy();
    live.doc.destroy();
    this.docs.delete(pageId);
  }

  /** Remove a page's document entirely (permanent delete). */
  drop(pageId: string) {
    const live = this.docs.get(pageId);
    if (live) {
      for (const t of [live.persistTimer, live.projectTimer, live.unloadTimer]) if (t) clearTimeout(t);
      live.doc.destroy();
      this.docs.delete(pageId);
    }
    this.db.prepare("DELETE FROM ydocs WHERE doc_id = ?").run(pageId);
    this.db.prepare("DELETE FROM yupdates WHERE doc_id = ?").run(pageId);
    this.db.prepare("DELETE FROM snapshots WHERE page_id = ?").run(pageId);
    this.db.prepare("DELETE FROM page_search WHERE page_id = ?").run(pageId);
  }

  /** Project + persist everything now (tests, shutdown). */
  flushAll() {
    for (const id of [...this.docs.keys()]) {
      this.project(id);
      this.persist(id);
    }
  }

  close() {
    for (const id of [...this.docs.keys()]) this.unload(id);
  }

  requireEditable(conn: ConnInfo) {
    if (conn.readOnly) throw new HttpError(403, "read only");
  }
}
