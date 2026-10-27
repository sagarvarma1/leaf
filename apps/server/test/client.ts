/**
 * A sync client for tests, doing what the browser does: load a document's records over
 * HTTP, follow its commits over the WebSocket, make edits against the local view, queue
 * them as transactions and send them one at a time, go offline and catch up.
 */
import { Clock, docBlocks, readText, Replica, toPM, unitsText, type Commit, type MemoryState, type RecordOp, type Transaction } from "@leaf/shared";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { TestServer } from "./helpers.js";

export class NetClient {
  readonly session = `t-${randomUUID().slice(0, 8)}`;
  readonly clock = new Clock(this.session);
  replica: Replica;
  online = true;
  presence = new Map<string, { user: any; sel: any }>();
  private ws: WebSocket | null = null;
  private sending = false;
  private seq = 0;

  constructor(
    private s: TestServer,
    private token: string,
    private workspaceId: string,
    readonly docId: string,
    userId: string,
  ) {
    this.replica = new Replica(userId);
  }

  get view(): MemoryState {
    return this.replica.view;
  }

  async open() {
    await this.load();
    await this.connect();
    return this;
  }

  /** Fetch the document's records and text (page load, or catch-up after being offline). */
  async load() {
    const r = await this.s.api(this.token, "POST", "/api/loadPageChunk", { pageId: this.docId });
    if (r.status !== 200) throw new Error(`load failed: ${r.text}`);
    this.replica.load(r.body.records, r.body.instances);
    return r.body.docs as string[];
  }

  private connect() {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${this.s.wsUrl}/ws/events?workspace=${this.workspaceId}&token=${this.token}&session=${this.session}`);
      this.ws = ws;
      ws.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        if (m.type === "hello") {
          ws.send(JSON.stringify({ type: "sub", docs: [this.docId] }));
          resolve();
        } else if (m.type === "commit") this.replica.receive(m.commit as Commit);
        else if (m.type === "presence") {
          if (m.sel === null && !m.user) this.presence.delete(m.session);
          else this.presence.set(m.session, { user: m.user, sel: m.sel });
        }
      });
      ws.on("error", reject);
    });
  }

  /** Make ops against the view (applied as made) and queue them as one transaction. */
  edit(make: (view: MemoryState, apply: (op: RecordOp) => void) => void): Transaction {
    const ops: RecordOp[] = [];
    make(this.view, (op) => {
      this.view.apply(op);
      ops.push(op);
    });
    const tx: Transaction = { id: `${this.session}-${++this.seq}`, ops };
    this.replica.local(tx);
    return tx;
  }

  /** Send queued transactions in order, each after the previous one is confirmed. */
  async flush() {
    if (!this.online || this.sending) return;
    this.sending = true;
    try {
      while (this.online && this.replica.pending.length) {
        const tx = this.replica.pending[0]!;
        const r = await this.s.api(this.token, "POST", "/api/saveTransactions", { transactions: [tx], session: this.session });
        if (r.status === 200) this.replica.receive(r.body.commit);
        else if (r.status >= 400 && r.status < 500) {
          this.replica.reject(tx.id);
          throw new Error(`tx rejected ${r.status}: ${r.text}`);
        }
      }
    } finally {
      this.sending = false;
    }
  }

  setPresence(sel: unknown) {
    this.ws?.send(JSON.stringify({ type: "presence", doc: this.docId, sel }));
  }

  goOffline() {
    this.online = false;
    this.ws?.close();
    this.ws = null;
  }

  async goOnline() {
    this.online = true;
    await this.load();
    await this.connect();
    await this.flush();
  }

  close() {
    this.ws?.close();
  }

  // ---------------------------------------------------------------- reading

  blocks() {
    return docBlocks(this.view, this.docId);
  }
  text(id: string) {
    return unitsText(readText(this.view, this.view.getBlock(id)!).units);
  }
  texts() {
    return this.blocks()
      .filter((b) => b.text)
      .map((b) => this.text(b.id));
  }
  json() {
    return JSON.stringify(toPM(this.view, this.docId, { title: true }));
  }
}
