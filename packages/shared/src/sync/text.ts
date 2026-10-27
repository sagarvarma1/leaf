/**
 * Leaf's text CRDT, modeled on the one Notion describes in "How Notion handles concurrent
 * editing with CRDTs" (an RGA with Peritext-style formatting), with the Fugue fix for
 * interleaving (Weidner & Kleppmann, "The Art of the Fugue", 2023).
 *
 * Characters.
 *   Every character (or inline atom, like a mention) ever inserted is an item with a
 *   permanent id `session@clock`: the session that typed it and a Lamport clock. Items
 *   form a tree and the text is the tree read in order. A new item is the *right child*
 *   of the item before the cursor, unless that item already has right children; then it
 *   is the *left child* of the item after the cursor. Siblings are ordered newest first
 *   (higher clock, then higher session): Notion's rule. Every replica builds the same
 *   tree whatever order inserts arrive in, so everyone reads the same text.
 *
 *   Plain RGA puts every insert after its left neighbour. Two people typing *backwards*
 *   at the same spot (each new letter before the last) then produce sibling chains that
 *   interleave letter by letter. With left children, each person's backwards run chains
 *   off their own previous letter and stays in one piece. Typing forwards is unchanged:
 *   a run typed in one go is a chain of right children, sent as one op (`s@c`, `s@c+1`,
 *   …, Notion's run-length grouping).
 *
 * Deletes.
 *   Deleting hides an item but keeps it as a tombstone, because other people's offline
 *   edits may still point at it. Visibility is a last-writer-wins register (by clock, then
 *   session), which lets undo bring deleted text back. Once a delete is old (see `gc`),
 *   the tombstone's content is dropped and only its id and place in the tree remain.
 *
 * Formatting.
 *   A mark op covers a range between two anchors, each attached to one side of an item:
 *   `before` or `after` it. Text typed at the end of a bold range lands inside it, because
 *   the range ends `before` the next item ("extendable" marks: bold, italic, …); a link
 *   ends `after` its last item, so it doesn't grow. When several mark ops of the same kind
 *   cover an item, the newest wins: concurrent bold + italic both apply, and bold vs.
 *   un-bold resolves the same way everywhere.
 *
 * Performance.
 *   Items live in document order in a list of chunks (≤ 1024 items each) that track their
 *   visible count, so finding the n-th visible character, an item's position, or where a
 *   remote insert goes costs O(√n) instead of O(n), and nothing re-reads the whole text.
 */

export type Mention = { type: "page" | "user"; id: string; label: string };
/** One unit of text: a UTF-16 code unit, or an inline atom (one position in the editor). */
export type Unit = string | { mention: Mention };

export interface Anchor {
  item: string;
  side: "before" | "after";
}

export type TextOp =
  /**
   * Insert a run of units: the first is the `side` child of `parent` (null = the root),
   * each next one the right child of the one before. `gc: n` stands for n units whose
   * content was collected (tombstones, when loading a compacted instance).
   */
  | { t: "ins"; id: string; parent: string | null; side: "L" | "R"; value: Unit[]; gc?: number }
  /** Hide (visible=false) or restore (visible=true) items. */
  | { t: "vis"; id: string; targets: string[]; visible: boolean }
  /** Set (value) or clear (null) a mark between two anchors. null anchors = text start / end. */
  | { t: "mark"; id: string; mark: string; value: MarkValue; start: Anchor | null; end: Anchor | null };

export type MarkValue = true | string | null;

/** Marks whose ranges grow when you type at their end. */
export const EXTENDABLE = new Set(["bold", "italic", "underline", "strike", "color"]);

export const makeId = (session: string, clock: number) => `${session}@${clock}`;
export function parseId(id: string): { s: string; c: number } {
  const at = id.lastIndexOf("@");
  return { s: id.slice(0, at), c: Number(id.slice(at + 1)) };
}
/** Total order on op ids: clock, then session. */
export function compareStamps(a: string, b: string): number {
  const x = parseId(a);
  const y = parseId(b);
  return x.c - y.c || (x.s < y.s ? -1 : x.s > y.s ? 1 : 0);
}

