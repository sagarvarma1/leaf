"use client";
/**
 * The browser end of Leaf's Notion-style sync.
 *
 *  - Records: one Replica holds the records the server confirmed plus the view the
 *    editors show (confirmed + this tab's pending transactions, rebased on every commit).
 *  - TransactionQueue: a local edit applies to the view at once, joins the queue (saved in
 *    IndexedDB, so it survives a reload or a crash while offline) and is sent with
 *    saveTransactions, oldest first, in batches, one request at a time.
 *  - RecordCache: the records and text instances of every page opened or kept for
 *    offline use live in IndexedDB; a page opens from there when the network is down.
 *  - Updates: the workspace WebSocket (store.ts) delivers commits for the documents this
 *    tab follows, and presence. After reconnecting, followed documents are reloaded
 *    (loadPageChunk) to catch up on anything missed.
 *  - Undo: each local edit records the inverse of its ops; undo commits them as a new
 *    edit. Text inverses only touch this user's own characters, so undo never reverts
 *    someone else's typing.
 */
import {
  Clock,
  commitDesired,
  MemoryState,
  Replica,
  stampInverse,
  TextInstance,
  toPM,
  type Block,
  type Commit,
  type Desired,
  type RecordOp,
  type TextInstanceJSON,
  type TextOp,
  type Transaction,
} from "@leaf/shared";
import { useEffect, useState, useSyncExternalStore } from "react";
import { api, ApiError } from "./api";
import { idbClear, idbDelete, idbGet, idbKeys, idbSet } from "./idb";

export interface Presence {
  session: string;
  user: { id: string; name: string; color: string } | null;
  /** Cursor: right after `item` of `block` (item null = start of the block). */
  sel: { block: string; item: string | null; head?: { block: string; item: string | null } } | null;
}

interface CachedDoc {
  records: Block[];
  instances: TextInstanceJSON[];
  docs: string[];
  savedAt: number;
}

interface StoredQueue {
  txs: Transaction[];
  /** The owning tab's last heartbeat. */
  at: number;
}

const QUEUE_HEARTBEAT_MS = 10_000;
const QUEUE_ORPHAN_MS = 30_000;

interface UndoEntry {
  inverse: RecordOp[];
  at: number;
}

const CAPTURE_MS = 500;
const uuid = () => globalThis.crypto.randomUUID();

/** The document a record belongs to: a page, or a synced block container. */
function docOf(b: Block): string | null {
  if (b.type === "page") return b.id;
  if (b.type === "synced_block" && !b.page_id) return b.id;
  return b.page_id;
}

export class SyncClient {
  readonly session = `c-${uuid().slice(0, 8)}`;
  readonly clock = new Clock(this.session);
  readonly replica: Replica;
  /** Documents open in editors (refcounted). */
  private open = new Map<string, number>();
  /** Documents kept for offline use: followed too, so their cache stays fresh. */
  private kept = new Set<string>();
  /** Documents whose records are in the replica (and the synced containers they embed). */
  private loaded = new Map<string, string[]>();
  private listeners = new Set<(origin: unknown) => void>();
  private presence = new Map<string, Map<string, Presence>>();
  private presenceListeners = new Set<() => void>();
  private mine = new Map<string, Presence["sel"]>();
  private undoStack = new Map<string, UndoEntry[]>();
  private redoStack = new Map<string, UndoEntry[]>();
  private sending = false;
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sender: ((msg: unknown) => void) | null = null;
  connected = false;
  /** Bumped on every change, for React. */
  version = 0;

  constructor(
    readonly userId: string | null,
    readonly workspaceId: string,
  ) {
    this.replica = new Replica(userId);
    void this.restoreQueue();
    if (typeof window !== "undefined") {
      (window as any).__leafSyncCount = ((window as any).__leafSyncCount ?? 0) + 1;
      // Back online: catch up and send the queue, even if the socket never dropped.
      window.addEventListener("online", () => void this.catchUp());
      (window as any).__leafSync = this;
      (window as any).__leafDocJSON = (id: string) => JSON.stringify(toPM(this.view, id, { title: this.view.getBlock(id)?.type === "page" }));
    }
  }

