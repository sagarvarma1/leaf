/**
 * Conversion between a page's collaborative document (a Yjs XmlFragment in the shape
 * y-prosemirror produces for Leaf's editor schema) and Leaf's block model.
 *
 *   projectFragment()  Y doc  -> blocks   (server runs this after edits: the "projection")
 *   hydrateFragment()  blocks -> Y doc    (seed data, REST appends, import)
 *
 * Editor node -> block type:
 *   paragraph -> paragraph          heading{level}   -> heading_1..3
 *   bulletList>listItem -> bulleted_list_item (list containers are flattened: in the
 *   orderedList>listItem -> numbered_list_item  block model every list item is a block,
 *   taskList>taskItem{checked} -> to_do         exactly like Notion)
 *   toggle{open} -> toggle (first paragraph = summary, rest = children)
 *   blockquote -> quote   callout{emoji} -> callout   codeBlock{language} -> code
 *   horizontalRule -> divider   image{src,alt} -> image
 *   pageLink{pageId} -> the child page block itself (if the page's parent is this page)
 *                       or a link_to_page block
 *   database{databaseId} -> the database block itself (child database)
 *   nest -> children of any block. The first child (paragraph, heading or callout) is the
 *           block itself and keeps its own id; the remaining children become its `content`.
 *           ProseMirror text blocks can't hold blocks, so the wrapper carries them.
 *   columnList > column{width} -> column_list > column (Notion's API shape)
 *   syncedBlock{syncId} -> synced_block { synced_from }. The synced content lives in its
 *           own Yjs document (the container block `syncId`), shared by every instance.
 */
import * as Y from "yjs";
import { attributesToMarks, marksToAttributes, normalizeRichText, plainText } from "./richtext.js";
import type { BlockInput, ContentBlockType, ProjectedBlock, RichText } from "./types.js";

export const newId = (): string => globalThis.crypto.randomUUID();

/** Editor nodes that are blocks and therefore carry a stable `blockId` attribute. */
export const ID_NODES = new Set([
  "paragraph",
  "heading",
  "listItem",
  "taskItem",
  "toggle",
  "blockquote",
  "callout",
  "codeBlock",
  "horizontalRule",
  "image",
  "pageLink",
  "columnList",
  "column",
  "syncedBlock",
]);

/** Block nodes that can own children through a `nest` wrapper. */
export const NESTABLE = new Set(["paragraph", "heading", "callout"]);

const LIST_CONTAINERS: Record<string, { item: string; type: ContentBlockType }> = {
  bulletList: { item: "listItem", type: "bulleted_list_item" },
  orderedList: { item: "listItem", type: "numbered_list_item" },
  taskList: { item: "taskItem", type: "to_do" },
};
const NESTABLE_TYPES = new Set(["paragraph", "heading_1", "heading_2", "heading_3", "callout"]);
const LIST_FOR_TYPE: Record<string, string> = {
  bulleted_list_item: "bulletList",
  numbered_list_item: "orderedList",
  to_do: "taskList",
};

export const FRAGMENT_NAME = "default";
export const getFragment = (doc: Y.Doc) => doc.getXmlFragment(FRAGMENT_NAME);

const elements = (parent: Y.XmlFragment | Y.XmlElement): Y.XmlElement[] =>
  parent.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement);

// ---------------------------------------------------------------- rich text

export function richTextOf(el: Y.XmlElement | undefined): RichText {
  if (!el) return [];
  const runs: RichText = [];
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta() as Array<{ insert: unknown; attributes?: Record<string, any> }>) {
        if (typeof op.insert !== "string") continue;
        const marks = attributesToMarks(op.attributes);
        runs.push(marks ? { text: op.insert, marks } : { text: op.insert });
      }
    } else if (child instanceof Y.XmlElement) {
      if (child.nodeName === "mention") {
        const kind = (child.getAttribute("kind") as string) === "user" ? "user" : "page";
        const id = String(child.getAttribute("id") ?? "");
        const label = String(child.getAttribute("label") ?? "");
        runs.push({ text: (kind === "user" ? "@" : "") + label, mention: { type: kind, id } });
      } else if (child.nodeName === "hardBreak") {
        runs.push({ text: "\n" });
      } else {
        runs.push({ text: plainText(richTextOf(child)) });
      }
    }
  }
  return normalizeRichText(runs);
}

