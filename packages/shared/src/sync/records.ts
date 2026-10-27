/**
 * Block records and the operations that change them, after Notion's model ("The data
 * model behind Notion's flexibility"): a block is a record with an id, a type, a bag of
 * properties, an ordered `content` list of child ids and a parent pointer. Edits are
 * operations on records, batched into transactions that the server commits or rejects.
 *
 * Structural operations (create, move, delete, type and property changes) are ordered by
 * the server: clients apply them optimistically, and re-apply their pending ones on top
 * of whatever the server confirms ("rebase"), so the server's order is the final word.
 *
 * Text is different: a block's text is a list of *slices* of text instances (CRDTs, see
 * text.ts), so concurrent typing merges instead of last-writer-wins. Splitting a block
 * (Enter in the middle) doesn't copy text: the new block takes the tail of the same
 * instance as a slice. Someone typing into that tail at the same time, even offline,
 * lands in whichever block holds that part of the instance, which is the new block.
 * Merging (Backspace at the start) appends the second block's slices to the first, so
 * text typed concurrently into the merged-away block isn't lost either.
 *
 * A block's first slice always starts at the beginning of the block's own instance
 * (`from: null`), so typing at offset 0 always has somewhere to go.
 */
import type { Block, BlockType, RichText, RichTextRun, Slice } from "../types.js";
import { EXTENDABLE, makeId, sameUnit, TextInstance, unitText, type Anchor, type MarkValue, type Piece, type TextOp, type Unit } from "./text.js";

export type { Slice };

export type RecordOp =
  | { op: "create"; id: string; type: BlockType; parent: string; after: string | null; properties: Record<string, any>; text: Slice[] | null }
  | { op: "update"; id: string; type?: BlockType; properties?: Record<string, any>; text?: Slice[] | null }
  | { op: "move"; id: string; parent: string; after: string | null }
  | { op: "delete"; id: string }
  | { op: "restore"; id: string; parent: string; after: string | null }
  | { op: "text"; instance: string; ops: TextOp[] }
  /** Cut block `id` before item `at` (null = at the end); the tail becomes block `newId`. */
  | { op: "split"; id: string; at: string | null; newId: string; newInstance: string; type: BlockType; properties: Record<string, any> }
  /** Append `from`'s text to `into` and remove `from`. */
  | { op: "merge"; into: string; from: string }
  /** Server only: take a page out of its parent page, to the workspace root. */
  | { op: "detach"; id: string };

export interface Transaction {
  id: string;
  ops: RecordOp[];
}

/** Where records and instances live: the client's view, or the server's database. */
export interface SyncState {
  getBlock(id: string): Block | undefined;
  putBlock(b: Block): void;
  instance(id: string): TextInstance;
  /** Blocks whose text has a slice of this instance. */
  blocksOfInstance(id: string): string[];
  /**
   * The block whose `content` lists `id`, when that isn't its parent (a child page or
   * database placed inside a column or toggle keeps its page as parent).
   */
  findContainer(id: string): string | null;
  /** Default bookkeeping for new / edited records. */
  readonly userId: string | null;
  now(): number;
}

/** Lamport clock for one session. */
export class Clock {
  private last = 0;
  constructor(readonly session: string) {}
  /** A fresh run of `n` stamps after everything in `inst`. */
  stamp(inst: TextInstance, n = 1): string {
    const c = Math.max(this.last, inst.maxClock) + 1;
    this.last = c + n - 1;
    return makeId(this.session, c);
  }
}

export const TEXT_TYPES = new Set<BlockType>([
  "page",
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "toggle",
  "quote",
  "callout",
  "code",
]);

/** A block's own text instance shares the block's id, so concurrent creators share it too. */
export const ownSlice = (instance: string): Slice[] => [{ i: instance, from: null, to: null }];

// ---------------------------------------------------------------- reading text

export interface Segment {
  slice: Slice;
  index: number;
  inst: TextInstance;
  lo: number;
  hi: number;
  piece: Piece;
}

