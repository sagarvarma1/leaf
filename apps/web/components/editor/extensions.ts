"use client";
/**
 * Leaf's editor schema. Every block node maps 1:1 to a block type in the block model
 * (see packages/shared/src/convert.ts) and carries a stable `blockId` attribute.
 */
import { Extension, Node, mergeAttributes, type Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { remoteKey } from "./sync-binding";

export const ID_TYPES = [
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
];

const uuid = () => crypto.randomUUID();

/** Document = page title followed by at least one block. Columns live in the "layout" group. */
export const LeafDocument = Document.extend({ content: "title (block | layout)+" });
/** A synced block's own document: blocks only, no title. */
export const SyncedDocument = Document.extend({ content: "(block | layout)+" });

/*
 * Schema rule for the nodes below: content expressions stay loose. The editor document is
 * rendered from records that concurrent edits can leave in any shape (a nest with one
 * child, a single column), so the schema accepts those; they're tidied only by the local
 * user's own edits (normalizeLayout).
 */

/**
 * Children of any block. The first child (paragraph, heading or callout) is the block
 * itself; the rest are its children, indented under it. Mirrors how list items and
 * toggles already hold children.
 */
export const Nest = Node.create({
  name: "nest",
  group: "block",
  content: "block+",
  defining: true,
  parseHTML: () => [{ tag: "div[data-type=nest]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "nest", class: "nest" }), 0],
});

export const ColumnList = Node.create({
  name: "columnList",
  group: "layout",
  content: "column+",
  defining: true,
  isolating: true,
  parseHTML: () => [{ tag: "div[data-type=column-list]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "column-list", class: "column-list" }), 0],
});

export const Column = Node.create({
  name: "column",
  content: "block+",
  defining: true,
  isolating: true,
  addAttributes() {
    return {
      width: {
        default: 1,
        parseHTML: (el) => Number(el.getAttribute("data-width")) || 1,
        renderHTML: (a) => ({ "data-width": String(a.width) }),
      },
    };
  },
  parseHTML: () => [{ tag: "div[data-type=column]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "column", class: "column" }), 0],
  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = document.createElement("div");
      dom.className = "column";
      dom.dataset.type = "column";
      const resizer = document.createElement("div");
      resizer.className = "column-resizer";
      resizer.contentEditable = "false";
      const content = document.createElement("div");
      content.className = "column-content";
      dom.append(resizer, content);
      const render = () => {
        dom.style.flexGrow = String(current.attrs.width || 1);
        if (current.attrs.blockId) dom.dataset.blockId = current.attrs.blockId;
      };
      // Drag the gap between two columns: re-split their widths, commit on release.
      resizer.addEventListener("mousedown", (e) => {
        if (!editor.isEditable || typeof getPos !== "function") return;
        const prev = dom.previousElementSibling as HTMLElement | null;
        const pos = getPos();
        const $pos = editor.state.doc.resolve(pos);
        const index = $pos.index();
        if (!prev || index === 0) return;
        e.preventDefault();
        const prevNode = $pos.parent.child(index - 1);
        const prevPos = pos - prevNode.nodeSize;
        const sum = (prevNode.attrs.width || 1) + (current.attrs.width || 1);
        const total = prev.getBoundingClientRect().width + dom.getBoundingClientRect().width;
        const startPrev = prev.getBoundingClientRect().width;
        const startX = e.clientX;
        let w1 = prevNode.attrs.width || 1;
        dom.classList.add("resizing");
        const move = (ev: MouseEvent) => {
          const px = Math.min(total - 80, Math.max(80, startPrev + ev.clientX - startX));
          w1 = Math.round((sum * px * 1000) / total) / 1000;
          prev.style.flexGrow = String(w1);
          dom.style.flexGrow = String(sum - w1);
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          dom.classList.remove("resizing");
          const tr = editor.state.tr.setNodeAttribute(prevPos, "width", w1).setNodeAttribute(pos, "width", Math.round((sum - w1) * 1000) / 1000);
          editor.view.dispatch(tr);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      });
      render();
      return {
        dom,
        contentDOM: content,
        update: (n) => {
          if (n.type.name !== "column") return false;
          current = n;
          render();
          return true;
        },
        ignoreMutation: (m) => m.target === resizer || (m.type === "attributes" && m.target === dom),
        stopEvent: (e) => e.target === resizer,
      };
    };
  },
});

const HEADS = new Set(["paragraph", "heading", "callout"]);

/**
 * Tidy layout wrappers after a local structural edit: unwrap a nest left with one child
 * (or without a text block at its head), unwrap a column list left with one column, and
 * drop the column a block was dragged out of if that left it empty.
 */
export function normalizeLayout(tr: Transaction, opts: { prunedColumn?: string | null } = {}): Transaction {
  const targets: Array<{ pos: number; node: PMNode }> = [];
  tr.doc.descendants((node, pos) => {
    if (node.type.name === "nest" || node.type.name === "columnList") targets.push({ pos, node });
    return true;
  });
  // Deepest / last first, so earlier positions stay valid.
  for (const { pos, node } of targets.reverse()) {
    if (node.type.name === "nest") {
      if (node.childCount === 1 || !HEADS.has(node.firstChild!.type.name)) tr.replaceWith(pos, pos + node.nodeSize, node.content);
      continue;
    }
    const keep: PMNode[] = [];
    node.forEach((col) => {
      const empty = col.childCount === 1 && col.firstChild!.type.name === "paragraph" && col.firstChild!.content.size === 0;
      if (!(empty && opts.prunedColumn && col.attrs.blockId === opts.prunedColumn)) keep.push(col);
    });
    if (keep.length === 1) tr.replaceWith(pos, pos + node.nodeSize, keep[0]!.content);
    else if (keep.length !== node.childCount) tr.replaceWith(pos, pos + node.nodeSize, node.type.create(node.attrs, keep));
  }
  return tr;
}

/** The column a dragged block came from (set by the drag handle), pruned if left empty. */
export const dragState: { sourceColumn: string | null } = { sourceColumn: null };

/** Runs normalizeLayout after local drag-and-drop moves. */
export const LayoutNormalizer = Extension.create({
  name: "layoutNormalizer",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("layoutNormalizer"),
        appendTransaction(trs: readonly Transaction[], _old: EditorState, state: EditorState) {
          if (!trs.some((t) => t.docChanged && t.getMeta("uiEvent") === "drop")) return null;
          const tr = normalizeLayout(state.tr, { prunedColumn: dragState.sourceColumn });
          dragState.sourceColumn = null;
          return tr.docChanged ? tr : null;
        },
      }),
    ];
  },
});

export const Title = Node.create({
  name: "title",
  content: "inline*",
  marks: "",
  defining: true,
  parseHTML: () => [{ tag: "h1.page-title" }],
  renderHTML: ({ HTMLAttributes }) => ["h1", mergeAttributes(HTMLAttributes, { class: "page-title" }), 0],
  addKeyboardShortcuts() {
    const inTitle = (editor: Editor) => editor.state.selection.$from.parent.type.name === "title";
    const toBody = (editor: Editor) => {
      const title = editor.state.doc.firstChild!;
      const sel = TextSelection.near(editor.state.doc.resolve(title.nodeSize + 1));
      editor.view.dispatch(editor.state.tr.setSelection(sel).scrollIntoView());
      return true;
    };
    return {
      Enter: ({ editor }) => {
        if (!inTitle(editor)) return false;
        // Enter in the title: open a fresh paragraph at the top of the body.
        const title = editor.state.doc.firstChild!;
        const first = editor.state.doc.child(1);
        if (first.type.name === "paragraph" && first.content.size === 0) return toBody(editor);
        const tr = editor.state.tr.insert(title.nodeSize, editor.schema.nodes.paragraph!.create());
        tr.setSelection(TextSelection.create(tr.doc, title.nodeSize + 1));
        editor.view.dispatch(tr.scrollIntoView());
        return true;
      },
      ArrowDown: ({ editor }) => {
        if (!inTitle(editor)) return false;
        return toBody(editor);
      },
      Backspace: ({ editor }) => {
        // Never merge the first block into the title.
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parentOffset !== 0) return false;
        if ($from.depth === 1 && $from.index(0) === 1) {
          const node = $from.parent;
          if (node.type.name === "paragraph" && node.content.size === 0 && editor.state.doc.childCount > 2) {
            const start = $from.before(1);
            const tr = editor.state.tr.delete(start, start + node.nodeSize);
            tr.setSelection(TextSelection.near(tr.doc.resolve(start - 1), -1));
            editor.view.dispatch(tr);
            return true;
          }
          if (node.type.name !== "paragraph") return editor.commands.setParagraph();
          return true;
        }
        return false;
      },
    };
  },
});

/** Stable block ids: assigned to new nodes, de-duplicated after splits and pastes. */
export const BlockId = Extension.create({
  name: "blockId",
  addGlobalAttributes() {
    return [
      {
        types: ID_TYPES,
        attributes: {
          blockId: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el) => el.getAttribute("data-block-id"),
            renderHTML: (attrs) => (attrs.blockId ? { "data-block-id": attrs.blockId } : {}),
          },
        },
      },
    ];
  },
  addProseMirrorPlugins() {
    const types = new Set(ID_TYPES);
    return [
      new Plugin({
        key: new PluginKey("blockId"),
        appendTransaction(trs: readonly Transaction[], _old: EditorState, state: EditorState) {
          if (!trs.some((t) => t.docChanged)) return null;
          // Remote changes already carry ids; only fix up local edits.
          if (trs.every((t) => t.getMeta(remoteKey))) return null;
          const seen = new Set<string>();
          let tr: Transaction | null = null;
          state.doc.descendants((node: PMNode, pos: number) => {
            if (!types.has(node.type.name)) return true;
            const id = node.attrs.blockId as string | null;
            if (!id || seen.has(id)) {
              tr = tr ?? state.tr;
              tr.setNodeAttribute(pos, "blockId", uuid());
            } else seen.add(id);
            return true;
          });
          if (tr) (tr as Transaction).setMeta("addToHistory", false);
          return tr;
        },
      }),
    ];
  },
});