function fillRichText(el: Y.XmlElement, runs: RichText | undefined) {
  const nodes: Array<Y.XmlText | Y.XmlElement> = [];
  let text: Y.XmlText | null = null;
  let offset = 0;
  for (const run of runs ?? []) {
    if (run.mention) {
      text = null;
      const m = new Y.XmlElement("mention");
      m.setAttribute("kind", run.mention.type);
      m.setAttribute("id", run.mention.id);
      m.setAttribute("label", run.mention.type === "user" ? run.text.replace(/^@/, "") : run.text);
      nodes.push(m);
      continue;
    }
    if (!run.text) continue;
    if (!text) {
      text = new Y.XmlText();
      offset = 0;
      nodes.push(text);
    }
    // Always pass attributes: Y.Text otherwise inherits the formatting of the previous run.
    text.insert(offset, run.text, marksToAttributes(run.marks) ?? {});
    offset += run.text.length;
  }
  if (nodes.length) el.insert(0, nodes);
}

// ---------------------------------------------------------------- ids

/**
 * Give every block node a unique `blockId`. Clients do this too (an editor plugin), but
 * the server is the backstop: splitting a node copies its attributes, and two offline
 * clients can mint the same structure, so duplicates are re-keyed here.
 * `isForeign` lets the server re-key ids that already belong to another page (a block
 * copy-pasted across pages keeps its attributes).
 * Must be called inside a transaction to batch the writes. Returns the number of fixes.
 */
export function ensureBlockIds(fragment: Y.XmlFragment, isForeign?: (id: string) => boolean): number {
  const seen = new Set<string>();
  let fixed = 0;
  const walk = (parent: Y.XmlFragment | Y.XmlElement) => {
    for (const el of elements(parent)) {
      if (ID_NODES.has(el.nodeName)) {
        const id = el.getAttribute("blockId") as string | undefined;
        if (!id || seen.has(id) || isForeign?.(id)) {
          const fresh = newId();
          el.setAttribute("blockId", fresh);
          seen.add(fresh);
          fixed++;
        } else seen.add(id);
      }
      walk(el);
    }
  };
  walk(fragment);
  return fixed;
}

// ---------------------------------------------------------------- projection: Y -> blocks

export interface ProjectionContext {
  /** True when `pageId` is a page whose parent is the page being projected. */
  isChildPage?: (pageId: string) => boolean;
}

export interface Projection {
  title: string;
  /** Ordered ids of the page's top-level children (its `content` array). */
  content: string[];
  /** Every content block the document contains, at any depth. */
  blocks: ProjectedBlock[];
  /** Child pages referenced from the document (in order). */
  childPages: string[];
  /** Pages linked (not owned) from the document. */
  linkedPages: string[];
  /** Child databases embedded in the document. */
  databases: string[];
  /** Synced block containers referenced from the document. */
  syncedBlocks: string[];
  /** Plain text of the whole page, for search. */
  text: string;
}