export function segments(state: SyncState, block: Block): Segment[] {
  return (block.text ?? []).map((slice, index) => {
    const inst = state.instance(slice.i);
    const [lo, hi] = inst.bounds(slice.from, slice.to);
    return { slice, index, inst, lo, hi, piece: inst.read(lo, Math.max(lo, hi)) };
  });
}

export interface BlockTextView {
  ids: string[];
  units: Unit[];
  marks: Record<string, true | string>[];
  /** Which segment each unit came from. */
  seg: number[];
}

export function readText(state: SyncState, block: Block): BlockTextView {
  const out: BlockTextView = { ids: [], units: [], marks: [], seg: [] };
  segments(state, block).forEach((s, k) => {
    out.ids.push(...s.piece.ids);
    out.units.push(...s.piece.units);
    out.marks.push(...s.piece.marks);
    for (let n = 0; n < s.piece.ids.length; n++) out.seg.push(k);
  });
  return out;
}

/** Leaf's rich text runs from units + marks. */
export function toRichText(units: Unit[], marks: Record<string, true | string>[]): RichText {
  const runs: RichText = [];
  units.forEach((u, i) => {
    const m = marks[i] ?? {};
    const runMarks: RichTextRun["marks"] = {};
    for (const [k, v] of Object.entries(m)) {
      if (k === "link" || k === "color") (runMarks as any)[k] = String(v);
      else (runMarks as any)[k] = true;
    }
    const has = Object.keys(runMarks).length > 0;
    if (typeof u !== "string") {
      runs.push({ text: unitText(u), mention: { type: u.mention.type, id: u.mention.id } });
      return;
    }
    const last = runs[runs.length - 1];
    if (last && !last.mention && JSON.stringify(last.marks ?? {}) === JSON.stringify(has ? runMarks : {})) last.text += u;
    else runs.push(has ? { text: u, marks: runMarks } : { text: u });
  });
  return runs;
}

/** Units + marks from Leaf rich text (mention labels are kept for display). */
export function fromRichText(runs: RichText | undefined): { units: Unit[]; marks: Record<string, true | string>[] } {
  const units: Unit[] = [];
  const marks: Record<string, true | string>[] = [];
  for (const r of runs ?? []) {
    const m: Record<string, true | string> = {};
    for (const [k, v] of Object.entries(r.marks ?? {})) if (v) m[k] = v === true ? true : String(v);
    if (r.mention) {
      units.push({ mention: { type: r.mention.type, id: r.mention.id, label: r.mention.type === "user" ? r.text.replace(/^@/, "") : r.text } });
      marks.push(m);
      continue;
    }
    for (const ch of r.text.split("")) {
      units.push(ch);
      marks.push(m);
    }
  }
  return { units, marks };
}

/** Recompute the derived text property (rich_text, or title for pages) of a block. */
export function deriveText(state: SyncState, block: Block): Block {
  if (!block.text) return block;
  const t = readText(state, block);
  if (block.type === "page") {
    const title = t.units.map(unitText).join("");
    if (block.properties.title === title) return block;
    return { ...block, properties: { ...block.properties, title } };
  }
  let rich = toRichText(t.units, t.marks);
  if (block.type === "code") rich = rich.length ? [{ text: rich.map((r) => r.text).join("") }] : [];
  if (block.properties.rich_text !== undefined && JSON.stringify(block.properties.rich_text) === JSON.stringify(rich)) return block;
  return { ...block, properties: { ...block.properties, rich_text: rich } };
}

// ---------------------------------------------------------------- writing text

/**
 * Insert units at a visible offset of a block. Inside a slice, the new run goes right
 * after the unit before the caret. At a slice boundary it goes at the end of the slice
 * before (so it stays inside this block); offset 0 goes at the start of the first slice,
 * which is always the block's own instance from its beginning.
 */