interface Item {
  id: string;
  s: string;
  c: number;
  parent: Item | null;
  side: "L" | "R";
  /** null: content collected (a tombstone that can't come back). */
  value: Unit | null;
  /** Latest visibility op: id and value. Null = never touched = visible. */
  vis: { id: string; visible: boolean } | null;
  left: Item[] | null;
  right: Item[] | null;
  chunk: Chunk;
  /** Server only: when the item was hidden (wall clock), for collecting old tombstones. */
  hiddenAt?: number;
}

interface Chunk {
  items: Item[];
  visible: number;
}

interface MarkOp {
  id: string;
  mark: string;
  value: MarkValue;
  start: Anchor | null;
  end: Anchor | null;
}

/**
 * Stored form, version 2: runs in creation order. A run is items `s@c…` where each next
 * item is the right child of the previous one: [first id, parent, side, text or units, or
 * the number of collected units]. Visibility is run-length encoded the same way.
 */
export interface TextInstanceJSON {
  id: string;
  v?: 2;
  runs?: Array<[id: string, parent: string | null, side: "L" | "R", content: string | Unit[] | number]>;
  /** [first item, vis op id, visible, count, hiddenAt?] for consecutive ids with the same visibility. */
  vis?: Array<[id: string, op: string, visible: boolean, count: number, hiddenAt?: number]>;
  marks: MarkOp[];
  /** Version 1 (before Fugue): [id, origin, value, vis]; origin = parent, side R. */
  items?: Array<[id: string, origin: string | null, value: Unit, vis: { id: string; visible: boolean } | null]>;
}

/** A run of text with formatting, as the editor and the block model want it. */
export interface Piece {
  /** The item id of each unit (same length as `units`). */
  ids: string[];
  units: Unit[];
  marks: Record<string, true | string>[];
}

const CHUNK = 1024;

/** Newest first: higher clock, then higher session. */
const before = (a: Item, b: Item) => a.c > b.c || (a.c === b.c && a.s > b.s);

export class TextInstance {
  readonly id: string;
  private items = new Map<string, Item>();
  private root: Item;
  private chunks: Chunk[] = [{ items: [], visible: 0 }];
  private marks: MarkOp[] = [];
  /** Mark ops applied. */
  private seen = new Set<string>();
  /** Ops waiting for items they reference. */
  private waiting: TextOp[] = [];
  /** Highest clock seen, so local ops can be stamped after everything known. */
  maxClock = 0;
  /** Bumped on every change (readers cache by it). */
  version = 0;

  constructor(id: string) {
    this.id = id;
    this.root = { id: "", s: "", c: Infinity, parent: null, side: "R", value: null, vis: null, left: null, right: [], chunk: this.chunks[0]! };
  }

  has(itemId: string) {
    return this.items.has(itemId);
  }

  get pendingOps() {
    return this.waiting.length;
  }

  get size() {
    return this.items.size;
  }

  // ------------------------------------------------------------ applying ops

  /**
   * Apply ops in any order; duplicates are ignored. Returns the ops that took effect
   * (including earlier ones that were waiting for these). `now` (server) records when
   * items were hidden, for `gc`.
   */
  apply(ops: TextOp[], now?: number): TextOp[] {
    const applied: TextOp[] = [];
    // In order first (the usual case: everything is ready), then whatever had to wait.
    let fresh = false;
    for (const raw of ops) {
      const op = upgrade(raw);
      if (this.done(op)) continue;
      if (this.ready(op)) {
        this.integrate(op, now);
        applied.push(op);
        fresh = true;
      } else this.waiting.push(op);
    }
    let progress = fresh || this.waiting.length > 0;
    while (progress && this.waiting.length) {
      progress = false;
      for (let i = 0; i < this.waiting.length; i++) {
        const op = this.waiting[i]!;
        if (this.done(op)) {
          this.waiting.splice(i--, 1);
          continue;
        }
        if (!this.ready(op)) continue;
        this.waiting.splice(i--, 1);
        this.integrate(op, now);
        applied.push(op);
        progress = true;
      }
    }
    if (applied.length) this.version++;
    return applied;
  }

  /**
   * Already applied? A run of inserts is done when its last item exists: stored runs can
   * be longer than the ops that made them (a client may hold the start of one already).
   * Marks by id.
   */
  private done(op: TextOp): boolean {
    if (op.t === "ins") {
      const { s, c } = parseId(op.id);
      return this.items.has(makeId(s, c + Math.max(1, op.gc ?? op.value.length) - 1));
    }
    if (op.t === "mark") return this.seen.has(op.id);
    return false;
  }