export function projectFragment(fragment: Y.XmlFragment, pageId: string, ctx: ProjectionContext = {}): Projection {
  const out: Projection = { title: "", content: [], blocks: [], childPages: [], linkedPages: [], databases: [], syncedBlocks: [], text: "" };
  const textParts: string[] = [];
  const idOf = (el: Y.XmlElement) => (el.getAttribute("blockId") as string | undefined) ?? newId();

  const push = (b: ProjectedBlock, text?: string) => {
    out.blocks.push(b);
    if (text) textParts.push(text);
    return b.id;
  };

  /** Rich text from the first child paragraph, remaining children as nested blocks. */
  const summaryAndChildren = (el: Y.XmlElement, id: string) => {
    const kids = elements(el);
    const first = kids[0];
    if (first && first.nodeName === "paragraph") {
      return { rich_text: richTextOf(first), children: walk(kids.slice(1), id) };
    }
    return { rich_text: [] as RichText, children: walk(kids, id) };
  };

  const walk = (els: Y.XmlElement[], parentId: string): string[] => {
    const ids: string[] = [];
    for (const el of els) {
      const name = el.nodeName;
      if (name === "title") continue;
      const list = LIST_CONTAINERS[name];
      if (list) {
        for (const item of elements(el)) {
          const id = idOf(item);
          const { rich_text, children } = summaryAndChildren(item, id);
          const properties: Record<string, any> = { rich_text };
          if (list.type === "to_do") properties.checked = Boolean(item.getAttribute("checked"));
          ids.push(push({ id, type: list.type, parent_id: parentId, properties, content: children }, plainText(rich_text)));
        }
        continue;
      }
      if (name === "nest") {
        const [first, ...rest] = elements(el);
        if (!first) continue;
        const before = out.blocks.length;
        const [id] = walk([first], parentId);
        if (!id) continue;
        ids.push(id);
        const self = out.blocks.slice(before).find((b) => b.id === id);
        const children = walk(rest, id);
        if (self) self.content = [...self.content, ...children];
        continue;
      }
      if (name === "database") {
        const dbId = String(el.getAttribute("databaseId") ?? "");
        if (dbId) {
          out.databases.push(dbId);
          ids.push(dbId);
        }
        continue;
      }
      if (name === "pageLink") {
        const target = String(el.getAttribute("pageId") ?? "");
        if (!target) continue;
        if (ctx.isChildPage?.(target)) {
          out.childPages.push(target);
          ids.push(target);
        } else {
          out.linkedPages.push(target);
          ids.push(push({ id: idOf(el), type: "link_to_page", parent_id: parentId, properties: { page_id: target }, content: [] }));
        }
        continue;
      }
      const id = idOf(el);
      switch (name) {
        case "paragraph": {
          const rich_text = richTextOf(el);
          ids.push(push({ id, type: "paragraph", parent_id: parentId, properties: { rich_text }, content: [] }, plainText(rich_text)));
          break;
        }
        case "heading": {
          const level = Math.min(3, Math.max(1, Number(el.getAttribute("level") ?? 1)));
          const rich_text = richTextOf(el);
          const type = `heading_${level}` as ContentBlockType;
          ids.push(push({ id, type, parent_id: parentId, properties: { rich_text }, content: [] }, plainText(rich_text)));
          break;
        }
        case "toggle":
        case "blockquote": {
          const { rich_text, children } = summaryAndChildren(el, id);
          const properties: Record<string, any> = { rich_text };
          if (name === "toggle") properties.open = Boolean(el.getAttribute("open"));
          const type = name === "toggle" ? "toggle" : "quote";
          ids.push(push({ id, type, parent_id: parentId, properties, content: children }, plainText(rich_text)));
          break;
        }
        case "callout": {
          const rich_text = richTextOf(el);
          const icon = String(el.getAttribute("emoji") ?? "💡");
          ids.push(push({ id, type: "callout", parent_id: parentId, properties: { rich_text, icon }, content: [] }, plainText(rich_text)));
          break;
        }
        case "codeBlock": {
          const rich_text = [{ text: plainText(richTextOf(el)) }].filter((r) => r.text);
          const language = String(el.getAttribute("language") ?? "plain");
          ids.push(push({ id, type: "code", parent_id: parentId, properties: { rich_text, language }, content: [] }, plainText(rich_text)));
          break;
        }
        case "horizontalRule":
          ids.push(push({ id, type: "divider", parent_id: parentId, properties: {}, content: [] }));
          break;
        case "columnList": {
          const b = push({ id, type: "column_list", parent_id: parentId, properties: {}, content: [] });
          const self = out.blocks[out.blocks.length - 1]!;
          self.content = walk(elements(el), b);
          ids.push(b);
          break;
        }
        case "column": {
          const width = Number(el.getAttribute("width") ?? 1) || 1;
          const b = push({ id, type: "column", parent_id: parentId, properties: { width }, content: [] });
          const self = out.blocks[out.blocks.length - 1]!;
          self.content = walk(elements(el), b);
          ids.push(b);
          break;
        }
        case "syncedBlock": {
          const from = String(el.getAttribute("syncId") ?? "");
          if (!from) break;
          out.syncedBlocks.push(from);
          ids.push(push({ id, type: "synced_block", parent_id: parentId, properties: { synced_from: from }, content: [] }));
          break;
        }
        case "image": {
          const url = String(el.getAttribute("src") ?? "");
          const caption = String(el.getAttribute("alt") ?? "");
          ids.push(push({ id, type: "image", parent_id: parentId, properties: { url, caption }, content: [] }, caption));
          break;
        }
        default: {
          // Unknown node: keep its text rather than dropping user content.
          const rich_text = richTextOf(el);
          ids.push(push({ id, type: "paragraph", parent_id: parentId, properties: { rich_text }, content: [] }, plainText(rich_text)));
        }
      }
    }
    return ids;
  };

  const top = elements(fragment);
  const titleEl = top.find((e) => e.nodeName === "title");
  out.title = plainText(richTextOf(titleEl)).trim();
  out.content = walk(top, pageId);
  out.text = textParts.join("\n");
  return out;
}