export function insertOps(state: SyncState, clock: Clock, block: Block, offset: number, units: Unit[]): RecordOp | null {
  if (!units.length) return null;
  const segs = segments(state, block);
  if (!segs.length) return null;
  let rest = offset;
  let target = segs[0]!;
  let origin: string | null = null;
  let found = false;
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k]!;
    const n = s.piece.ids.length;
    if (rest <= n && (rest > 0 || k === 0)) {
      target = s;
      origin = rest > 0 ? s.piece.ids[rest - 1]! : null;
      if (rest === 0) {
        // Start of the first slice: after whatever precedes it (nothing, for an own slice).
        origin = s.lo > 0 ? s.inst.order()[s.lo - 1]! : null;
      } else if (rest === n) {
        // End of the slice: after its last item, tombstones included, so the run lands
        // before the slice's end boundary.
        origin = s.hi > s.lo ? s.inst.order()[s.hi - 1]! : origin;
      }
      found = true;
      break;
    }
    rest -= n;
  }
  if (!found) {
    target = segs[segs.length - 1]!;
    origin = target.hi > target.lo ? target.inst.order()[target.hi - 1]! : target.lo > 0 ? target.inst.order()[target.lo - 1]! : null;
  }
  const id = clock.stamp(target.inst, units.length);
  return { op: "text", instance: target.inst.id, ops: [{ t: "ins", id, origin, value: units }] };
}

/** Hide the units in [from, to) of a block. */
export function deleteOps(state: SyncState, clock: Clock, block: Block, from: number, to: number): RecordOp[] {
  const t = readText(state, block);
  const segs = segments(state, block);
  const byInst = new Map<string, string[]>();
  for (let i = from; i < to && i < t.ids.length; i++) {
    const inst = segs[t.seg[i]!]!.inst.id;
    byInst.set(inst, [...(byInst.get(inst) ?? []), t.ids[i]!]);
  }
  return [...byInst].map(([instance, targets]) => ({
    op: "text" as const,
    instance,
    ops: [{ t: "vis" as const, id: clock.stamp(state.instance(instance)), targets, visible: false }],
  }));
}

/** Set (value) or clear (null) a mark over [from, to) of a block, one op per instance. */
export function markOps(state: SyncState, clock: Clock, block: Block, from: number, to: number, mark: string, value: MarkValue): RecordOp[] {
  if (from >= to) return [];
  const t = readText(state, block);
  const segs = segments(state, block);
  const out: RecordOp[] = [];
  let i = from;
  while (i < to && i < t.ids.length) {
    const k = t.seg[i]!;
    let j = i;
    while (j + 1 < to && j + 1 < t.ids.length && t.seg[j + 1] === k) j++;
    const inst = segs[k]!.inst;
    const first = t.ids[i]!;
    const last = t.ids[j]!;
    let end: Anchor | null;
    if (EXTENDABLE.has(mark) && value !== null) {
      // Grows with typing at its end: stop before the next item of the instance.
      const order = inst.order();
      const next = order[inst.indexOf(last) + 1];
      end = next ? { item: next, side: "before" } : null;
    } else end = { item: last, side: "after" };
    out.push({ op: "text", instance: inst.id, ops: [{ t: "mark", id: clock.stamp(inst), mark, value, start: { item: first, side: "before" }, end }] });
    i = j + 1;
  }
  return out;
}

/**
 * Ops that turn a block's current text into `units` / `marks`: one delete and one insert
 * around the common prefix and suffix, then marks fixed up per mark name.
 * Ops are applied to `state` as they're produced (later ones depend on earlier ones).
 */