  private ready(op: TextOp): boolean {
    switch (op.t) {
      case "ins":
        return op.parent === null || this.items.has(op.parent);
      case "vis":
        return op.targets.every((t) => this.items.has(t));
      case "mark":
        return (!op.start || this.items.has(op.start.item)) && (!op.end || this.items.has(op.end.item));
    }
  }

  private integrate(op: TextOp, now?: number) {
    const { s, c } = parseId(op.id);
    switch (op.t) {
      case "ins": {
        const total = op.gc ?? op.value.length;
        // Skip the part of the run this replica already has: the rest continues from it.
        let k = 0;
        while (k < total && this.items.has(makeId(s, c + k))) k++;
        const n = total - k;
        if (!n) return;
        const parent = k > 0 ? this.items.get(makeId(s, c + k - 1))! : op.parent === null ? this.root : this.items.get(op.parent)!;
        const side = k > 0 ? "R" : op.parent === null ? "R" : op.side;
        const valueAt = (i: number) => (op.gc ? null : op.value[k + i]!);
        const first = this.newItem(s, c + k, parent, side, valueAt(0));
        this.place(first);
        // The rest of the run: right children chained off the previous one, which has no
        // children yet, so each goes right after it in document order.
        let prev = first;
        const rest: Item[] = [];
        for (let i = 1; i < n; i++) {
          const it = this.newItem(s, c + k + i, prev, "R", valueAt(i));
          prev.right = [it];
          rest.push(it);
          prev = it;
        }
        if (rest.length) this.insertAfter(first, rest);
        this.maxClock = Math.max(this.maxClock, c + total - 1);
        break;
      }
      case "vis":
        for (const t of op.targets) {
          const item = this.items.get(t)!;
          if (item.vis && compareStamps(op.id, item.vis.id) <= 0) continue;
          const was = this.isVisible(item);
          item.vis = { id: op.id, visible: op.visible };
          const is = this.isVisible(item);
          if (was !== is) item.chunk.visible += is ? 1 : -1;
          if (!op.visible && now !== undefined) item.hiddenAt = now;
        }
        this.maxClock = Math.max(this.maxClock, c);
        break;
      case "mark":
        this.seen.add(op.id);
        this.marks.push({ id: op.id, mark: op.mark, value: op.value, start: op.start, end: op.end });
        this.maxClock = Math.max(this.maxClock, c);
        break;
    }
  }

  private newItem(s: string, c: number, parent: Item, side: "L" | "R", value: Unit | null): Item {
    const it: Item = { id: makeId(s, c), s, c, parent, side, value, vis: null, left: null, right: null, chunk: this.chunks[0]! };
    this.items.set(it.id, it);
    return it;
  }

  /** Put a new item among its siblings and at its place in document order. */
  private place(x: Item) {
    const p = x.parent!;
    const sibs = x.side === "R" ? (p.right ??= []) : (p.left ??= []);
    let i = 0;
    while (i < sibs.length && before(sibs[i]!, x)) i++;
    const next = sibs[i];
    sibs.splice(i, 0, x);
    if (next) return this.insertBefore(leftmost(next), [x]);
    if (x.side === "L") return this.insertBefore(p, [x]);
    // Last right child: after the parent's whole right side (or the parent itself).
    const prevSib = sibs[i - 1];
    if (prevSib) return this.insertAfter(rightmost(prevSib), [x]);
    if (p === this.root) return this.insertAt(0, [x]);
    return this.insertAfter(p, [x]);
  }

  // ------------------------------------------------------------ the chunk list

  private insertBefore(ref: Item, xs: Item[]) {
    const ch = ref.chunk;
    this.spliceInto(ch, ch.items.indexOf(ref), xs);
  }

  private insertAfter(ref: Item, xs: Item[]) {
    const ch = ref.chunk;
    this.spliceInto(ch, ch.items.indexOf(ref) + 1, xs);
  }

  private insertAt(pos: number, xs: Item[]) {
    for (const ch of this.chunks) {
      if (pos <= ch.items.length) return this.spliceInto(ch, pos, xs);
      pos -= ch.items.length;
    }
    this.spliceInto(this.chunks[this.chunks.length - 1]!, this.chunks[this.chunks.length - 1]!.items.length, xs);
  }

