/**
 * Leaf's text CRDT, modeled on the one Notion describes in "How Notion handles concurrent
 * editing with CRDTs": a Replicated Growable Array for characters plus Peritext-style
 * annotations for formatting.
 *
 * Characters.
 *   Every character (or inline atom, like a mention) ever inserted is an item with a
 *   permanent id `session@clock`: the session that typed it and a Lamport clock. An item
 *   is inserted after an "origin" item, which makes the text a tree; the text is that
 *   tree read in pre-order, where items with the same origin are sorted newest first
 *   (higher clock, then higher session). Every replica builds the same tree no matter
 *   in which order inserts arrive, so they all read the same text.
 *   A run typed in one go is a single op: ids `s@c`, `s@c+1`, … each after the previous.
 *
 * Deletes.
 *   Deleting hides an item but keeps it as a tombstone, because other people's offline
 *   edits may still reference it. Visibility is a last-writer-wins register (by clock,
 *   then session), which also lets undo bring deleted text back.
 *
 * Formatting.
 *   A mark op covers a range between two anchors, each attached to one side of an item:
 *   `before` or `after` it. Text typed at the end of a bold range lands inside it,
 *   because the range ends `before` the next item ("extendable" marks: bold, italic, …);
 *   a link ends `after` its last item, so it doesn't grow. When several mark ops of the
 *   same kind cover an item, the newest wins, so concurrent bold + italic both apply and
 *   bold vs. unbold resolves the same way everywhere.
 */

export type Mention = { type: "page" | "user"; id: string; label: string };
/** One unit of text: a UTF-16 code unit, or an inline atom (one position in the editor). */
export type Unit = string | { mention: Mention };

export interface Anchor {
  item: string;
  side: "before" | "after";
}

export type TextOp =
  /** Insert a run of units after `origin` (null = the start of the text). */
  | { t: "ins"; id: string; origin: string | null; value: Unit[] }
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
  origin: string | null;
  value: Unit;
  /** Latest visibility op: id and value. Null = never touched = visible. */
  vis: { id: string; visible: boolean } | null;
  /** Items inserted right after this one, newest first. */
  children: string[];
}

interface MarkOp {
  id: string;
  mark: string;
  value: MarkValue;
  start: Anchor | null;
  end: Anchor | null;
}

export interface TextInstanceJSON {
  id: string;
  items: Array<[id: string, origin: string | null, value: Unit, vis: { id: string; visible: boolean } | null]>;
  marks: MarkOp[];
}

/** A run of text with formatting, as the editor and the block model want it. */
export interface Piece {
  /** The item id of each unit (same length as `units`). */
  ids: string[];
  units: Unit[];
  marks: Record<string, true | string>[];
}

const newestFirst = (a: string, b: string) => compareStamps(b, a);

export class TextInstance {
  readonly id: string;
  private items = new Map<string, Item>();
  private roots: string[] = [];
  private marks: MarkOp[] = [];
  /** Mark ops applied. */
  private seen = new Set<string>();
  /** Ops waiting for items they reference. */
  private waiting: TextOp[] = [];
  private orderCache: string[] | null = null;
  private indexCache: Map<string, number> | null = null;
  /** Highest clock seen, so local ops can be stamped after everything known. */
  maxClock = 0;

  constructor(id: string) {
    this.id = id;
  }

  has(itemId: string) {
    return this.items.has(itemId);
  }

  get pendingOps() {
    return this.waiting.length;
  }

  // ------------------------------------------------------------ applying ops