// ---------------------------------------------------------------- hydration: blocks -> Y

function itemElement(block: BlockInput, itemName: string): Y.XmlElement {
  const item = new Y.XmlElement(itemName);
  item.setAttribute("blockId", block.id ?? newId());
  if (itemName === "taskItem") item.setAttribute("checked", Boolean(block.properties?.checked) as any);
  const p = new Y.XmlElement("paragraph");
  p.setAttribute("blockId", newId());
  fillRichText(p, block.properties?.rich_text);
  item.insert(0, [p, ...buildSequence(block.children ?? [])]);
  return item;
}

function blockElement(block: BlockInput): Y.XmlElement {
  if (block.children?.length && NESTABLE_TYPES.has(block.type)) {
    // Children of a text block: wrap the block and its children in a nest.
    const nest = new Y.XmlElement("nest");
    nest.insert(0, [blockElement({ ...block, children: undefined }), ...buildSequence(block.children)]);
    return nest;
  }
  const props = block.properties ?? {};
  const id = block.id ?? newId();
  const withId = (name: string) => {
    const el = new Y.XmlElement(name);
    el.setAttribute("blockId", id);
    return el;
  };
  switch (block.type) {
    case "heading_1":
    case "heading_2":
    case "heading_3": {
      const el = withId("heading");
      el.setAttribute("level", Number(block.type.slice(-1)) as any);
      fillRichText(el, props.rich_text);
      return el;
    }
    case "toggle":
    case "quote": {
      const el = withId(block.type === "toggle" ? "toggle" : "blockquote");
      if (block.type === "toggle") el.setAttribute("open", Boolean(props.open) as any);
      const p = new Y.XmlElement("paragraph");
      p.setAttribute("blockId", newId());
      fillRichText(p, props.rich_text);
      el.insert(0, [p, ...buildSequence(block.children ?? [])]);
      return el;
    }
    case "callout": {
      const el = withId("callout");
      el.setAttribute("emoji", props.icon ?? "💡");
      fillRichText(el, props.rich_text);
      return el;
    }
    case "code": {
      const el = withId("codeBlock");
      el.setAttribute("language", props.language ?? "plain");
      fillRichText(el, [{ text: plainText(props.rich_text) }]);
      return el;
    }
    case "divider":
      return withId("horizontalRule");
    case "image": {
      const el = withId("image");
      el.setAttribute("src", props.url ?? "");
      if (props.caption) el.setAttribute("alt", props.caption);
      return el;
    }
    case "child_page": {
      const el = new Y.XmlElement("pageLink");
      el.setAttribute("blockId", newId());
      el.setAttribute("pageId", id);
      return el;
    }
    case "link_to_page": {
      const el = withId("pageLink");
      el.setAttribute("pageId", props.page_id ?? "");
      return el;
    }
    case "child_database": {
      const el = new Y.XmlElement("database");
      el.setAttribute("databaseId", id);
      return el;
    }
    case "column_list": {
      const el = withId("columnList");
      const cols: BlockInput[] = (block.children ?? []).filter((c) => c.type === "column");
      while (cols.length < 2) cols.push({ type: "column" });
      el.insert(0, cols.map(blockElement));
      return el;
    }
    case "column": {
      const el = withId("column");
      el.setAttribute("width", (Number(props.width) || 1) as any);
      const kids = (block.children ?? []).filter((c) => c.type !== "column" && c.type !== "column_list");
      el.insert(0, buildSequence(kids.length ? kids : [{ type: "paragraph" }]));
      return el;
    }
    case "synced_block": {
      const el = withId("syncedBlock");
      el.setAttribute("syncId", props.synced_from ?? "");
      return el;
    }
    case "paragraph":
    default: {
      const el = withId("paragraph");
      fillRichText(el, props.rich_text);
      return el;
    }
  }
}