  private spliceInto(ch: Chunk, at: number, xs: Item[]): void {
    ch.items.splice(at, 0, ...xs);
    for (const x of xs) {
      x.chunk = ch;
      if (this.isVisible(x)) ch.visible++;
    }
    while (ch.items.length > CHUNK) {
      const tail: Chunk = { items: ch.items.splice(CHUNK / 2), visible: 0 };
      for (const x of tail.items) {
        x.chunk = tail;
        if (this.isVisible(x)) tail.visible++;
      }
      ch.visible -= tail.visible;
      this.chunks.splice(this.chunks.indexOf(ch) + 1, 0, tail);
      if (tail.items.length > CHUNK) return this.spliceInto(tail, tail.items.length, []);
    }
  }

  // ------------------------------------------------------------ reading

  private isVisible(it: Item) {
    return it.value !== null && (!it.vis || it.vis.visible);
  }

  visible(itemId: string): boolean {
    const it = this.items.get(itemId);
    return !!it && this.isVisible(it);
  }

  value(itemId: string): Unit {
    return this.items.get(itemId)!.value!;
  }

  /** Number of items (tombstones included). */
  get length() {
    let n = 0;
    for (const ch of this.chunks) n += ch.items.length;
    return n;
  }

  /** Document position of an item (tombstones included), or -1. */
  indexOf(itemId: string): number {
    const it = this.items.get(itemId);
    if (!it) return -1;
    let pos = 0;
    for (const ch of this.chunks) {
      if (ch === it.chunk) return pos + ch.items.indexOf(it);
      pos += ch.items.length;
    }
    return -1;
  }

  /** Item id at a document position. */
  idAt(pos: number): string | undefined {
    for (const ch of this.chunks) {
      if (pos < ch.items.length) return ch.items[pos]!.id;
      pos -= ch.items.length;
    }
    return undefined;
  }

  /** Every item id (tombstones included) in document order. O(n): for tests and tools. */
  order(): string[] {
    const out: string[] = [];
    for (const ch of this.chunks) for (const it of ch.items) out.push(it.id);
    return out;
  }

  /** Positions [from, to) of a slice. */
  bounds(from: string | null, to: string | null): [number, number] {
    const n = this.length;
    const a = from === null ? 0 : this.indexOf(from);
    const b = to === null ? n : this.indexOf(to);
    return [a < 0 ? n : a, b < 0 ? n : b];
  }

  /** Visible items in positions [lo, hi). */
  visibleCount(lo = 0, hi = Infinity): number {
    let n = 0;
    let pos = 0;
    for (const ch of this.chunks) {
      const len = ch.items.length;
      if (pos >= hi) break;
      if (pos + len <= lo) {
        pos += len;
        continue;
      }
      if (pos >= lo && pos + len <= hi) n += ch.visible;
      else for (let i = Math.max(0, lo - pos); i < Math.min(len, hi - pos); i++) if (this.isVisible(ch.items[i]!)) n++;
      pos += len;
    }
    return n;
  }

  /** Id of the k-th visible item (0-based) at or after position lo. */
  nthVisible(lo: number, k: number): string | undefined {
    let pos = 0;
    for (const ch of this.chunks) {
      const len = ch.items.length;
      if (pos + len <= lo) {
        pos += len;
        continue;
      }
      const start = Math.max(0, lo - pos);
      if (start === 0 && k >= ch.visible) {
        k -= ch.visible;
        pos += len;
        continue;
      }
      for (let i = start; i < len; i++) {
        if (!this.isVisible(ch.items[i]!)) continue;
        if (k === 0) return ch.items[i]!.id;
        k--;
      }
      pos += len;
    }
    return undefined;
  }

  /** Visit items in positions [lo, hi) in order. */
  forEach(lo: number, hi: number, fn: (id: string, visible: boolean, pos: number) => void | false) {
    let pos = 0;
    for (const ch of this.chunks) {
      const len = ch.items.length;
      if (pos >= hi) return;
      if (pos + len <= lo) {
        pos += len;
        continue;
      }
      for (let i = Math.max(0, lo - pos); i < Math.min(len, hi - pos); i++) {
        const it = ch.items[i]!;
        if (fn(it.id, this.isVisible(it), pos + i) === false) return;
      }
      pos += len;
    }
  }