// Toggle open state is per-viewer (like Notion): kept locally, not in the shared doc.
const toggleOpen = new Map<string, boolean>();

export const Toggle = Node.create({
  name: "toggle",
  group: "block",
  content: "paragraph block*",
  defining: true,
  addAttributes() {
    return { open: { default: true, parseHTML: (el) => el.getAttribute("data-open") !== "false", renderHTML: (a) => ({ "data-open": String(a.open) }) } };
  },
  parseHTML: () => [{ tag: "div[data-type=toggle]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "toggle", class: "toggle" }), 0],
  addNodeView() {
    return ({ node }) => {
      let current = node;
      const dom = document.createElement("div");
      dom.className = "toggle";
      dom.dataset.type = "toggle";
      const btn = document.createElement("button");
      btn.className = "toggle-btn";
      btn.contentEditable = "false";
      btn.type = "button";
      btn.setAttribute("aria-label", "Toggle");
      btn.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      const content = document.createElement("div");
      content.className = "toggle-content";
      dom.append(btn, content);
      const isOpen = () => toggleOpen.get(current.attrs.blockId) ?? Boolean(current.attrs.open);
      const render = () => {
        dom.dataset.open = String(isOpen());
        if (current.attrs.blockId) dom.dataset.blockId = current.attrs.blockId;
      };
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", () => {
        toggleOpen.set(current.attrs.blockId, !isOpen());
        render();
      });
      render();
      return {
        dom,
        contentDOM: content,
        update: (n) => {
          if (n.type.name !== "toggle") return false;
          current = n;
          render();
          return true;
        },
        ignoreMutation: (m) => m.type === "attributes" && m.target === dom,
      };
    };
  },
});

