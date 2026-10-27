/**
 * The server end of Leaf's Notion-style sync.
 *
 * Records of truth are rows of the `blocks` table; block text lives in text instances
 * (CRDTs) in `text_instances`. Every write, from an editor, a REST call, a version
 * restore or the AI, is a transaction of operations committed here:
 *
 *   1. In one SQLite transaction, check each op against the user's permissions and
 *      apply it (shared engine, packages/shared/src/sync). Ops that no longer apply
 *      (their block was deleted by someone else first) are skipped; a permission failure
 *      rejects the whole transaction.
 *   2. Persist the text instances that changed.
 *   3. Broadcast the commit (changed records + text ops) to every client subscribed to
 *      the affected documents, like Notion's MessageStore, and refresh search and
 *      version history for those documents.
 */
import {
  Clock,
  commitOps,
  TextInstance,
  TEXT_TYPES,
  setRichText,
  type Block,
  type Commit,
  type RecordOp,
  type SyncState,
  type TextInstanceJSON,
  type TextOp,
  type Transaction,
} from "@leaf/shared";
import { randomUUID } from "node:crypto";
import { tx, type DB } from "./db.js";
import { docOf, type Hub } from "./hub.js";
import { HttpError, type BlockStore } from "./store.js";

export interface SyncOptions {
  snapshotIntervalMs: number;
  indexDebounceMs: number;
}

export interface EditContext {
  state: SyncState;
  clock: Clock;
  /** Apply one op now; returns its inverse. */
  apply(op: RecordOp): RecordOp[];
}

export interface EditResult {
  commit: Commit;
  ops: RecordOp[];
  inverse: RecordOp[];
}

class DbState implements SyncState {
  constructor(
    private sync: SyncService,
    readonly userId: string | null,
  ) {}
  now() {
    return Date.now();
  }
  getBlock(id: string) {
    return this.sync.store.get(id);
  }
  putBlock(b: Block) {
    this.sync.store.put(b);
  }
  instance(id: string) {
    return this.sync.instance(id);
  }
  blocksOfInstance(id: string) {
    return this.sync.store.blocksOfInstance(id);
  }
  findContainer(id: string): string | null {
    const row = this.sync.db.prepare("SELECT id FROM blocks WHERE archived = 0 AND content LIKE ? LIMIT 1").get(`%"${id}"%`) as { id: string } | undefined;
    return row?.id ?? null;
  }
}

export class SyncService {
  /** The server's own session, for edits it makes (REST writes, renames, restores). */
  readonly session = `srv-${randomUUID().slice(0, 8)}`;
  readonly clock = new Clock(this.session);
  private instances = new Map<string, TextInstance>();
  private indexTimers = new Map<string, NodeJS.Timeout>();
  private changedSinceSnapshot = new Map<string, string | null>();

  constructor(
    readonly db: DB,
    readonly store: BlockStore,
    private hub: Hub,
    private opts: SyncOptions,
  ) {}

  // ------------------------------------------------------------ text instances

  instance(id: string): TextInstance {
    let t = this.instances.get(id);
    if (t) {
      // Keep recently used instances at the end (a simple LRU).
      this.instances.delete(id);
      this.instances.set(id, t);
      return t;
    }
    const row = this.db.prepare("SELECT state FROM text_instances WHERE id = ?").get(id) as { state: string } | undefined;
    t = row ? TextInstance.fromJSON(JSON.parse(row.state) as TextInstanceJSON) : new TextInstance(id);
    this.instances.set(id, t);
    if (this.instances.size > 20_000) this.instances.delete(this.instances.keys().next().value!);
    return t;
  }

  private persistInstances(ids: Iterable<string>) {
    const stmt = this.db.prepare(
      "INSERT INTO text_instances (id, state, updated_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at",
    );
    for (const id of ids) stmt.run(id, JSON.stringify(this.instance(id).toJSON()), Date.now());
  }

  // ------------------------------------------------------------ writing

  /**
   * Run an edit: `fn` produces ops through `ctx.apply` (each applied immediately, so it
   * can read their effect). Everything commits in one SQLite transaction, then publishes.
   */
  edit(userId: string | null, fn: (ctx: EditContext) => void, opts: { session?: string; check?: (op: RecordOp) => void; tx?: string; clock?: Clock } = {}): EditResult {
    const state = new DbState(this, userId);
    const clock = opts.clock ?? this.clock;
    const session = opts.session ?? clock.session;
    const result = tx(this.db, () => {
      const res = commitOps(state, { session, userId, tx: opts.tx ?? randomUUID() }, (apply) => fn({ state, clock, apply }), opts.check);
      this.persistInstances(res.commit.text.map((t) => t.instance));
      return res;
    });
    this.after(result.commit, userId);
    return result;
  }

