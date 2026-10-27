/**
 * Records <-> the editor's document (ProseMirror JSON in Leaf's schema).
 *
 *   toPM()    records -> editor doc     (render, and re-render after remote changes)
 *   fromPM()  editor doc -> desired tree (what the user's edit wants the records to be)
 *
 * Editor node -> block type:
 *   paragraph -> paragraph          heading{level}   -> heading_1..3
 *   bulletList>listItem -> bulleted_list_item, orderedList>listItem -> numbered_list_item,
 *   taskList>taskItem{checked} -> to_do (list containers are presentation only)
 *   toggle{open} / blockquote: first paragraph = the block's text, the rest = children
 *   callout{emoji} -> callout   codeBlock{language} -> code   horizontalRule -> divider
 *   image{src,alt} -> image     pageLink{pageId} -> the child page itself, or link_to_page
 *   database{databaseId} -> the child database itself
 *   nest -> children of a paragraph / heading / callout (first child = the block)
 *   columnList > column{width} -> column_list > column
 *   syncedBlock{syncId} -> synced_block { synced_from }
 *
 * Ids the editor needs that aren't blocks are derived, so rendering is deterministic:
 * the text paragraph inside a list item / toggle / quote is `<id>:p`, and the empty
 * paragraph shown in an empty page or column is `<parent>:empty` (typing into it creates
 * that block, so two people doing it at once create the same one).
 */
import type { Block, BlockType } from "../types.js";
import { readText, type SyncState } from "./records.js";
import type { Unit } from "./text.js";

export interface PMNode {
  type: string;
  attrs?: Record<string, any>;
  content?: PMNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, any> }>;
}

const LIST_FOR_TYPE: Record<string, { list: string; item: string }> = {
  bulleted_list_item: { list: "bulletList", item: "listItem" },
  numbered_list_item: { list: "orderedList", item: "listItem" },
  to_do: { list: "taskList", item: "taskItem" },
};
const NESTABLE = new Set<BlockType>(["paragraph", "heading_1", "heading_2", "heading_3", "callout"]);

// ---------------------------------------------------------------- inline content

type Marks = Record<string, true | string>;

function pmMarks(m: Marks | undefined): PMNode["marks"] {
  const out: NonNullable<PMNode["marks"]> = [];
  for (const [k, v] of Object.entries(m ?? {})) {
    if (k === "link") out.push({ type: "link", attrs: { href: String(v), target: "_blank", rel: "noopener noreferrer nofollow", class: null } });
    else if (k === "color") out.push({ type: "textStyle", attrs: { color: String(v) } });
    else out.push({ type: k });
  }
  return out.length ? out : undefined;
}

export function inlineNodes(units: Unit[], marks: Marks[], opts: { code?: boolean; plain?: boolean } = {}): PMNode[] {
  const out: PMNode[] = [];
  let buf = "";
  let bufMarks: Marks | undefined;
  const flush = () => {
    if (!buf) return;
    const node: PMNode = { type: "text", text: buf };
    const m = opts.code || opts.plain ? undefined : pmMarks(bufMarks);
    if (m) node.marks = m;
    out.push(node);
    buf = "";
  };
  units.forEach((u, i) => {
    const m = marks[i];
    if (typeof u !== "string") {
      flush();
      if (opts.plain || opts.code) {
        buf = (u.mention.type === "user" ? "@" : "") + u.mention.label;
        bufMarks = undefined;
        flush();
        return;
      }
      const node: PMNode = { type: "mention", attrs: { id: u.mention.id, label: u.mention.label, kind: u.mention.type } };
      const pm = pmMarks(m);
      if (pm) node.marks = pm;
      out.push(node);
      return;
    }
    if (u === "\n" && !opts.code) {
      flush();
      out.push({ type: "hardBreak" });
      return;
    }
    if (buf && JSON.stringify(m ?? {}) !== JSON.stringify(bufMarks ?? {})) flush();
    if (!buf) bufMarks = m;
    buf += u;
  });
  flush();
  return out;
}

export function inlineUnits(nodes: PMNode[] | undefined): { units: Unit[]; marks: Marks[] } {
  const units: Unit[] = [];
  const marks: Marks[] = [];
  for (const n of nodes ?? []) {
    const m: Marks = {};
    for (const mk of n.marks ?? []) {
      if (mk.type === "link") {
        if (mk.attrs?.href) m.link = String(mk.attrs.href);
      } else if (mk.type === "textStyle") {
        if (mk.attrs?.color) m.color = String(mk.attrs.color);
      } else m[mk.type] = true;
    }
    if (n.type === "text") {
      for (const ch of (n.text ?? "").split("")) {
        units.push(ch);
        marks.push(m);
      }
    } else if (n.type === "mention") {
      const kind = n.attrs?.kind === "page" ? "page" : "user";
      units.push({ mention: { type: kind, id: String(n.attrs?.id ?? ""), label: String(n.attrs?.label ?? "") } });
      marks.push(m);
    } else if (n.type === "hardBreak") {
      units.push("\n");
      marks.push({});
    }
  }
  return { units, marks };
}