export function setTextOps(
  state: SyncState,
  clock: Clock,
  blockId: string,
  units: Unit[],
  marks: Record<string, true | string>[],
  apply: (op: RecordOp) => void,
) {
  let block = state.getBlock(blockId)!;
  const cur = readText(state, block);
  let p = 0;
  while (p < cur.units.length && p < units.length && sameUnit(cur.units[p]!, units[p]!)) p++;
  let s = 0;
  while (s < cur.units.length - p && s < units.length - p && sameUnit(cur.units[cur.units.length - 1 - s]!, units[units.length - 1 - s]!)) s++;
  const delTo = cur.units.length - s;
  if (delTo > p) for (const op of deleteOps(state, clock, block, p, delTo)) apply(op);
  const ins = units.slice(p, units.length - s);
  if (ins.length) {
    block = state.getBlock(blockId)!;
    const op = insertOps(state, clock, block, p, ins);
    if (op) apply(op);
  }
  // Formatting: compare per unit and fix maximal ranges, per mark name.
  block = state.getBlock(blockId)!;
  const now = readText(state, block);
  if (now.units.length !== units.length) return;
  const names = new Set<string>();
  for (const m of [...now.marks, ...marks]) for (const k of Object.keys(m ?? {})) names.add(k);
  for (const name of names) {
    let i = 0;
    while (i < units.length) {
      const want = marks[i]?.[name] ?? null;
      const have = now.marks[i]?.[name] ?? null;
      if (want === have) {
        i++;
        continue;
      }
      let j = i + 1;
      while (j < units.length && (marks[j]?.[name] ?? null) === want && (now.marks[j]?.[name] ?? null) !== want) j++;
      for (const op of markOps(state, clock, state.getBlock(blockId)!, i, j, name, want)) apply(op);
      i = j;
    }
  }
}

// ---------------------------------------------------------------- applying record ops

export interface Applied {
  /** Records that changed (structure or properties). */
  changed: Set<string>;
  /** Blocks whose visible text may have changed. */
  text: Set<string>;
  /** Ops that undo this one (text op ids left empty: stamped when the undo runs). */
  inverse: RecordOp[];
  /**
   * Text ops that took effect: this op's, plus earlier ones it released (ops that
   * arrived before what they reference wait until it shows up).
   */
  textApplied?: TextOp[];
}

export class OpError extends Error {}

/** The page document a block belongs to (pages and synced containers own documents). */
export function owningDoc(state: SyncState, parentId: string): string | null {
  const p = state.getBlock(parentId);
  if (!p) return null;
  if (p.type === "page") return p.id;
  if (p.type === "synced_block" && !p.page_id) return p.id;
  return p.page_id;
}

function place(state: SyncState, parentId: string, childId: string, after: string | null, changed: Set<string>) {
  const parent = state.getBlock(parentId);
  if (!parent) throw new OpError(`no parent ${parentId}`);
  const content = parent.content.filter((c) => c !== childId);
  const at = after === null ? 0 : content.indexOf(after) + 1 || content.length;
  content.splice(at, 0, childId);
  state.putBlock({ ...parent, content });
  changed.add(parentId);
}

/** Pages and databases are documents: their parent is the page they live in. */
const isDoc = (type: BlockType) => type === "page" || type === "database";
const parentFor = (state: SyncState, type: BlockType, container: string) => (isDoc(type) ? (owningDoc(state, container) ?? container) : container);

function containerOf(state: SyncState, child: Block): string | null {
  const parent = child.parent_id ? state.getBlock(child.parent_id) : undefined;
  if (parent?.content.includes(child.id)) return parent.id;
  return state.findContainer(child.id) ?? child.parent_id;
}

function unplace(state: SyncState, childId: string, changed: Set<string>): { parent: string | null; after: string | null } {
  const child = state.getBlock(childId);
  const parentId = child ? containerOf(state, child) : null;
  if (!parentId) return { parent: null, after: null };
  const parent = state.getBlock(parentId);
  if (!parent) return { parent: parentId, after: null };
  const idx = parent.content.indexOf(childId);
  if (idx < 0) return { parent: parentId, after: null };
  const after = idx > 0 ? parent.content[idx - 1]! : null;
  state.putBlock({ ...parent, content: parent.content.filter((c) => c !== childId) });
  changed.add(parentId);
  return { parent: parentId, after };
}