  /** A transaction from a client, checked op by op with `canEdit`. */
  commit(userId: string, session: string, transaction: Transaction, canEdit: (b: Block) => boolean): Commit {
    if (!transaction || typeof transaction.id !== "string" || !Array.isArray(transaction.ops)) throw new HttpError(400, "Bad transaction");
    if (transaction.ops.length > 5000) throw new HttpError(413, "Transaction too large");
    const created = new Set<string>();
    const state = new DbState(this, userId);
    const need = (id: string | null | undefined) => {
      if (!id) throw new HttpError(400, "Bad op");
      const b = this.store.get(id);
      if (!b) return;
      if (!canEdit(b)) throw new HttpError(403, "You can't edit this page");
    };
    const check = (op: RecordOp) => {
      switch (op.op) {
        case "create": {
          const parent = this.store.get(op.parent);
          if (!parent) return; // skipped by the engine
          need(op.parent);
          if (op.type === "database") throw new HttpError(400, "Create databases with their own endpoint");
          if (this.store.get(op.id) && this.store.get(op.id)!.workspace_id !== parent.workspace_id) throw new HttpError(403, "Block belongs elsewhere");
          created.add(op.id);
          return;
        }
        case "update": {
          need(op.id);
          const b = this.store.get(op.id);
          if (b && (b.type === "page" || b.type === "database") && (op.type || op.properties)) {
            const allowed = new Set(["icon", "cover", "fullWidth"]);
            if (op.type || b.type === "database" || Object.keys(op.properties ?? {}).some((k) => !allowed.has(k))) throw new HttpError(400, "Use the page and database endpoints for that");
          }
          if (op.type === "page" || op.type === "database") throw new HttpError(400, "Can't turn a block into a page here");
          return;
        }
        case "move":
        case "restore": {
          need(op.id);
          need(op.parent);
          const b = this.store.get(op.id);
          const p = this.store.get(op.parent);
          if (b && p && b.workspace_id !== p.workspace_id) throw new HttpError(400, "Blocks stay in their workspace");
          return;
        }
        case "delete":
          return need(op.id);
        case "text": {
          const holders = state.blocksOfInstance(op.instance);
          if (holders.length) for (const id of holders) need(id);
          else if (!created.has(op.instance)) need(op.instance);
          return;
        }
        case "split":
          need(op.id);
          created.add(op.newId);
          return;
        case "merge":
          need(op.into);
          need(op.from);
          return;
        default:
          throw new HttpError(400, "Unknown op");
      }
    };
    return this.edit(
      userId,
      ({ apply }) => {
        for (const op of transaction.ops) apply(op);
      },
      { session, check, tx: transaction.id },
    ).commit;
  }

  /** Broadcast, re-index and maybe snapshot the documents a commit touched. */
  private after(commit: Commit, userId: string | null) {
    const docs = new Set<string>();
    let workspaceId: string | null = null;
    for (const r of commit.records) {
      workspaceId ??= r.workspace_id;
      const d = docOf(r);
      if (d) docs.add(d);
    }
    for (const t of commit.text) {
      for (const id of this.store.blocksOfInstance(t.instance)) {
        const b = this.store.get(id);
        if (!b) continue;
        workspaceId ??= b.workspace_id;
        const d = docOf(b);
        if (d) docs.add(d);
      }
    }
    if (!workspaceId) return;
    this.hub.publishCommit(workspaceId, commit, docs);
    // Pages and databases also update every member's sidebar / workspace cache.
    const structural = commit.records.filter((r) => r.type === "page" || r.type === "database");
    if (structural.length) this.hub.publishBlocks(workspaceId, structural);
    for (const d of docs) {
      this.scheduleIndex(d);
      this.changedSinceSnapshot.set(d, userId);
      this.maybeSnapshot(d);
    }
  }

  // ------------------------------------------------------------ reading

  /**
   * Everything a client needs to render a document: its records (page, content blocks,
   * child pages / databases it shows, synced containers it embeds and their content) and
   * the text instances they use.
   */
  docRecords(docId: string): { records: Block[]; instances: Array<{ id: string; ops: TextOp[] }>; docs: string[] } {
    const root = this.store.get(docId);
    if (!root) throw new HttpError(404, "Not found");
    const records = new Map<string, Block>([[root.id, root]]);
    const docs = [docId];
    const addDoc = (id: string) => {
      for (const b of this.store.contentOf(id)) records.set(b.id, b);
    };
    addDoc(docId);
    for (const b of [...records.values()]) {
      for (const c of b.content) if (!records.has(c)) {
        const ref = this.store.get(c);
        if (ref) records.set(c, ref);
      }
      if (b.type === "synced_block" && b.properties.synced_from && !docs.includes(b.properties.synced_from)) {
        const container = this.store.get(b.properties.synced_from);
        if (container && container.workspace_id === root.workspace_id) {
          docs.push(container.id);
          records.set(container.id, container);
          addDoc(container.id);
        }
      }
    }
    const instances = new Set<string>();
    for (const b of records.values()) for (const s of b.text ?? []) instances.add(s.i);
    return {
      records: [...records.values()],
      instances: [...instances].map((id) => ({ id, ops: this.instance(id).ops() })),
      docs,
    };
  }