const CALLOUT_EMOJI = ["💡", "⚠️", "🔥", "✅", "📌", "🌿", "❗", "🧠", "🚀", "📣"];

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "inline*",
  defining: true,
  addAttributes() {
    return { emoji: { default: "💡", parseHTML: (el) => el.getAttribute("data-emoji") ?? "💡", renderHTML: (a) => ({ "data-emoji": a.emoji }) } };
  },
  parseHTML: () => [{ tag: "div[data-type=callout]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "callout", class: "callout" }), 0],
  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = document.createElement("div");
      dom.className = "callout";
      const icon = document.createElement("button");
      icon.type = "button";
      icon.className = "callout-emoji";
      icon.contentEditable = "false";
      icon.title = "Change icon";
      const content = document.createElement("div");
      content.className = "callout-text";
      dom.append(icon, content);
      const render = () => {
        icon.textContent = current.attrs.emoji;
        if (current.attrs.blockId) dom.dataset.blockId = current.attrs.blockId;
      };
      icon.addEventListener("mousedown", (e) => e.preventDefault());
      icon.addEventListener("click", () => {
        if (!editor.isEditable || typeof getPos !== "function") return;
        const next = CALLOUT_EMOJI[(CALLOUT_EMOJI.indexOf(current.attrs.emoji) + 1) % CALLOUT_EMOJI.length];
        editor.view.dispatch(editor.state.tr.setNodeAttribute(getPos(), "emoji", next));
      });
      render();
      return {
        dom,
        contentDOM: content,
        update: (n) => {
          if (n.type.name !== "callout") return false;
          current = n;
          render();
          return true;
        },
        ignoreMutation: (m) => m.type === "attributes" && m.target === dom,
      };
    };
  },
});