/** Re-point `page_id` of a moved content subtree. */
function repage(state: SyncState, id: string, page: string | null, changed: Set<string>) {
  const b = state.getBlock(id);
  if (!b || b.type === "page" || b.type === "database") return;
  if (b.page_id !== page) {
    state.putBlock({ ...b, page_id: page });
    changed.add(id);
  }
  if (b.type === "synced_block" && !b.page_id) return;
  for (const c of b.content) repage(state, c, page, changed);
}

const touch = (state: SyncState, b: Block): Block => ({ ...b, last_edited_by: state.userId ?? b.last_edited_by, last_edited_at: state.now() });

/** Apply one record op. Throws OpError for ops that can't apply (missing records). */
export function applyOp(state: SyncState, op: RecordOp): Applied {
  const changed = new Set<string>();
  const text = new Set<string>();
  const inverse: RecordOp[] = [];
  switch (op.op) {
    case "create": {
      const parent = state.getBlock(op.parent);
      if (!parent) throw new OpError(`no parent ${op.parent}`);
      const existing = state.getBlock(op.id);
      if (existing && !existing.archived) unplace(state, op.id, changed);
      const base: Block = existing ?? {
        id: op.id,
        type: op.type,
        workspace_id: parent.workspace_id,
        parent_id: parentFor(state, op.type, op.parent),
        page_id: null,
        properties: {},
        content: [],
        created_by: state.userId,
        created_at: state.now(),
        last_edited_by: state.userId,
        last_edited_at: state.now(),
        archived: false,
        text: null,
      };
      state.putBlock(
        touch(state, {
          ...base,
          type: op.type,
          parent_id: parentFor(state, op.type, op.parent),
          page_id: isDoc(op.type) ? null : owningDoc(state, op.parent),
          properties: { ...base.properties, ...op.properties },
          text: op.text ?? base.text ?? (TEXT_TYPES.has(op.type) ? ownSlice(op.id) : null),
          archived: false,
        }),
      );
      place(state, op.parent, op.id, op.after, changed);
      changed.add(op.id);
      text.add(op.id);
      inverse.push({ op: "delete", id: op.id });
      break;
    }
    case "update": {
      const b = state.getBlock(op.id);
      if (!b) throw new OpError(`no block ${op.id}`);
      const undo: Extract<RecordOp, { op: "update" }> = { op: "update", id: op.id };
      let next = { ...b };
      if (op.type && op.type !== b.type) {
        undo.type = b.type;
        next.type = op.type;
      }
      if (op.properties) {
        undo.properties = {};
        for (const k of Object.keys(op.properties)) undo.properties[k] = b.properties[k] ?? null;
        next.properties = { ...b.properties, ...op.properties };
      }
      if (op.text !== undefined) {
        undo.text = b.text ?? null;
        next.text = op.text;
        text.add(op.id);
      }
      state.putBlock(touch(state, next));
      changed.add(op.id);
      inverse.push(undo);
      break;
    }
    case "move": {
      const b = state.getBlock(op.id);
      if (!b) throw new OpError(`no block ${op.id}`);
      if (!state.getBlock(op.parent)) throw new OpError(`no parent ${op.parent}`);
      // Refuse cycles: a block can't move inside itself.
      for (let cur: Block | undefined = state.getBlock(op.parent); cur; cur = cur.parent_id ? state.getBlock(cur.parent_id) : undefined) {
        if (cur.id === op.id) throw new OpError("cycle");
        if (cur.type === "page" && cur.id !== op.parent) break;
      }
      const old = unplace(state, op.id, changed);
      state.putBlock(touch(state, { ...state.getBlock(op.id)!, parent_id: parentFor(state, b.type, op.parent) }));
      place(state, op.parent, op.id, op.after, changed);
      if (!isDoc(b.type)) repage(state, op.id, owningDoc(state, op.parent), changed);
      changed.add(op.id);
      if (old.parent) inverse.push({ op: "move", id: op.id, parent: old.parent, after: old.after });
      break;
    }
    case "delete": {
      const b = state.getBlock(op.id);
      if (!b || b.archived) break;
      const old = unplace(state, op.id, changed);
      state.putBlock(touch(state, { ...state.getBlock(op.id)!, archived: true }));
      changed.add(op.id);
      if (old.parent) inverse.push({ op: "restore", id: op.id, parent: old.parent, after: old.after });
      break;
    }
    case "restore": {
      const b = state.getBlock(op.id);
      if (!b) throw new OpError(`no block ${op.id}`);
      if (!state.getBlock(op.parent)) throw new OpError(`no parent ${op.parent}`);
      state.putBlock(touch(state, { ...b, archived: false, parent_id: parentFor(state, b.type, op.parent) }));
      place(state, op.parent, op.id, op.after, changed);
      if (!isDoc(b.type)) repage(state, op.id, owningDoc(state, op.parent), changed);
      changed.add(op.id);
      text.add(op.id);
      inverse.push({ op: "delete", id: op.id });
      break;
    }
    case "text": {
      const inst = state.instance(op.instance);
      const prev = op.ops.map((t) => (t.t === "vis" ? t.targets.map((x) => [x, inst.has(x) ? inst.visible(x) : true] as const) : []));
      const before = op.ops.map((t) => (t.t === "mark" ? markRuns(inst, t) : []));
      const applied = inst.apply(op.ops);
      if (!applied.length) return { changed, text, inverse, textApplied: [] };
      for (const id of state.blocksOfInstance(op.instance)) text.add(id);
      // Inverses: hide what was inserted, restore visibility, put marks back.
      const inv: TextOp[] = [];
      op.ops.forEach((t, k) => {
        if (t.t === "ins") {
          const { s, c } = parseRun(t.id);
          inv.push({ t: "vis", id: "", targets: t.value.map((_, n) => makeId(s, c + n)), visible: false });
        } else if (t.t === "vis") {
          const show = prev[k]!.filter(([, v]) => v).map(([x]) => x);
          const hide = prev[k]!.filter(([, v]) => !v).map(([x]) => x);
          if (show.length) inv.push({ t: "vis", id: "", targets: show, visible: true });
          if (hide.length) inv.push({ t: "vis", id: "", targets: hide, visible: false });
        } else {
          for (const r of before[k]!) inv.push({ t: "mark", id: "", mark: t.mark, value: r.value, start: { item: r.first, side: "before" }, end: { item: r.last, side: "after" } });
        }
      });
      if (inv.length) inverse.push({ op: "text", instance: op.instance, ops: inv.reverse() });
      return { changed, text, inverse, textApplied: applied };
    }
    case "split": {
      if (state.getBlock(op.newId) && !state.getBlock(op.newId)!.archived) break; // already applied
      // The block holding `at` now: usually `id`, unless a concurrent split or merge moved it.
      let host = state.getBlock(op.id);
      if (op.at) {
        const holds = (b: Block | undefined) => !!b && !b.archived && segments(state, b).some((s) => s.inst.has(op.at!) && within(s, op.at!));
        if (!holds(host)) {
          const inst = findInstance(state, host, op.at);
          const other = inst ? state.blocksOfInstance(inst).map((id) => state.getBlock(id)).find(holds) : undefined;
          host = other ?? host;
        }
      }
      if (!host || host.archived || !host.parent_id) throw new OpError(`no block ${op.id}`);
      const segs = segments(state, host);
      const keep: Slice[] = [];
      const tail: Slice[] = [];
      let cut = false;
      for (const s of segs) {
        if (cut) {
          tail.push(s.slice);
          continue;
        }
        if (op.at && s.inst.has(op.at) && within(s, op.at)) {
          cut = true;
          const idx = s.inst.indexOf(op.at);
          if (idx > s.lo || s.slice.from === null) keep.push({ ...s.slice, to: op.at });
          tail.push({ ...s.slice, from: op.at });
        } else keep.push(s.slice);
      }
      const oldText = host.text ?? null;
      state.putBlock(touch(state, { ...host, text: keep.length ? keep : ownSlice(segs[0]?.slice.i ?? op.newInstance) }));
      changed.add(host.id);
      text.add(host.id);
      const created = applyOp(state, {
        op: "create",
        id: op.newId,
        type: op.type,
        parent: host.parent_id,
        after: host.id,
        properties: op.properties,
        text: [...ownSlice(op.newInstance), ...tail],
      });
      created.changed.forEach((x) => changed.add(x));
      text.add(op.newId);
      inverse.push({ op: "delete", id: op.newId }, { op: "update", id: host.id, text: oldText });
      break;
    }
    case "detach": {
      const b = state.getBlock(op.id);
      if (!b) throw new OpError(`no block ${op.id}`);
      const old = unplace(state, op.id, changed);
      state.putBlock(touch(state, { ...state.getBlock(op.id)!, parent_id: null }));
      changed.add(op.id);
      if (old.parent) inverse.push({ op: "move", id: op.id, parent: old.parent, after: old.after });
      break;
    }
    case "merge": {
      const into = state.getBlock(op.into);
      const from = state.getBlock(op.from);
      if (!into || !from) throw new OpError("merge: missing block");
      if (from.archived) break; // already applied
      const oldText = into.text ?? null;
      state.putBlock(touch(state, { ...into, text: [...(into.text ?? []), ...(from.text ?? [])] }));
      changed.add(into.id);
      text.add(into.id);
      const del = applyOp(state, { op: "delete", id: from.id });
      del.changed.forEach((x) => changed.add(x));
      inverse.push(...del.inverse, { op: "update", id: into.id, text: oldText });
      break;
    }
  }
  return { changed, text, inverse };
}