/** Build editor elements for a sequence of blocks, regrouping list items into lists. */
export function buildSequence(blocks: BlockInput[]): Y.XmlElement[] {
  const out: Y.XmlElement[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i]!;
    const listName = LIST_FOR_TYPE[b.type];
    if (listName) {
      const list = new Y.XmlElement(listName);
      const items: Y.XmlElement[] = [];
      while (i < blocks.length && blocks[i]!.type === b.type) {
        items.push(itemElement(blocks[i]!, listName === "taskList" ? "taskItem" : "listItem"));
        i++;
      }
      list.insert(0, items);
      out.push(list);
      continue;
    }
    out.push(blockElement(b));
    i++;
  }
  return out;
}

function titleElement(title: string): Y.XmlElement {
  const el = new Y.XmlElement("title");
  if (title) el.insert(0, [new Y.XmlText(title)]);
  return el;
}

/**
 * Replace the fragment's contents with a title and the given blocks. A null title builds
 * a document without one (synced block containers).
 */
export function hydrateFragment(fragment: Y.XmlFragment, title: string | null, blocks: BlockInput[]) {
  const doc = fragment.doc;
  const run = () => {
    if (fragment.length) fragment.delete(0, fragment.length);
    const body = buildSequence(blocks.length ? blocks : [{ type: "paragraph" }]);
    fragment.insert(0, title === null ? body : [titleElement(title), ...body]);
  };
  doc ? doc.transact(run, "server") : run();
}

/** Set the page title (used by rename from the sidebar / database cells). */
export function setTitle(fragment: Y.XmlFragment, title: string) {
  const first = elements(fragment)[0];
  if (first && first.nodeName === "title") {
    if (first.length) first.delete(0, first.length);
    if (title) first.insert(0, [new Y.XmlText(title)]);
  } else {
    fragment.insert(0, [titleElement(title)]);
  }
}

export function appendBlocks(fragment: Y.XmlFragment, blocks: BlockInput[], afterBlockId?: string | null) {
  const els = buildSequence(blocks);
  if (afterBlockId) {
    const top = fragment.toArray();
    const idx = top.findIndex((c) => c instanceof Y.XmlElement && (c.getAttribute("blockId") === afterBlockId || containsBlock(c, afterBlockId)));
    if (idx >= 0) {
      fragment.insert(idx + 1, els);
      return;
    }
  }
  fragment.insert(fragment.length, els);
}

function containsBlock(el: Y.XmlElement, blockId: string): boolean {
  return elements(el).some((k) => k.getAttribute("blockId") === blockId || containsBlock(k, blockId));
}