export const CODE_LANGUAGES = ["plain", "javascript", "typescript", "python", "go", "rust", "java", "c", "cpp", "css", "html", "json", "bash", "sql", "markdown", "yaml"];

/** Adds a language picker to the lowlight code block. */
export function codeBlockNodeView() {
  return ({ node, getPos, editor }: any) => {
    let current = node;
    const dom = document.createElement("div");
    dom.className = "code-block";
    const select = document.createElement("select");
    select.contentEditable = "false";
    select.className = "code-lang";
    for (const l of CODE_LANGUAGES) {
      const o = document.createElement("option");
      o.value = l;
      o.textContent = l === "plain" ? "Plain text" : l;
      select.append(o);
    }
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    pre.append(code);
    dom.append(select, pre);
    const render = () => {
      select.value = CODE_LANGUAGES.includes(current.attrs.language) ? current.attrs.language : "plain";
      code.className = current.attrs.language ? `language-${current.attrs.language}` : "";
      if (current.attrs.blockId) dom.dataset.blockId = current.attrs.blockId;
      select.disabled = !editor.isEditable;
    };
    select.addEventListener("change", () => {
      if (typeof getPos !== "function") return;
      editor.view.dispatch(editor.state.tr.setNodeAttribute(getPos(), "language", select.value));
    });
    render();
    return {
      dom,
      contentDOM: code,
      update: (n: PMNode) => {
        if (n.type.name !== "codeBlock") return false;
        current = n;
        render();
        return true;
      },
      stopEvent: (e: Event) => e.target === select,
      ignoreMutation: (m: any) => m.target === select || m.target === dom || (m.type === "attributes" && m.target === code),
    };
  };
}

/** Tab / Shift-Tab nesting for blocks outside lists (lists use their own sink/lift). */
export const Indent = Extension.create({
  name: "indent",
  priority: 50,
  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => {
        indentBlock(editor);
        return true; // keep focus in the editor
      },
      "Shift-Tab": ({ editor }) => {
        outdentBlock(editor);
        return true;
      },
    };
  },
});

const LISTS = new Set(["bulletList", "orderedList", "taskList"]);
/** Nodes whose children after the first are nested blocks. */
const NESTABLE_PARENTS = new Set(["toggle", "listItem", "taskItem", "blockquote", "nest"]);

/**
 * Tab: make the block at the cursor a child of the block above it, at any depth. Lists
 * nest with their own sink command first; this handles everything else, including
 * giving a plain paragraph, heading or callout children (wrapping it in a nest).
 */