  /**
   * Where a new item goes so that it lands right after item `after` (null: at the very
   * start of the text). Fugue: right child of `after` if it has none yet, otherwise left
   * child of the item that follows it (which then has no left children).
   */
  placement(after: string | null): { parent: string | null; side: "L" | "R" } {
    const a = after === null ? null : this.items.get(after)!;
    if (a && !a.right?.length) return { parent: a.id, side: "R" };
    const bPos = a ? this.indexOf(a.id) + 1 : 0;
    const b = this.idAt(bPos);
    if (b) return { parent: b, side: "L" };
    return { parent: a ? a.id : null, side: "R" };
  }

  /** Visible units (with ids and marks) between two positions. */
  read(fromIdx: number, toIdx: number): Piece {
    const piece: Piece = { ids: [], units: [], marks: [] };
    const active = this.marksFor(fromIdx, toIdx);
    this.forEach(fromIdx, toIdx, (id, vis, pos) => {
      if (!vis) return;
      piece.ids.push(id);
      piece.units.push(this.items.get(id)!.value!);
      piece.marks.push(active(pos));
    });
    return piece;
  }

  /**
   * Marks per position. Positions run before(x0), x0, after(x0), before(x1), …; an op
   * covers an item when the item lies between its start and end anchors.
   */
  private marksFor(fromIdx: number, toIdx: number): (i: number) => Record<string, true | string> {
    if (!this.marks.length) return () => ({});
    const pos = (a: Anchor) => this.indexOf(a.item) * 3 + (a.side === "before" ? 0 : 2);
    const spans = this.marks
      .map((m) => ({ m, lo: m.start ? pos(m.start) : -Infinity, hi: m.end ? pos(m.end) : Infinity }))
      .filter(({ lo, hi }) => lo < toIdx * 3 && hi > fromIdx * 3);
    if (!spans.length) return () => ({});
    return (i) => {
      const at = i * 3 + 1;
      const best = new Map<string, MarkOp>();
      for (const { m, lo, hi } of spans) {
        if (at < lo || at > hi) continue;
        const cur = best.get(m.mark);
        if (!cur || compareStamps(m.id, cur.id) > 0) best.set(m.mark, m);
      }
      // Sorted, so every replica lists marks in the same order whatever order ops arrived in.
      const out: Record<string, true | string> = {};
      for (const k of [...best.keys()].sort()) if (best.get(k)!.value !== null) out[k] = best.get(k)!.value as true | string;
      return out;
    };
  }

  // ------------------------------------------------------------ cleanup

  /**
   * Drop the content of tombstones hidden before `before` (server wall clock). Their ids
   * and places in the tree stay, because offline edits may still point at them, but the
   * text is gone and they can't be restored. Returns how many were collected.
   */
  gc(before: number): number {
    let n = 0;
    for (const it of this.items.values()) {
      if (it.value === null || this.isVisible(it) || it.hiddenAt === undefined || it.hiddenAt >= before) continue;
      it.value = null;
      n++;
    }
    if (n) this.version++;
    return n;
  }

  // ------------------------------------------------------------ persistence

  /** Items in creation order (parents before children), grouped into runs. */
  private runs(): Item[][] {
    const all = [...this.items.values()].sort((a, b) => a.c - b.c || (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
    const kind = (x: Item) => (x.value === null ? "gc" : typeof x.value === "string" ? "text" : "atom");
    const runs: Item[][] = [];
    for (const it of all) {
      const run = runs[runs.length - 1];
      const last = run?.[run.length - 1];
      // A run: one session's consecutive clocks, each the right child of the previous,
      // all text or all collected (atoms like mentions stand alone).
      const chained = !!last && it.s === last.s && it.c === last.c + 1 && it.parent === last && it.side === "R" && kind(it) === kind(last) && kind(it) !== "atom";
      if (chained) run!.push(it);
      else runs.push([it]);
    }
    return runs;
  }

  toJSON(opts: { hiddenAt?: boolean } = {}): TextInstanceJSON {
    const runs: NonNullable<TextInstanceJSON["runs"]> = this.runs().map((run) => {
      const first = run[0]!;
      const parent = first.parent === this.root ? null : first.parent!.id;
      const content = first.value === null ? run.length : run.every((it) => typeof it.value === "string") ? run.map((it) => it.value as string).join("") : run.map((it) => it.value!);
      return [first.id, parent, first.side, content];
    });
    const vis: NonNullable<TextInstanceJSON["vis"]> = [];
    const all = [...this.items.values()].filter((it) => it.vis && it.value !== null).sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : a.c - b.c));
    for (const it of all) {
      const last = vis[vis.length - 1];
      const lastId = last ? parseId(last[0]) : null;
      const hidden = opts.hiddenAt ? it.hiddenAt : undefined;
      if (last && lastId!.s === it.s && lastId!.c + last[3] === it.c && last[1] === it.vis!.id && last[2] === it.vis!.visible && last[4] === hidden) last[3]++;
      else vis.push(hidden === undefined ? [it.id, it.vis!.id, it.vis!.visible, 1] : [it.id, it.vis!.id, it.vis!.visible, 1, hidden]);
    }
    return { id: this.id, v: 2, runs, vis, marks: this.marks };
  }