  /** For debugging and tests. */
  debug() {
    return { session: this.session, userId: this.userId, connected: this.connected, open: [...this.open.keys()], loaded: [...this.loaded.keys()], pending: this.pendingCount };
  }

  get view(): MemoryState {
    return this.replica.view;
  }

  get pendingCount() {
    return this.replica.pending.length;
  }

  // ------------------------------------------------------------ listeners

  onChange(fn: (origin: unknown) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(origin: unknown) {
    this.version++;
    for (const l of this.listeners) l(origin);
  }

  // ------------------------------------------------------------ documents

  /** Load a document (network first, then the offline cache) and follow it. */
  async openDoc(docId: string): Promise<{ fromCache: boolean }> {
    this.open.set(docId, (this.open.get(docId) ?? 0) + 1);
    this.resubscribe();
    if (this.loaded.has(docId)) return { fromCache: false };
    try {
      await this.fetchDoc(docId);
      return { fromCache: false };
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 0) throw e;
      const cached = await idbGet<CachedDoc>("records", this.cacheKey(docId));
      if (!cached) throw e;
      this.loadCached(docId, cached);
      return { fromCache: true };
    }
  }

  closeDoc(docId: string) {
    const n = (this.open.get(docId) ?? 1) - 1;
    if (n <= 0) this.open.delete(docId);
    else this.open.set(docId, n);
    this.resubscribe();
  }

  /** Download a document for offline use and keep following it. */
  async keepDoc(docId: string) {
    await this.fetchDoc(docId);
    this.kept.add(docId);
    this.resubscribe();
  }

  isLoaded(docId: string) {
    return this.loaded.has(docId);
  }

  private async fetchDoc(docId: string) {
    const r = await api<{ records: Block[]; instances: Array<{ id: string; ops: TextOp[] }>; docs: string[] }>("POST", "/api/loadPageChunk", { pageId: docId });
    this.replica.load(r.records, r.instances);
    this.loaded.set(docId, r.docs);
    for (const d of r.docs) if (!this.loaded.has(d)) this.loaded.set(d, [d]);
    this.resubscribe();
    this.notify("load");
    this.scheduleSave(docId, 0);
  }

  private loadCached(docId: string, cached: CachedDoc) {
    this.replica.load(
      cached.records,
      cached.instances.map((j) => ({ id: j.id, ops: TextInstance.fromJSON(j).ops() })),
    );
    this.loaded.set(docId, cached.docs);
    for (const d of cached.docs) if (!this.loaded.has(d)) this.loaded.set(d, [d]);
    this.notify("load");
  }

  private cacheKey(docId: string) {
    return `${this.userId ?? "guest"}:${docId}`;
  }

  /** Write a document's confirmed records and text to the RecordCache (debounced). */
  private scheduleSave(docId: string, delay = 800) {
    if (!this.userId) return; // share-link guests keep nothing
    const t = this.saveTimers.get(docId);
    if (t) clearTimeout(t);
    this.saveTimers.set(
      docId,
      setTimeout(() => {
        this.saveTimers.delete(docId);
        void this.saveDoc(docId);
      }, delay),
    );
  }

  private async saveDoc(docId: string) {
    const docs = this.loaded.get(docId) ?? [docId];
    const state = this.replica.confirmed;
    const records = new Map<string, Block>();
    for (const b of state.blocks.values()) {
      const d = docOf(b);
      if (b.id === docId || (d && docs.includes(d))) records.set(b.id, b);
    }
    for (const b of [...records.values()]) for (const c of b.content) if (!records.has(c) && state.getBlock(c)) records.set(c, state.getBlock(c)!);
    const instances = new Set<string>();
    for (const b of records.values()) for (const s of b.text ?? []) instances.add(s.i);
    const cached: CachedDoc = {
      records: [...records.values()],
      instances: [...instances].map((id) => state.instance(id).toJSON()),
      docs,
      savedAt: Date.now(),
    };
    await idbSet("records", this.cacheKey(docId), cached);
  }