function parseRun(id: string) {
  const at = id.lastIndexOf("@");
  return { s: id.slice(0, at), c: Number(id.slice(at + 1)) };
}

function within(s: Segment, item: string): boolean {
  const i = s.inst.indexOf(item);
  return i >= s.lo && i < s.hi;
}

function findInstance(state: SyncState, host: Block | undefined, item: string): string | null {
  for (const s of host?.text ?? []) if (state.instance(s.i).has(item)) return s.i;
  return null;
}

/** Current values of a mark over the visible items an op covers, as runs (for undo). */
function markRuns(inst: TextInstance, op: Extract<TextOp, { t: "mark" }>): Array<{ first: string; last: string; value: MarkValue }> {
  if ((op.start && !inst.has(op.start.item)) || (op.end && !inst.has(op.end.item))) return [];
  const order = inst.order();
  const lo = op.start ? inst.indexOf(op.start.item) + (op.start.side === "after" ? 1 : 0) : 0;
  const hi = op.end ? inst.indexOf(op.end.item) + (op.end.side === "after" ? 1 : 0) : order.length;
  const piece = inst.read(lo, hi);
  const runs: Array<{ first: string; last: string; value: MarkValue }> = [];
  piece.ids.forEach((id, n) => {
    const v = (piece.marks[n]![op.mark] ?? null) as MarkValue;
    const last = runs[runs.length - 1];
    if (last && last.value === v) last.last = id;
    else runs.push({ first: id, last: id, value: v });
  });
  return runs;
}

/** Give fresh ids to an inverse's text ops (they're templates until the undo runs). */
export function stampInverse(state: SyncState, clock: Clock, ops: RecordOp[]): RecordOp[] {
  return ops.map((op) =>
    op.op === "text"
      ? { ...op, ops: op.ops.map((t) => ({ ...t, id: t.id || clock.stamp(state.instance(op.instance)) })) }
      : op,
  );
}

export function isTextBlock(b: Block | undefined): boolean {
  return !!b && TEXT_TYPES.has(b.type) && !!b.text;
}
