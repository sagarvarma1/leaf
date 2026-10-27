/**
 * The two ends of the sync protocol.
 *
 *   commitTransaction()  server: apply a transaction's ops in order against the records of
 *                        truth, and report what changed (broadcast to every subscriber).
 *   Replica              client: the server-confirmed records, the queue of transactions
 *                        not yet confirmed, and the view the editor shows: confirmed
 *                        records with the pending transactions re-applied on top.
 *
 * Like Notion's TransactionQueue, pending transactions are kept (and persisted by the
 * app) until the server answers, then sent one at a time. Structure follows the server's
 * order: when someone else's change arrives, pending ops are rebased onto it, and an op
 * that no longer applies (its block was deleted meanwhile) is dropped. Text needs no
 * rebasing: text instances are CRDTs shared by the confirmed state and the view, and
 * every text op is applied exactly once whichever way it arrives.
 */
import type { Block } from "../types.js";
import { MemoryState } from "./memory.js";
import { applyOp, deriveText, OpError, type RecordOp, type SyncState, type Transaction } from "./records.js";
import type { TextOp } from "./text.js";

export interface Commit {
  /** The transaction this commit confirms. */
  tx: string;
  session: string;
  userId: string | null;
  /** Every record the transaction changed, as committed. */
  records: Block[];
  /** Text ops that took effect, per instance. */
  text: Array<{ instance: string; ops: TextOp[] }>;
  /** Ops skipped because they no longer applied. */
  skipped: number;
}

/** Apply a transaction to the records of truth. Validation hooks run before each op. */
export function commitTransaction(
  state: SyncState,
  tx: Transaction,
  meta: { session: string; userId: string | null },
  check: (op: RecordOp) => void = () => {},
): Commit {
  return commitOps(state, { ...meta, tx: tx.id }, (apply) => {
    for (const op of tx.ops) apply(op);
  }, check).commit;
}

/**
 * Run an edit against the records of truth: `gen` produces ops one at a time through
 * `apply` (so it can read the effect of earlier ones), and gets back each op's inverse.
 * Ops that no longer apply are skipped. Returns the commit and the inverse of the edit.
 */
export function commitOps(
  state: SyncState,
  meta: { session: string; userId: string | null; tx: string },
  gen: (apply: (op: RecordOp) => RecordOp[]) => void,
  check: (op: RecordOp) => void = () => {},
): { commit: Commit; ops: RecordOp[]; inverse: RecordOp[] } {
  const changed = new Set<string>();
  const textBlocks = new Set<string>();
  const text = new Map<string, TextOp[]>();
  const ops: RecordOp[] = [];
  const inverse: RecordOp[] = [];
  let skipped = 0;
  gen((op) => {
    check(op);
    try {
      const res = applyOp(state, op);
      res.changed.forEach((id) => changed.add(id));
      res.text.forEach((id) => textBlocks.add(id));
      // Broadcast what took effect (including earlier ops this one released), not just what arrived.
      if (op.op === "text" && res.textApplied?.length) text.set(op.instance, [...(text.get(op.instance) ?? []), ...res.textApplied]);
      ops.push(op);
      inverse.unshift(...res.inverse);
      return res.inverse;
    } catch (err) {
      if (!(err instanceof OpError)) throw err;
      skipped++;
      return [];
    }
  });
  // Derived text (rich_text / title) once per commit, not per op: ops read the instances.
  for (const id of textBlocks) {
    const b = state.getBlock(id);
    if (b) {
      const next = deriveText(state, b);
      if (next !== b) state.putBlock(next);
    }
    changed.add(id);
  }
  return {
    commit: {
      tx: meta.tx,
      session: meta.session,
      userId: meta.userId,
      records: [...changed].map((id) => state.getBlock(id)).filter((b): b is Block => !!b),
      text: [...text].map(([instance, ops]) => ({ instance, ops })),
      skipped,
    },
    ops,
    inverse,
  };
}

export class Replica {
  /** Records as the server confirmed them. Text instances are shared with the view. */
  readonly confirmed: MemoryState;
  /** What the editor shows. */
  view: MemoryState;
  /** Transactions not yet confirmed, oldest first. */
  pending: Transaction[] = [];

  constructor(userId: string | null) {
    this.confirmed = new MemoryState({ userId });
    this.view = this.confirmed.fork();
  }

  /** Queue a local transaction (its ops were already applied to the view as they were made). */
  local(tx: Transaction) {
    if (!tx.ops.length) return;
    this.pending.push(tx);
  }

  /**
   * Records fetched from the server (page load, catch-up after reconnecting): they replace
   * the confirmed copies; instances merge.
   */
  load(records: Block[], instances: Array<{ id: string; ops: TextOp[] }>) {
    for (const i of instances) this.confirmed.instance(i.id).apply(i.ops);
    for (const r of records) this.confirm(r);
    this.rebuild(records.map((r) => r.id));
  }

  /** Keep the newest version of a record (updates can arrive out of order). */
  private confirm(r: Block) {
    const cur = this.confirmed.getBlock(r.id);
    if (cur && (cur.version ?? 0) > (r.version ?? 0)) return;
    this.confirmed.putBlock(r);
  }

  /** A commit from the server (someone else's, or the confirmation of ours). */
  receive(c: Commit) {
    for (const t of c.text) this.confirmed.instance(t.instance).apply(t.ops);
    for (const r of c.records) this.confirm(r);
    this.pending = this.pending.filter((p) => p.id !== c.tx);
    this.rebuild(c.records.map((r) => r.id));
  }

  /** The server refused a transaction outright: forget it. */
  reject(txId: string) {
    this.pending = this.pending.filter((p) => p.id !== txId);
    this.rebuild([]);
  }

  /** View = confirmed + pending structure re-applied (text is already in the instances). */
  rebuild(touched: string[]) {
    const view = this.confirmed.fork();
    const derive = new Set<string>(touched);
    for (const tx of this.pending) {
      for (const op of tx.ops) {
        try {
          const res = view.apply(op);
          res.text.forEach((id) => derive.add(id));
        } catch (err) {
          if (!(err instanceof OpError)) throw err;
        }
        if (op.op === "text") for (const id of view.blocksOfInstance(op.instance)) derive.add(id);
      }
    }
    for (const id of derive) {
      const b = view.getBlock(id);
      if (b) {
        const next = deriveText(view, b);
        if (next !== b) view.putBlock(next);
      }
    }
    this.view = view;
  }
}