  /** Follow every open, kept and embedded document on the WebSocket. */
  private resubscribe() {
    const docs = new Set<string>([...this.open.keys(), ...this.kept]);
    for (const d of [...docs]) for (const e of this.loaded.get(d) ?? []) docs.add(e);
    this.sender?.({ type: "sub", docs: [...docs] });
  }

  // ------------------------------------------------------------ the socket (store.ts)

  attach(send: ((msg: unknown) => void) | null) {
    this.sender = send;
    this.connected = !!send;
    if (send) {
      this.resubscribe();
      for (const [doc, sel] of this.mine) send({ type: "presence", doc, sel });
      void this.catchUp();
    } else {
      this.presence.clear();
      this.presenceListeners.forEach((l) => l());
    }
    this.notify("status");
  }

  /** Reload followed documents (whatever happened while disconnected), then send the queue. */
  private async catchUp() {
    await this.adoptOrphans();
    for (const d of [...this.open.keys(), ...this.kept]) {
      try {
        await this.fetchDoc(d);
      } catch {
        /* stays on the cached copy */
      }
    }
    await this.flush();
  }

  handleEvent(msg: any) {
    if (msg.type === "commit") {
      const c = msg.commit as Commit;
      this.replica.receive(c);
      this.afterCommit(c);
      this.notify("remote");
    } else if (msg.type === "presence") {
      let byDoc = this.presence.get(msg.doc);
      if (!byDoc) this.presence.set(msg.doc, (byDoc = new Map()));
      if (!msg.user) byDoc.delete(msg.session);
      else byDoc.set(msg.session, { session: msg.session, user: msg.user, sel: msg.sel });
      this.presenceListeners.forEach((l) => l());
    }
  }

  private afterCommit(c: Commit) {
    const docs = new Set<string>();
    for (const r of c.records) {
      const d = docOf(r);
      if (d) docs.add(d);
    }
    for (const [doc, embedded] of this.loaded) if (embedded.some((e) => docs.has(e))) this.scheduleSave(doc);
  }

  // ------------------------------------------------------------ local edits

  /**
   * Commit what an editor wants (see sync/commit.ts): ops are applied to the view as
   * they're made, queued as one transaction, and recorded for undo.
   */
  commitDesired(rootId: string, desired: Desired, origin: unknown): RecordOp[] {
    return this.edit(rootId, origin, (apply) => commitDesired(this.view, this.clock, desired, apply));
  }

  /** Run an edit against the view; queue it; remember its inverse for undo. */
  edit(rootId: string, origin: unknown, fn: (apply: (op: RecordOp) => void) => void, opts: { undoable?: boolean } = {}): RecordOp[] {
    const ops: RecordOp[] = [];
    const inverse: RecordOp[] = [];
    fn((op) => {
      const res = this.view.apply(op);
      ops.push(op);
      inverse.unshift(...res.inverse);
    });
    if (!ops.length) return ops;
    const tx: Transaction = { id: uuid(), ops };
    this.replica.local(tx);
    if (opts.undoable !== false) {
      const stack = this.undoStack.get(rootId) ?? [];
      const last = stack[stack.length - 1];
      if (last && Date.now() - last.at < CAPTURE_MS) {
        last.inverse = [...inverse, ...last.inverse];
        last.at = Date.now();
      } else stack.push({ inverse, at: Date.now() });
      this.undoStack.set(rootId, stack.slice(-200));
      this.redoStack.set(rootId, []);
    }
    void this.persistQueue();
    this.notify(origin);
    void this.flush();
    return ops;
  }

  canUndo(rootId: string) {
    return (this.undoStack.get(rootId)?.length ?? 0) > 0;
  }

  undo(rootId: string): boolean {
    return this.step(rootId, this.undoStack, this.redoStack);
  }