  static fromJSON(json: TextInstanceJSON): TextInstance {
    const t = new TextInstance(json.id);
    t.apply(TextInstance.opsOf(json));
    for (const [id, , , count, hiddenAt] of json.vis ?? []) {
      if (hiddenAt === undefined) continue;
      const { s, c } = parseId(id);
      for (let i = 0; i < count; i++) {
        const it = t.items.get(makeId(s, c + i));
        if (it) it.hiddenAt = hiddenAt;
      }
    }
    return t;
  }

  /** The ops that rebuild a stored instance. */
  static opsOf(json: TextInstanceJSON): TextOp[] {
    const out: TextOp[] = [];
    if (json.items) {
      // Version 1: RGA origins. "After origin, newest first" is exactly "right child of
      // origin" here, so the order is unchanged.
      const items = [...json.items].sort((a, b) => compareStamps(a[0], b[0]));
      for (const [id, origin, value] of items) out.push({ t: "ins", id, parent: origin, side: "R", value: [value] });
      for (const [id, , , vis] of json.items) if (vis) out.push({ t: "vis", id: vis.id, targets: [id], visible: vis.visible });
    }
    for (const [id, parent, side, content] of json.runs ?? []) {
      if (typeof content === "number") out.push({ t: "ins", id, parent, side, value: [], gc: content });
      else out.push({ t: "ins", id, parent, side, value: typeof content === "string" ? content.split("") : content });
    }
    for (const [id, op, visible, count] of json.vis ?? []) {
      const { s, c } = parseId(id);
      out.push({ t: "vis", id: op, targets: Array.from({ length: count }, (_, i) => makeId(s, c + i)), visible });
    }
    for (const m of json.marks) out.push({ t: "mark", ...m });
    return out;
  }

  /** Everything in this instance as ops (for a client loading a document). */
  ops(): TextOp[] {
    return TextInstance.opsOf(this.toJSON());
  }

  clone(): TextInstance {
    return TextInstance.fromJSON(JSON.parse(JSON.stringify(this.toJSON({ hiddenAt: true }))));
  }
}

function leftmost(it: Item): Item {
  let n = it;
  while (n.left?.length) n = n.left[0]!;
  return n;
}

function rightmost(it: Item): Item {
  let n = it;
  while (n.right?.length) n = n.right[n.right.length - 1]!;
  return n;
}

/** Ops from before Fugue named an `origin`: that's a right child of it. */
function upgrade(op: TextOp): TextOp {
  if (op.t === "ins" && op.parent === undefined && "origin" in op) {
    const { origin, ...rest } = op as unknown as { origin: string | null } & Omit<Extract<TextOp, { t: "ins" }>, "parent" | "side">;
    return { ...rest, parent: origin, side: "R" };
  }
  return op;
}

// ---------------------------------------------------------------- units <-> strings

export const unitText = (u: Unit) => (typeof u === "string" ? u : u.mention.type === "user" ? `@${u.mention.label}` : u.mention.label);
export const unitsText = (units: Unit[]) => units.map(unitText).join("");
export const toUnits = (s: string): Unit[] => s.split("");
export const sameUnit = (a: Unit, b: Unit) =>
  typeof a === "string" || typeof b === "string" ? a === b : a.mention.type === b.mention.type && a.mention.id === b.mention.id && a.mention.label === b.mention.label;