  /** Apply ops in any order; duplicates are ignored. Returns the ops that took effect. */
  apply(ops: TextOp[]): TextOp[] {
    const applied: TextOp[] = [];
    // Visibility ops are last-writer-wins per item, so they're idempotent on their own and
    // may be re-sent split per item (catch-up); inserts and marks are deduplicated by id.
    for (const op of ops) if (!this.done(op)) this.waiting.push(op);
    let progress = true;
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
        this.integrate(op);
        applied.push(op);
        progress = true;
      }
    }
    return applied;
  }

  /** Already applied? Inserts by their first item (a run is all-or-nothing), marks by id. */
  private done(op: TextOp): boolean {
    if (op.t === "ins") return this.items.has(op.id);
    if (op.t === "mark") return this.seen.has(op.id);
    return false;
  }

  private ready(op: TextOp): boolean {
    switch (op.t) {
      case "ins":
        return op.origin === null || this.items.has(op.origin);
      case "vis":
        return op.targets.every((t) => this.items.has(t));
      case "mark":
        return (!op.start || this.items.has(op.start.item)) && (!op.end || this.items.has(op.end.item));
    }
  }

  private integrate(op: TextOp) {
    if (op.t === "mark") this.seen.add(op.id);
    const { s, c } = parseId(op.id);
    switch (op.t) {
      case "ins": {
        let origin = op.origin;
        op.value.forEach((value, i) => {
          const id = makeId(s, c + i);
          const item: Item = { id, origin, value, vis: null, children: [] };
          this.items.set(id, item);
          const siblings = origin === null ? this.roots : this.items.get(origin)!.children;
          let at = 0;
          while (at < siblings.length && newestFirst(siblings[at]!, id) < 0) at++;
          siblings.splice(at, 0, id);
          origin = id;
        });
        this.maxClock = Math.max(this.maxClock, c + op.value.length - 1);
        this.orderCache = this.indexCache = null;
        break;
      }
      case "vis":
        for (const t of op.targets) {
          const item = this.items.get(t)!;
          if (!item.vis || compareStamps(op.id, item.vis.id) > 0) item.vis = { id: op.id, visible: op.visible };
        }
        this.maxClock = Math.max(this.maxClock, c);
        break;
      case "mark":
        this.marks.push({ id: op.id, mark: op.mark, value: op.value, start: op.start, end: op.end });
        this.maxClock = Math.max(this.maxClock, c);
        break;
    }
  }

  // ------------------------------------------------------------ reading

  /** Every item id (tombstones included), in document order: a pre-order walk. */
  order(): string[] {
    if (this.orderCache) return this.orderCache;
    const out: string[] = [];
    const stack = [...this.roots].reverse();
    while (stack.length) {
      const id = stack.pop()!;
      out.push(id);
      const kids = this.items.get(id)!.children;
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
    }
    this.orderCache = out;
    return out;
  }

  indexOf(itemId: string): number {
    if (!this.indexCache) this.indexCache = new Map(this.order().map((id, i) => [id, i]));
    return this.indexCache.get(itemId) ?? -1;
  }

  visible(itemId: string): boolean {
    const v = this.items.get(itemId)?.vis;
    return !v || v.visible;
  }

  value(itemId: string): Unit {
    return this.items.get(itemId)!.value;
  }

  /** Order indexes [from, to) of a slice. */
  bounds(from: string | null, to: string | null): [number, number] {
    const n = this.order().length;
    const a = from === null ? 0 : this.indexOf(from);
    const b = to === null ? n : this.indexOf(to);
    return [a < 0 ? n : a, b < 0 ? n : b];
  }

  /** Visible units (with ids and marks) between two order indexes. */
  read(fromIdx: number, toIdx: number): Piece {
    const order = this.order();
    const piece: Piece = { ids: [], units: [], marks: [] };
    const active = this.marksFor(fromIdx, toIdx);
    for (let i = fromIdx; i < toIdx; i++) {
      const id = order[i]!;
      if (!this.visible(id)) continue;
      piece.ids.push(id);
      piece.units.push(this.items.get(id)!.value);
      piece.marks.push(active(i));
    }
    return piece;
  }

  /**
   * Marks per order index. Positions run before(x0), x0, after(x0), before(x1), …; an op
   * covers an item when the item lies between its start and end anchors.
   */
  private marksFor(fromIdx: number, toIdx: number): (i: number) => Record<string, true | string> {
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

  // ------------------------------------------------------------ persistence

  toJSON(): TextInstanceJSON {
    return {
      id: this.id,
      items: this.order().map((id) => {
        const it = this.items.get(id)!;
        return [id, it.origin, it.value, it.vis];
      }),
      marks: this.marks,
    };
  }

  static fromJSON(json: TextInstanceJSON): TextInstance {
    const t = new TextInstance(json.id);
    // Items are stored in document order, so every origin precedes its children; add
    // them oldest-first per parent by re-integrating as single-item inserts.
    const items = [...json.items].sort((a, b) => compareStamps(a[0], b[0]));
    for (const [id, origin, value] of items) t.integrate({ t: "ins", id, origin, value: [value] });
    for (const [id, , , vis] of json.items) if (vis) t.items.get(id)!.vis = vis;
    for (const m of json.marks) t.integrate({ t: "mark", ...m });
    for (const [id, , , vis] of json.items) {
      t.maxClock = Math.max(t.maxClock, parseId(id).c, vis ? parseId(vis.id).c : 0);
    }
    return t;
  }

  /** Everything in this instance as ops (for merging a copy fetched from the server). */
  ops(): TextOp[] {
    const json = this.toJSON();
    const out: TextOp[] = json.items.map(([id, origin, value]) => ({ t: "ins", id, origin, value: [value] }));
    for (const [id, , , vis] of json.items) if (vis) out.push({ t: "vis", id: vis.id, targets: [id], visible: vis.visible });
    for (const m of json.marks) out.push({ t: "mark", ...m });
    return out;
  }

  clone(): TextInstance {
    return TextInstance.fromJSON(JSON.parse(JSON.stringify(this.toJSON())));
  }
}

// ---------------------------------------------------------------- units <-> strings

export const unitText = (u: Unit) => (typeof u === "string" ? u : u.mention.type === "user" ? `@${u.mention.label}` : u.mention.label);
export const unitsText = (units: Unit[]) => units.map(unitText).join("");
export const toUnits = (s: string): Unit[] => s.split("");
export const sameUnit = (a: Unit, b: Unit) =>
  typeof a === "string" || typeof b === "string" ? a === b : a.mention.type === b.mention.type && a.mention.id === b.mention.id && a.mention.label === b.mention.label;