/** Remove every pageLink pointing at `pageId` (any depth). Returns how many were removed. */
export function removePageLinks(fragment: Y.XmlFragment, pageId: string): number {
  let removed = 0;
  const walk = (parent: Y.XmlFragment | Y.XmlElement) => {
    const kids = parent.toArray();
    for (let i = kids.length - 1; i >= 0; i--) {
      const k = kids[i];
      if (!(k instanceof Y.XmlElement)) continue;
      if (k.nodeName === "pageLink" && k.getAttribute("pageId") === pageId) {
        parent.delete(i, 1);
        removed++;
      } else walk(k);
    }
  };
  walk(fragment);
  return removed;
}

export function hasPageLink(fragment: Y.XmlFragment, pageId: string): boolean {
  let found = false;
  const walk = (parent: Y.XmlFragment | Y.XmlElement) => {
    for (const k of elements(parent)) {
      if (found) return;
      if (k.nodeName === "pageLink" && k.getAttribute("pageId") === pageId) found = true;
      else walk(k);
    }
  };
  walk(fragment);
  return found;
}

/** Delete a block (by blockId, any depth). */
export function deleteBlock(fragment: Y.XmlFragment, blockId: string): boolean {
  const walk = (parent: Y.XmlFragment | Y.XmlElement): boolean => {
    const kids = parent.toArray();
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (!(k instanceof Y.XmlElement)) continue;
      if (k.getAttribute("blockId") === blockId) {
        // The head of a nest is the block that owns the nest's children: delete them all.
        if ((parent as Y.XmlElement).nodeName === "nest" && i === 0 && parent.parent) {
          const gp = parent.parent as Y.XmlElement | Y.XmlFragment;
          gp.delete(gp.toArray().indexOf(parent as Y.XmlElement), 1);
          return true;
        }
        // Deleting the only item of a list removes the list too.
        if (LIST_CONTAINERS[(parent as Y.XmlElement).nodeName ?? ""] && parent.length === 1 && parent.parent) {
          const gp = parent.parent as Y.XmlElement | Y.XmlFragment;
          const idx = gp.toArray().indexOf(parent as Y.XmlElement);
          gp.delete(idx, 1);
        } else parent.delete(i, 1);
        return true;
      }
      if (walk(k)) return true;
    }
    return false;
  };
  return walk(fragment);
}

/** Replace a block's rich text (paragraph-like blocks only). */
export function setBlockText(fragment: Y.XmlFragment, blockId: string, runs: RichText): boolean {
  let target: Y.XmlElement | null = null;
  const walk = (parent: Y.XmlFragment | Y.XmlElement) => {
    for (const k of elements(parent)) {
      if (target) return;
      if (k.getAttribute("blockId") === blockId) target = k;
      else walk(k);
    }
  };
  walk(fragment);
  if (!target) return false;
  let el: Y.XmlElement = target;
  const first = elements(el)[0];
  if (["listItem", "taskItem", "toggle", "blockquote"].includes(el.nodeName) && first) el = first;
  if (el.length) el.delete(0, el.length);
  fillRichText(el, runs);
  return true;
}

/** Replace the live fragment's content with a deep copy of another fragment (version restore). */
export function replaceFragment(target: Y.XmlFragment, source: Y.XmlFragment) {
  const copies = source.toArray().map((c) => (c as Y.XmlElement | Y.XmlText).clone());
  if (target.length) target.delete(0, target.length);
  target.insert(0, copies as Array<Y.XmlElement | Y.XmlText>);
}

/** Every blockId present in the fragment. */
export function collectBlockIds(fragment: Y.XmlFragment): string[] {
  const ids: string[] = [];
  const walk = (parent: Y.XmlFragment | Y.XmlElement) => {
    for (const el of elements(parent)) {
      const id = el.getAttribute("blockId");
      if (typeof id === "string") ids.push(id);
      walk(el);
    }
  };
  walk(fragment);
  return ids;
}
