/**
 * Turning an edit into operations.
 *
 * The editor reports the document it wants (see pm.ts `fromPM`); `commitDesired` compares
 * it with the records and emits the operations that get there, applying each one as it
 * goes so later steps see its effect:
 *
 *   1. title text
 *   2. merges   a text block vanished and the block before it now ends with its text
 *               (Backspace at the start of a block)  -> merge, so concurrent typing in
 *               the removed block still shows up
 *   3. splits   a new text block starts with text the block before it lost
 *               (Enter in the middle of a block)     -> split, so concurrent typing in
 *               the tail follows it into the new block
 *   4. placement: create missing blocks, move blocks whose parent or position changed
 *   5. delete blocks that are gone (child pages and databases go to the trash)
 *   6. type and property changes
 *   7. text: one delete + one insert per block around the common prefix / suffix, then
 *      formatting fixed up per mark
 */
import type { Block, BlockInput, BlockType } from "../types.js";
import type { Desired, DesiredBlock } from "./pm.js";
import { fromRichText, readText, setTextOps, TEXT_TYPES, type Clock, type RecordOp, type SyncState } from "./records.js";
import { sameUnit, type Unit } from "./text.js";

const kidsOf = (state: SyncState, b: Block | undefined) => (b?.content ?? []).map((id) => state.getBlock(id)).filter((c): c is Block => !!c && !c.archived);

/** Blocks currently in a document, in pre-order (child pages / databases as leaves). */
export function docBlocks(state: SyncState, rootId: string): Block[] {
  const out: Block[] = [];
  const walk = (b: Block | undefined) => {
    for (const c of kidsOf(state, b)) {
      out.push(c);
      if (c.type !== "page" && c.type !== "database") walk(c);
    }
  };
  walk(state.getBlock(rootId));
  return out;
}

const sameUnits = (a: Unit[], b: Unit[]) => a.length === b.length && a.every((u, i) => sameUnit(u, b[i]!));
const startsWith = (a: Unit[], prefix: Unit[]) => prefix.length <= a.length && prefix.every((u, i) => sameUnit(u, a[i]!));
const isText = (t: BlockType) => TEXT_TYPES.has(t) && t !== "page";
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** What the editor shows when a property isn't set; equal to "unset" when diffing. */
const DEFAULTS: Record<string, Record<string, unknown>> = {
  toggle: { open: true },
  column: { width: 1 },
  callout: { icon: "💡" },
  code: { language: "plain" },
  to_do: { checked: false },
  image: { caption: "" },
};