  redo(rootId: string): boolean {
    return this.step(rootId, this.redoStack, this.undoStack);
  }

  private step(rootId: string, from: Map<string, UndoEntry[]>, to: Map<string, UndoEntry[]>): boolean {
    const entry = from.get(rootId)?.pop();
    if (!entry) return false;
    const back: RecordOp[] = [];
    const ops: RecordOp[] = [];
    for (const op of stampInverse(this.view, this.clock, entry.inverse)) {
      try {
        const res = this.view.apply(op);
        ops.push(op);
        back.unshift(...res.inverse);
      } catch {
        /* the block is gone: skip */
      }
    }
    if (ops.length) {
      this.replica.local({ id: uuid(), ops });
      to.set(rootId, [...(to.get(rootId) ?? []), { inverse: back, at: 0 }]);
      void this.persistQueue();
      this.notify("undo");
      void this.flush();
    }
    return true;
  }

  // ------------------------------------------------------------ TransactionQueue

  /**
   * One queue per tab (session), with a heartbeat: two tabs of the same user never
   * overwrite each other's unsent edits. A tab that starts adopts the queues of tabs that
   * are gone (no heartbeat for 30 s), so edits from a tab closed while offline still go out.
   */
  private queuePrefix() {
    return `${this.userId ?? "guest"}:${this.workspaceId}:`;
  }

  private queueKey() {
    return this.queuePrefix() + this.session;
  }

  private async persistQueue() {
    if (!this.userId) return;
    await idbSet("queue", this.queueKey(), { txs: this.replica.pending, at: Date.now() } satisfies StoredQueue);
  }

  /** Transactions queued by earlier tabs (a reload, a crash, offline edits) come back and are sent. */
  private async restoreQueue() {
    if (!this.userId) return;
    // Liveness: a Web Lock held for as long as this tab lives (the browser releases it when
    // the tab closes or reloads); a heartbeat where locks aren't available.
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (locks) void locks.request(`leaf-queue:${this.session}`, () => new Promise<never>(() => {}));
    const heartbeat = setInterval(() => void this.persistQueue(), QUEUE_HEARTBEAT_MS);
    (heartbeat as any).unref?.();
    if (typeof window !== "undefined") window.addEventListener("pagehide", () => void idbSet("queue", this.queueKey(), { txs: this.replica.pending, at: 0 }));
    await this.persistQueue();
    await this.adoptOrphans();
  }

  /** Take over the queues of tabs that are gone (at startup, and on every reconnect). */
  private async adoptOrphans() {
    if (!this.userId) return;
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    const held = locks ? new Set(((await locks.query()).held ?? []).map((l) => l.name)) : null;
    const orphans: Transaction[] = [];
    const adopted: string[] = [];
    const legacy = `${this.userId}:${this.workspaceId}`; // before per-tab queues
    for (const key of await idbKeys("queue")) {
      if (key === this.queueKey() || (key !== legacy && !key.startsWith(this.queuePrefix()))) continue;
      const saved = await idbGet<StoredQueue | Transaction[]>("queue", key);
      const q: StoredQueue = Array.isArray(saved) ? { txs: saved, at: 0 } : (saved ?? { txs: [], at: 0 });
      // Is the tab that owns it still open?
      const session = key.slice(this.queuePrefix().length);
      if (held ? held.has(`leaf-queue:${session}`) : Date.now() - q.at < QUEUE_ORPHAN_MS) continue;
      orphans.push(...q.txs);
      adopted.push(key);
    }
    if (!orphans.length) {
      for (const key of adopted) await idbDelete("queue", key);
      return;
    }
    // Oldest first, ahead of anything queued since this tab started.
    const known = new Set(this.replica.pending.map((t) => t.id));
    this.replica.pending = [...orphans.filter((tx) => !known.has(tx.id)), ...this.replica.pending];
    this.replica.rebuild([]);
    await this.persistQueue();
    for (const key of adopted) await idbDelete("queue", key);
    this.notify("load");
    void this.flush();
  }