// ---------------------------------------------------------------- records -> editor

export function toPM(state: SyncState, rootId: string, opts: { title: boolean }): PMNode {
  const root = state.getBlock(rootId);
  const kids = (b: Block | undefined) => (b?.content ?? []).map((id) => state.getBlock(id)).filter((c): c is Block => !!c && !c.archived);

  const text = (b: Block, o: { code?: boolean; plain?: boolean } = {}) => {
    const t = readText(state, b);
    return inlineNodes(t.units, t.marks, o);
  };
  const para = (id: string, b: Block): PMNode => ({ type: "paragraph", attrs: { blockId: id }, content: text(b) });

  const block = (b: Block): PMNode | null => {
    const p = b.properties;
    const children = kids(b);
    if (children.length && NESTABLE.has(b.type)) {
      const head = block({ ...b, content: [] });
      return head ? { type: "nest", content: [head, ...sequence(children)] } : null;
    }
    switch (b.type) {
      case "paragraph":
        return para(b.id, b);
      case "heading_1":
      case "heading_2":
      case "heading_3":
        return { type: "heading", attrs: { blockId: b.id, level: Number(b.type.slice(-1)) }, content: text(b) };
      case "toggle":
        return { type: "toggle", attrs: { blockId: b.id, open: Boolean(p.open ?? true) }, content: [para(`${b.id}:p`, b), ...sequence(children)] };
      case "quote":
        return { type: "blockquote", attrs: { blockId: b.id }, content: [para(`${b.id}:p`, b), ...sequence(children)] };
      case "callout":
        return { type: "callout", attrs: { blockId: b.id, emoji: p.icon ?? "💡" }, content: text(b) };
      case "code":
        return { type: "codeBlock", attrs: { blockId: b.id, language: p.language ?? "plain" }, content: text(b, { code: true }) };
      case "divider":
        return { type: "horizontalRule", attrs: { blockId: b.id } };
      case "image":
        return { type: "image", attrs: { blockId: b.id, src: p.url ?? "", alt: p.caption || null, title: null } };
      case "page":
        return { type: "pageLink", attrs: { blockId: b.id, pageId: b.id } };
      case "link_to_page":
        return { type: "pageLink", attrs: { blockId: b.id, pageId: p.page_id ?? "" } };
      case "database":
        return { type: "database", attrs: { databaseId: b.id } };
      case "column_list": {
        const cols = children.filter((c) => c.type === "column").map(block).filter((c): c is PMNode => !!c);
        return cols.length ? { type: "columnList", attrs: { blockId: b.id }, content: cols } : null;
      }
      case "column":
        return { type: "column", attrs: { blockId: b.id, width: Number(p.width) || 1 }, content: body(b.id, children) };
      case "synced_block":
        return { type: "syncedBlock", attrs: { blockId: b.id, syncId: p.synced_from ?? "" } };
      default:
        return null;
    }
  };

  const listItem = (b: Block, item: string): PMNode => {
    const attrs: Record<string, any> = { blockId: b.id };
    if (item === "taskItem") attrs.checked = Boolean(b.properties.checked);
    return { type: item, attrs, content: [para(`${b.id}:p`, b), ...sequence(kids(b))] };
  };

  const sequence = (blocks: Block[]): PMNode[] => {
    const out: PMNode[] = [];
    let i = 0;
    while (i < blocks.length) {
      const b = blocks[i]!;
      const list = LIST_FOR_TYPE[b.type];
      if (list) {
        const items: PMNode[] = [];
        while (i < blocks.length && blocks[i]!.type === b.type) items.push(listItem(blocks[i++]!, list.item));
        out.push({ type: list.list, content: items });
        continue;
      }
      const node = block(b);
      if (node) out.push(node);
      i++;
    }
    return out;
  };

  const body = (parentId: string, blocks: Block[]): PMNode[] => {
    const seq = sequence(blocks);
    return seq.length ? seq : [{ type: "paragraph", attrs: { blockId: `${parentId}:empty` } }];
  };

  const content = body(rootId, kids(root));
  if (!opts.title) return { type: "doc", content };
  const titleText = root ? text(root, { plain: true }) : [];
  return { type: "doc", content: [{ type: "title", content: titleText }, ...content] };
}

// ---------------------------------------------------------------- editor -> desired tree

export interface DesiredBlock {
  id: string;
  /** "ref": a child page or database, placed here but edited elsewhere. */
  kind: "block" | "ref";
  type: BlockType;
  parent: string;
  /** Non-text properties this block should have. */
  props: Record<string, any>;
  units?: Unit[];
  marks?: Marks[];
  content: string[];
}

export interface Desired {
  rootId: string;
  /** The page title, when the document has one. */
  title?: { units: Unit[]; marks: Marks[] };
  /** Every block in document order (pre-order), keyed by id. */
  blocks: Map<string, DesiredBlock>;
  /** The root's children. */
  content: string[];
}