function indentBlock(editor: Editor): boolean {
  const { state } = editor;
  const { $from } = state.selection;
  for (let d = $from.depth; d >= 1; d--) {
    const parent = $from.node(d - 1);
    const index = $from.index(d - 1);
    const pname = parent.type.name;
    const holdsBlocks = pname === "doc" || pname === "column" || (NESTABLE_PARENTS.has(pname) && index > 0);
    if (!holdsBlocks) continue;
    const node = $from.node(d);
    // The block above must be a body block: not the page title, not a toggle summary or
    // list item's own line, and a column's first block has nothing above it.
    if (index < (pname === "column" ? 1 : 2)) return false;
    if (node.type.name === "columnList" || node.type.name === "title") return false;
    if (LISTS.has(node.type.name) && node.childCount > 1) return false;
    const prev = parent.child(index - 1);
    const start = $from.before(d);
    const offset = state.selection.from - start;
    let tr: Transaction;
    let caret: number;
    if (prev.type.name === "toggle" || prev.type.name === "blockquote" || prev.type.name === "nest") {
      const insertPos = start - 1; // end of prev's content
      tr = state.tr.delete(start, start + node.nodeSize).insert(insertPos, node);
      caret = insertPos + offset;
    } else if (LISTS.has(prev.type.name)) {
      const insertPos = start - 2; // end of the last list item's content
      tr = state.tr.delete(start, start + node.nodeSize).insert(insertPos, node);
      caret = insertPos + offset;
    } else if (HEADS.has(prev.type.name)) {
      const prevStart = start - prev.nodeSize;
      const nest = state.schema.nodes.nest!.create(null, [prev, node]);
      tr = state.tr.replaceWith(prevStart, start + node.nodeSize, nest);
      caret = prevStart + 1 + prev.nodeSize + offset;
    } else return false; // code, images, embeds can't have children
    tr.setSelection(TextSelection.near(tr.doc.resolve(caret)));
    editor.view.dispatch(normalizeLayout(tr).scrollIntoView());
    return true;
  }
  return false;
}

/** Shift-Tab: move a nested block one level up, right after the block that held it. */
function outdentBlock(editor: Editor): boolean {
  const { state } = editor;
  const { $from } = state.selection;
  for (let d = $from.depth - 1; d >= 1; d--) {
    const parent = $from.node(d);
    if (!NESTABLE_PARENTS.has(parent.type.name)) continue;
    const idx = $from.index(d);
    if (idx === 0) return false; // the head of a toggle / list item / nest: lists handle it
    const child = parent.child(idx);
    const childStart = $from.before(d + 1);
    const offset = state.selection.from - childStart;
    // A list item's children land after the whole list; anything else right after the parent.
    const target = parent.type.name === "listItem" || parent.type.name === "taskItem" ? $from.after(d - 1) : $from.after(d);
    let tr = state.tr.insert(target, child);
    tr = tr.delete(childStart, childStart + child.nodeSize);
    const mapped = tr.mapping.slice(1).map(target);
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(1, mapped + offset))));
    editor.view.dispatch(normalizeLayout(tr).scrollIntoView());
    return true;
  }
  return false;
}

/** Highlights blocks that have open comment threads. */
export const commentKey = new PluginKey<DecorationSet>("leafComments");
export const CommentMarks = Extension.create({
  name: "commentMarks",
  addProseMirrorPlugins() {
    let ids = new Set<string>();
    const build = (doc: PMNode) => {
      const decos: Decoration[] = [];
      if (ids.size) {
        doc.descendants((node, pos) => {
          if (node.attrs.blockId && ids.has(node.attrs.blockId)) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: "has-comment" }));
          return true;
        });
      }
      return DecorationSet.create(doc, decos);
    };
    return [
      new Plugin({
        key: commentKey,
        state: {
          init: (_, state) => build(state.doc),
          apply: (tr, old) => {
            const next = tr.getMeta(commentKey) as Set<string> | undefined;
            if (next) {
              ids = next;
              return build(tr.doc);
            }
            return tr.docChanged ? build(tr.doc) : old;
          },
        },
        props: { decorations: (state) => commentKey.getState(state) },
      }),
    ];
  },
});