  // ------------------------------------------------------------ search index

  private scheduleIndex(docId: string) {
    const t = this.indexTimers.get(docId);
    if (t) clearTimeout(t);
    this.indexTimers.set(
      docId,
      setTimeout(() => this.index(docId), this.opts.indexDebounceMs),
    );
  }

  /** Re-index a document's text for search (synced block text is indexed under its container). */
  index(docId: string) {
    const t = this.indexTimers.get(docId);
    if (t) clearTimeout(t);
    this.indexTimers.delete(docId);
    const doc = this.store.get(docId);
    if (!doc) return;
    const body = this.store
      .contentOf(docId)
      .map((b) => (b.properties.rich_text ?? []).map((r: { text: string }) => r.text).join("") || b.properties.caption || "")
      .filter(Boolean)
      .join("\n");
    tx(this.db, () => {
      this.db.prepare("DELETE FROM page_search WHERE page_id = ?").run(docId);
      this.db
        .prepare("INSERT INTO page_search (page_id, workspace_id, title, body) VALUES (?,?,?,?)")
        .run(docId, doc.workspace_id, doc.type === "page" ? (doc.properties.title ?? "") : "", body);
    });
  }

  /** Run pending index updates now (tests, shutdown). */
  flush() {
    for (const id of [...this.indexTimers.keys()]) this.index(id);
  }

  // ------------------------------------------------------------ version history

  private maybeSnapshot(docId: string) {
    const doc = this.store.get(docId);
    if (doc?.type !== "page") return;
    const last = this.db.prepare("SELECT MAX(created_at) AS t FROM snapshots WHERE page_id = ?").get(docId) as { t: number | null };
    if (!last.t || Date.now() - last.t >= this.opts.snapshotIntervalMs) this.snapshot(docId, this.changedSinceSnapshot.get(docId) ?? null, null);
  }

  snapshot(pageId: string, userId: string | null, label: string | null): string {
    const page = this.store.require(pageId, "page");
    const { records, instances } = this.docRecords(pageId);
    const state = {
      records: records.filter((r) => r.id === pageId || r.page_id === pageId),
      instances: instances.map((i) => this.instance(i.id).toJSON()),
    };
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO snapshots (id, page_id, state, title, label, created_by, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, pageId, JSON.stringify(state), page.properties.title ?? "", label, userId, Date.now());
    this.changedSinceSnapshot.delete(pageId);
    this.hub.publish(page.workspace_id, { type: "versions", pageId });
    return id;
  }

  /** Remove a document's derived data (permanent delete). */
  drop(docId: string) {
    this.db.prepare("DELETE FROM snapshots WHERE page_id = ?").run(docId);
    this.db.prepare("DELETE FROM page_search WHERE page_id = ?").run(docId);
    const t = this.indexTimers.get(docId);
    if (t) clearTimeout(t);
    this.indexTimers.delete(docId);
  }

  close() {
    this.flush();
  }

  // ------------------------------------------------------------ migration

  /**
   * Blocks written before text instances existed (or by the old Yjs sync) get their own
   * instance, filled from their stored rich text / title. Runs once at startup, like
   * Notion migrating pages to its CRDT model.
   */
  migrateText(): number {
    const rows = this.db
      .prepare(`SELECT id FROM blocks WHERE text IS NULL AND archived = 0 AND type IN (${[...TEXT_TYPES].map(() => "?").join(",")})`)
      .all(...TEXT_TYPES) as Array<{ id: string }>;
    if (!rows.length) return 0;
    const clock = new Clock("migrate");
    this.edit(null, ({ state, apply }) => {
      for (const { id } of rows) {
        const b = state.getBlock(id)!;
        apply({ op: "update", id, text: [{ i: id, from: null, to: null }] });
        const runs = b.type === "page" ? (b.properties.title ? [{ text: String(b.properties.title) }] : []) : b.properties.rich_text;
        setRichText(state, clock, id, runs, (op) => void apply(op));
      }
    }, { clock, session: "migrate" });
    return rows.length;
  }
}