export function fromPM(doc: PMNode, rootId: string, opts: { isChildPage?: (id: string) => boolean; isDatabase?: (id: string) => boolean } = {}): Desired {
  const out: Desired = { rootId, blocks: new Map(), content: [] };
  const seen = new Set<string>();
  const fresh = () => globalThis.crypto.randomUUID();
  const idOf = (n: PMNode) => {
    let id = n.attrs?.blockId as string | undefined;
    if (!id || seen.has(id)) id = fresh();
    seen.add(id);
    return id;
  };

  const add = (b: DesiredBlock) => {
    out.blocks.set(b.id, b);
    return b.id;
  };

  const head = (n: PMNode) => {
    const first = n.content?.[0];
    return first && first.type === "paragraph" ? { text: inlineUnits(first.content), rest: n.content!.slice(1) } : { text: { units: [], marks: [] }, rest: n.content ?? [] };
  };

  const walk = (nodes: PMNode[], parent: string): string[] => {
    const ids: string[] = [];
    for (const n of nodes) {
      const list = Object.entries(LIST_FOR_TYPE).find(([, v]) => v.list === n.type);
      if (list) {
        for (const item of n.content ?? []) {
          const id = idOf(item);
          const { text, rest } = head(item);
          const props: Record<string, any> = {};
          if (list[0] === "to_do") props.checked = Boolean(item.attrs?.checked);
          const b: DesiredBlock = { id, kind: "block", type: list[0] as BlockType, parent, props, ...text, content: [] };
          add(b);
          b.content = walk(rest, id);
          ids.push(id);
        }
        continue;
      }
      if (n.type === "nest") {
        const [first, ...rest] = n.content ?? [];
        if (!first) continue;
        const [id] = walk([first], parent);
        if (!id) continue;
        const b = out.blocks.get(id)!;
        b.content = [...b.content, ...walk(rest, id)];
        ids.push(id);
        continue;
      }
      if (n.type === "database") {
        const id = String(n.attrs?.databaseId ?? "");
        if (id && !seen.has(id)) {
          seen.add(id);
          ids.push(add({ id, kind: "ref", type: "database", parent, props: {}, content: [] }));
        }
        continue;
      }
      if (n.type === "pageLink") {
        const target = String(n.attrs?.pageId ?? "");
        if (!target) continue;
        if (opts.isChildPage?.(target) && !seen.has(target)) {
          seen.add(target);
          ids.push(add({ id: target, kind: "ref", type: "page", parent, props: {}, content: [] }));
        } else {
          const id = n.attrs?.blockId === target ? fresh() : idOf(n);
          seen.add(id);
          ids.push(add({ id, kind: "block", type: "link_to_page", parent, props: { page_id: target }, content: [] }));
        }
        continue;
      }
      const id = idOf(n);
      const a = n.attrs ?? {};
      const blk = (type: BlockType, props: Record<string, any> = {}, text?: { units: Unit[]; marks: Marks[] }) => {
        const b: DesiredBlock = { id, kind: "block", type, parent, props, content: [] };
        if (text) Object.assign(b, text);
        add(b);
        return b;
      };
      switch (n.type) {
        case "paragraph":
          blk("paragraph", {}, inlineUnits(n.content));
          break;
        case "heading":
          blk(`heading_${Math.min(3, Math.max(1, Number(a.level ?? 1)))}` as BlockType, {}, inlineUnits(n.content));
          break;
        case "toggle":
        case "blockquote": {
          const { text, rest } = head(n);
          const b = blk(n.type === "toggle" ? "toggle" : "quote", n.type === "toggle" ? { open: Boolean(a.open) } : {}, text);
          b.content = walk(rest, id);
          break;
        }
        case "callout":
          blk("callout", { icon: a.emoji ?? "💡" }, inlineUnits(n.content));
          break;
        case "codeBlock": {
          const t = inlineUnits(n.content);
          blk("code", { language: a.language ?? "plain" }, { units: t.units, marks: t.units.map(() => ({})) });
          break;
        }
        case "horizontalRule":
          blk("divider");
          break;
        case "image":
          blk("image", { url: a.src ?? "", caption: a.alt ?? "" });
          break;
        case "columnList": {
          const b = blk("column_list");
          b.content = walk(n.content ?? [], id);
          break;
        }
        case "column": {
          const b = blk("column", { width: Number(a.width) || 1 });
          b.content = walk(n.content ?? [], id);
          break;
        }
        case "syncedBlock":
          if (a.syncId) blk("synced_block", { synced_from: a.syncId });
          else continue;
          break;
        default:
          // Unknown node: keep its text rather than dropping user content.
          blk("paragraph", {}, inlineUnits(n.content));
      }
      ids.push(id);
    }
    return ids;
  };

  let nodes = doc.content ?? [];
  if (nodes[0]?.type === "title") {
    const t = inlineUnits(nodes[0].content);
    out.title = { units: t.units, marks: t.units.map(() => ({})) };
    nodes = nodes.slice(1);
  }
  out.content = walk(nodes, rootId);
  return out;
}