  /** Send queued transactions (all of them, in order, in one request), then the next batch. */
  async flush() {
    if (this.sending || !this.userId) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    this.sending = true;
    try {
      while (this.replica.pending.length) {
        const batch = this.replica.pending.slice(0, 100);
        let res: { commits: Commit[] };
        try {
          res = await api<{ commits: Commit[] }>("POST", "/api/saveTransactions", { transactions: batch, session: this.session });
        } catch (e) {
          if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
            console.warn(`[leaf] transactions refused (${e.status}): ${e.message}`);
            // Refused (permissions, bad op): drop the batch and reload from the server.
            for (const tx of batch) this.replica.reject(tx.id);
            for (const d of this.open.keys()) await this.fetchDoc(d).catch(() => {});
            this.notify("reject");
            continue;
          }
          break; // network: retry when back online / reconnected
        }
        for (const c of res.commits) {
          this.replica.receive(c);
          this.afterCommit(c);
        }
        await this.persistQueue();
        this.notify("ack");
      }
    } finally {
      this.sending = false;
    }
  }

  // ------------------------------------------------------------ presence

  /** My caret in a document (null: there, but no caret). Re-sent after reconnecting. */
  setPresence(doc: string, sel: Presence["sel"]) {
    this.mine.set(doc, sel);
    this.sender?.({ type: "presence", doc, sel });
  }

  leavePresence(doc: string) {
    if (!this.mine.delete(doc)) return;
    this.sender?.({ type: "presence", doc, leave: true });
  }

  presenceOf(doc: string): Presence[] {
    return [...(this.presence.get(doc)?.values() ?? [])];
  }

  onPresence(fn: () => void) {
    this.presenceListeners.add(fn);
    return () => this.presenceListeners.delete(fn);
  }
}

// ---------------------------------------------------------------- the tab's client

let client: SyncClient | null = null;

/** The sync client for the signed-in user and workspace (recreated when either changes). */
export function syncFor(userId: string | null, workspaceId: string): SyncClient {
  if (!client || client.userId !== userId || client.workspaceId !== workspaceId) client = new SyncClient(userId, workspaceId);
  return client;
}

export const currentSync = () => client;

/** Forget everything kept on this device (logout). */
export async function clearSyncData() {
  client = null;
  await idbClear();
}

// ---------------------------------------------------------------- React

export interface DocState {
  ready: boolean;
  /** Opened from the offline cache. */
  fromCache: boolean;
  /** Not available: offline and never downloaded, or no access. */
  error: string | null;
}

/** Open a document in the sync client for as long as the component is mounted. */
export function useDoc(sync: SyncClient | null, docId: string | null): DocState {
  const [state, setState] = useState<DocState>({ ready: false, fromCache: false, error: null });
  useEffect(() => {
    if (!sync || !docId) return;
    let alive = true;
    setState({ ready: sync.isLoaded(docId), fromCache: false, error: null });
    sync
      .openDoc(docId)
      .then((r) => alive && setState({ ready: true, fromCache: r.fromCache, error: null }))
      .catch((e) => alive && setState({ ready: false, fromCache: false, error: e instanceof ApiError && e.status === 0 ? "offline" : String(e?.message ?? "error") }));
    return () => {
      alive = false;
      sync.closeDoc(docId);
    };
  }, [sync, docId]);
  return state;
}

/** Re-render on every sync change (status, queue length). */
export function useSyncVersion(sync: SyncClient | null): number {
  return useSyncExternalStore(
    (l) => (sync ? sync.onChange(l) : () => {}),
    () => sync?.version ?? 0,
    () => 0,
  );
}

export function usePresence(sync: SyncClient | null, doc: string): Presence[] {
  const [list, setList] = useState<Presence[]>([]);
  useEffect(() => {
    if (!sync) return;
    const update = () => setList(sync.presenceOf(doc));
    update();
    const off = sync.onPresence(update);
    return () => void off();
  }, [sync, doc]);
  return list;
}