export function commitDesired(state: SyncState, clock: Clock, desired: Desired, apply: (op: RecordOp) => void) {
  const root = desired.rootId;
  const exists = (id: string) => {
    const b = state.getBlock(id);
    return !!b && !b.archived;
  };
  const units = (id: string) => readText(state, state.getBlock(id)!).units;

  // 1. Title.
  if (desired.title && state.getBlock(root)?.text) setTextOps(state, clock, root, desired.title.units, desired.title.marks, apply);

  const order = [...desired.blocks.values()];
  const textBlocks = order.filter((d) => d.kind === "block" && isText(d.type) && d.units);

  // 2. Merges.
  const before = docBlocks(state, root);
  const beforeText = before.filter((b) => isText(b.type) && b.text);
  for (let k = 0; k < beforeText.length; k++) {
    const gone = beforeText[k]!;
    if (desired.blocks.has(gone.id)) continue;
    let prev: Block | undefined;
    for (let j = k - 1; j >= 0; j--) {
      if (desired.blocks.has(beforeText[j]!.id) && exists(beforeText[j]!.id)) {
        prev = beforeText[j];
        break;
      }
    }
    const want = prev && desired.blocks.get(prev.id)?.units;
    if (!prev || !want) continue;
    const joined = [...units(prev.id), ...units(gone.id)];
    if (units(gone.id).length && sameUnits(want, joined)) apply({ op: "merge", into: prev.id, from: gone.id });
  }

  // 3. Splits.
  for (let k = 0; k < textBlocks.length; k++) {
    const d = textBlocks[k]!;
    if (state.getBlock(d.id)) continue;
    let prev: DesiredBlock | undefined;
    for (let j = k - 1; j >= 0; j--) {
      if (exists(textBlocks[j]!.id)) {
        prev = textBlocks[j];
        break;
      }
    }
    if (!prev) continue;
    const cur = readText(state, state.getBlock(prev.id)!);
    const keep = prev.units!;
    if (cur.units.length <= keep.length || !startsWith(cur.units, keep)) continue;
    const tail = cur.units.slice(keep.length);
    if (!startsWith(d.units!, tail)) continue;
    apply({ op: "split", id: prev.id, at: cur.ids[keep.length]!, newId: d.id, newInstance: d.id, type: d.type, properties: d.props });
  }

  // 4. Placement, top-down.
  const place = (parent: string, content: string[]) => {
    content.forEach((id, i) => {
      const d = desired.blocks.get(id)!;
      const after = i > 0 ? content[i - 1]! : null;
      const b = state.getBlock(id);
      if (!b || b.archived) {
        if (d.kind === "ref") {
          if (b) apply({ op: "restore", id, parent, after });
          return;
        }
        if (b) apply({ op: "restore", id, parent, after });
        else apply({ op: "create", id, type: d.type, parent, after, properties: d.props, text: null });
        return;
      }
      const container = state.getBlock(parent)!;
      const placed = container.content.filter((c) => desired.blocks.has(c) && exists(c));
      if (placed[i] !== id) apply({ op: "move", id, parent, after });
    });
    for (const id of content) {
      const d = desired.blocks.get(id)!;
      if (d.kind === "block") place(id, d.content);
    }
  };
  place(root, desired.content);

  // 5. Deletes.
  for (const b of docBlocks(state, root)) if (!desired.blocks.has(b.id)) apply({ op: "delete", id: b.id });

  // 6. Type and properties.
  for (const d of order) {
    if (d.kind !== "block") continue;
    const b = state.getBlock(d.id);
    if (!b) continue;
    const props: Record<string, any> = {};
    for (const [k, v] of Object.entries(d.props)) if (!same(b.properties[k] ?? DEFAULTS[d.type]?.[k], v)) props[k] = v;
    const op: Extract<RecordOp, { op: "update" }> = { op: "update", id: d.id };
    if (b.type !== d.type) op.type = d.type;
    if (Object.keys(props).length) op.properties = props;
    if (isText(d.type) && !b.text) op.text = [{ i: d.id, from: null, to: null }];
    if (op.type || op.properties || op.text) apply(op);
  }

  // 7. Text.
  for (const d of textBlocks) {
    if (!exists(d.id)) continue;
    setTextOps(state, clock, d.id, d.units!, d.marks!, apply);
  }
}

/**
 * Ops that create a tree of blocks (seed data, imports, REST appends, the AI) under
 * `parent`, after `after`. Child pages / databases in the input must already exist; they
 * are moved into place.
 */
export function createBlocks(state: SyncState, clock: Clock, parent: string, after: string | null, inputs: BlockInput[], apply: (op: RecordOp) => void): string[] {
  const ids: string[] = [];
  let prev = after;
  for (const input of inputs) {
    if (input.type === "child_page" || input.type === "child_database") {
      if (!input.id || !state.getBlock(input.id)) continue;
      apply({ op: "move", id: input.id, parent, after: prev });
      ids.push(input.id);
      prev = input.id;
      continue;
    }
    const id = input.id ?? globalThis.crypto.randomUUID();
    const { rich_text, ...props } = input.properties ?? {};
    apply({ op: "create", id, type: input.type, parent, after: prev, properties: props, text: null });
    if (TEXT_TYPES.has(input.type) && rich_text) {
      const { units, marks } = fromRichText(rich_text);
      setTextOps(state, clock, id, units, marks, apply);
    }
    if (input.children?.length) {
      const kids = input.type === "column_list" ? input.children.filter((c) => c.type === "column") : input.children;
      createBlocks(state, clock, id, null, kids, apply);
    } else if (input.type === "column") {
      createBlocks(state, clock, id, null, [{ type: "paragraph" }], apply);
    }
    ids.push(id);
    prev = id;
  }
  return ids;
}

/** Replace a block's text with rich text (renames, REST writes, the AI). */
export function setRichText(state: SyncState, clock: Clock, blockId: string, runs: Parameters<typeof fromRichText>[0], apply: (op: RecordOp) => void) {
  const { units, marks } = fromRichText(runs);
  setTextOps(state, clock, blockId, units, marks, apply);
}
