"use client";
import { Extension, type Editor, type Range } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { PluginKey, TextSelection } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionOptions, type SuggestionProps } from "@tiptap/suggestion";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api } from "@/lib/api";

export type BlockKind =
  | "paragraph"
  | "h1"
  | "h2"
  | "h3"
  | "bullet"
  | "numbered"
  | "todo"
  | "toggle"
  | "quote"
  | "callout"
  | "code"
  | "divider"
  | "image"
  | "page"
  | "database"
  | "columns2"
  | "columns3"
  | "synced"
  | "ai";

export interface BlockItem {
  kind: BlockKind;
  title: string;
  hint: string;
  icon: string;
  keywords: string;
}

export const BLOCK_ITEMS: BlockItem[] = [
  { kind: "ai", title: "Ask AI", hint: "Leaf AI writes or edits here, live.", icon: "✨", keywords: "ai ask claude write generate summarize assistant" },
  { kind: "paragraph", title: "Text", hint: "Just start writing with plain text.", icon: "Aa", keywords: "text paragraph plain" },
  { kind: "page", title: "Page", hint: "Embed a sub-page inside this page.", icon: "📄", keywords: "page subpage link" },
  { kind: "todo", title: "To-do list", hint: "Track tasks with a to-do list.", icon: "☑", keywords: "todo task checkbox check" },
  { kind: "h1", title: "Heading 1", hint: "Big section heading.", icon: "H1", keywords: "heading h1 title" },
  { kind: "h2", title: "Heading 2", hint: "Medium section heading.", icon: "H2", keywords: "heading h2 subtitle" },
  { kind: "h3", title: "Heading 3", hint: "Small section heading.", icon: "H3", keywords: "heading h3" },
  { kind: "bullet", title: "Bulleted list", hint: "Create a simple bulleted list.", icon: "•", keywords: "bullet list unordered ul" },
  { kind: "numbered", title: "Numbered list", hint: "Create a list with numbering.", icon: "1.", keywords: "numbered ordered list ol" },
  { kind: "toggle", title: "Toggle list", hint: "Toggles can hide and show content inside.", icon: "▸", keywords: "toggle collapse details" },
  { kind: "quote", title: "Quote", hint: "Capture a quote.", icon: "❝", keywords: "quote blockquote" },
  { kind: "callout", title: "Callout", hint: "Make writing stand out.", icon: "💡", keywords: "callout note info" },
  { kind: "code", title: "Code", hint: "Capture a code snippet.", icon: "</>", keywords: "code snippet pre" },
  { kind: "divider", title: "Divider", hint: "Visually divide blocks.", icon: "—", keywords: "divider hr line separator" },
  { kind: "image", title: "Image", hint: "Embed an image from a URL.", icon: "🖼", keywords: "image picture photo url" },
  { kind: "database", title: "Database - Inline", hint: "Table, board, calendar and gallery views.", icon: "▦", keywords: "database table board kanban inline calendar gallery" },
  { kind: "columns2", title: "2 columns", hint: "Split this part of the page in two.", icon: "◫", keywords: "columns column layout side split two 2" },
  { kind: "columns3", title: "3 columns", hint: "Three side-by-side columns.", icon: "▥", keywords: "columns column layout three 3" },
  { kind: "synced", title: "Synced block", hint: "Edit once, update everywhere it's pasted.", icon: "⟳", keywords: "synced sync block mirror reuse transclusion" },
];

/** Blocks that create pages, databases or synced content can't go inside a synced block. */
const NOT_IN_SYNCED = new Set<BlockKind>(["page", "database", "synced", "ai"]);

export const TURN_INTO: BlockKind[] = ["paragraph", "h1", "h2", "h3", "bullet", "numbered", "todo", "toggle", "quote", "callout", "code"];

export interface CommandContext {
  pageId: string;
  workspaceId: string;
  /** True inside a synced block's editor. */
  synced?: boolean;
}

const HOLDERS = new Set(["nest", "toggle", "blockquote"]);

/**
 * Turn a block that has children into another kind, keeping the children nested under
 * it (as in Notion). Handles the head of a nest, toggle or quote; converting to a text
 * kind gives a nest, to a toggle/quote/list item gives that container. Returns false
 * when the cursor isn't on such a head, so the plain conversion runs instead.
 */
function restructureHead(editor: Editor, kind: BlockKind): boolean {
  const { state } = editor;
  const { $from } = state.selection;
  const { schema } = state;
  if ($from.depth < 2 || !$from.parent.isTextblock || $from.parent.type.name === "codeBlock") return false;
  const d = $from.depth - 1;
  const holder = $from.node(d);
  if (!HOLDERS.has(holder.type.name) || $from.index(d) !== 0 || holder.childCount < 2) return false;
  const head = $from.parent;
  const kids: PMNode[] = [];
  holder.forEach((c, _o, i) => void (i > 0 && kids.push(c)));
  // Identity: a nest is its head's block, a toggle/quote is the container's.
  const id = holder.type.name === "nest" ? head.attrs.blockId : holder.attrs.blockId;
  const inline = head.content;
  const text = (type: string, attrs: Record<string, unknown> = {}) => schema.nodes[type]!.create({ ...attrs, blockId: id }, inline);
  let next: PMNode;
  switch (kind) {
    case "paragraph":
      next = schema.nodes.nest!.create(null, [text("paragraph"), ...kids]);
      break;
    case "h1":
    case "h2":
    case "h3":
      next = schema.nodes.nest!.create(null, [text("heading", { level: Number(kind[1]) }), ...kids]);
      break;
    case "callout":
      next = schema.nodes.nest!.create(null, [text("callout"), ...kids]);
      break;
    case "toggle":
    case "quote":
      next = schema.nodes[kind === "toggle" ? "toggle" : "blockquote"]!.create({ blockId: id }, [schema.nodes.paragraph!.create(null, inline), ...kids]);
      break;
    case "bullet":
    case "numbered":
    case "todo": {
      const [list, item] = kind === "bullet" ? ["bulletList", "listItem"] : kind === "numbered" ? ["orderedList", "listItem"] : ["taskList", "taskItem"];
      next = schema.nodes[list]!.create(null, schema.nodes[item]!.create({ blockId: id }, [schema.nodes.paragraph!.create(null, inline), ...kids]));
      break;
    }
    default:
      return false;
  }
  const at = $from.before(d);
  const offset = $from.parentOffset;
  const tr = state.tr.replaceWith(at, at + holder.nodeSize, next);
  // Caret back into the head's text: nest/toggle/quote put it at depth +2, lists at +3.
  const into = next.type.name === "bulletList" || next.type.name === "orderedList" || next.type.name === "taskList" ? 3 : 2;
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(at + into + offset, tr.doc.content.size))));
  editor.view.dispatch(tr.scrollIntoView());
  editor.commands.focus();
  return true;
}

/** Convert the block at the cursor into another kind, or insert an embed. */
export async function runBlockCommand(editor: Editor, kind: BlockKind, ctx: CommandContext) {
  const chain = () => editor.chain().focus();
  if (restructureHead(editor, kind)) return;
  switch (kind) {
    case "paragraph":
      return chain().clearNodes().run();
    case "h1":
    case "h2":
    case "h3":
      return chain().clearNodes().setNode("heading", { level: Number(kind[1]) }).run();
    case "bullet":
      return chain().clearNodes().toggleBulletList().run();
    case "numbered":
      return chain().clearNodes().toggleOrderedList().run();
    case "todo":
      return chain().clearNodes().toggleTaskList().run();
    case "quote":
      return chain().clearNodes().wrapIn("blockquote").run();
    case "toggle":
      return chain().clearNodes().wrapIn("toggle").run();
    case "callout":
      return chain().clearNodes().setNode("callout").run();
    case "code":
      return chain().clearNodes().setCodeBlock().run();
    case "divider":
      return chain().setHorizontalRule().run();
    case "image": {
      const url = window.prompt("Image URL", "https://picsum.photos/seed/" + Math.floor(Math.random() * 1000) + "/1000/400");
      if (!url) return;
      return chain().setImage({ src: url }).run();
    }
    case "page": {
      const { page } = await api("POST", "/api/pages", { parentId: ctx.pageId, title: "", link: false });
      chain().insertContent({ type: "pageLink", attrs: { pageId: page.id } }).run();
      window.dispatchEvent(new CustomEvent("leaf-navigate", { detail: page.id }));
      return;
    }
    case "database": {
      const { database } = await api("POST", "/api/databases", { pageId: ctx.pageId, title: "Untitled database" });
      chain().insertContent({ type: "database", attrs: { databaseId: database.id } }).run();
      return;
    }
    case "columns2":
    case "columns3":
      return insertColumns(editor, kind === "columns2" ? 2 : 3);
    case "ai": {
      // Open the AI panel anchored to the block the user is on.
      const { $from } = editor.state.selection;
      let blockId: string | null = null;
      for (let d = $from.depth; d >= 1 && !blockId; d--) blockId = $from.node(d).attrs.blockId ?? null;
      window.dispatchEvent(new CustomEvent("leaf-ai", { detail: blockId }));
      return;
    }
    case "synced": {
      const { container } = await api("POST", "/api/synced-blocks", { pageId: ctx.pageId });
      chain().insertContent({ type: "syncedBlock", attrs: { syncId: container.id } }).run();
      return;
    }
  }
}

/**
 * Insert N columns. A top-level text block becomes the first column's content; deeper
 * in the page (columns only live at the top level) a new column list goes after the
 * top-level block that holds the caret.
 */
function insertColumns(editor: Editor, n: number) {
  const { state } = editor;
  const { $from } = state.selection;
  const { schema } = state;
  if ($from.depth < 1) return;
  const top = $from.node(1);
  if (top.type.name === "columnList") return; // no columns inside columns
  const start = $from.before(1);
  const end = $from.after(1);
  const wrapTop = $from.depth === 1 && top.isTextblock;
  const first = wrapTop && top.content.size ? top : schema.nodes.paragraph!.create();
  const cols = Array.from({ length: n }, (_, i) => schema.nodes.column!.create({ width: 1 }, i === 0 ? first : schema.nodes.paragraph!.create()));
  const list = schema.nodes.columnList!.create(null, cols);
  const tr = wrapTop ? state.tr.replaceWith(start, end, list) : state.tr.insert(end, list);
  const at = wrapTop ? start : end;
  // Caret into the first column's paragraph (list > column > paragraph).
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + 3 + (wrapTop ? first.content.size : 0))));
  editor.view.dispatch(tr.scrollIntoView());
  editor.commands.focus();
}

// ---------------------------------------------------------------- suggestion popup plumbing

export interface ListHandle {
  onKeyDown: (e: KeyboardEvent) => boolean;
}

/** Mounts a React list next to the caret for a TipTap suggestion. */
export function popupRenderer<P>(Component: any) {
  return () => {
    let renderer: ReactRenderer<ListHandle, any> | null = null;
    const place = (props: SuggestionProps<P>) => {
      const rect = props.clientRect?.();
      const el = renderer?.element as HTMLElement | undefined;
      if (!rect || !el) return;
      el.style.position = "fixed";
      el.style.zIndex = "60";
      const below = rect.bottom + 6;
      const tooLow = below + 320 > window.innerHeight;
      el.style.left = `${Math.min(rect.left, window.innerWidth - 340)}px`;
      el.style.top = tooLow ? "" : `${below}px`;
      el.style.bottom = tooLow ? `${window.innerHeight - rect.top + 6}px` : "";
    };
    return {
      onStart: (props: SuggestionProps<P>) => {
        renderer = new ReactRenderer(Component, { props, editor: props.editor });
        document.body.appendChild(renderer.element);
        place(props);
      },
      onUpdate: (props: SuggestionProps<P>) => {
        renderer?.updateProps(props);
        place(props);
      },
      onKeyDown: ({ event }: { event: KeyboardEvent }) => {
        if (event.key === "Escape") {
          renderer?.destroy();
          renderer?.element.remove();
          renderer = null;
          return true;
        }
        return renderer?.ref?.onKeyDown(event) ?? false;
      },
      onExit: () => {
        renderer?.destroy();
        renderer?.element.remove();
        renderer = null;
      },
    };
  };
}

export function useListKeys<T>(items: T[], select: (item: T) => void, ref: React.Ref<ListHandle>) {
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => setIndex(0), [items]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);
  useImperativeHandle(ref, () => ({
    onKeyDown: (e) => {
      if (!items.length) return false;
      if (e.key === "ArrowDown") {
        setIndex((i) => (i + 1) % items.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        setIndex((i) => (i - 1 + items.length) % items.length);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        const it = items[index];
        if (it) select(it);
        return true;
      }
      return false;
    },
  }));
  return { index, setIndex, listRef };
}

// ---------------------------------------------------------------- slash menu

const SlashList = forwardRef<ListHandle, SuggestionProps<BlockItem>>(function SlashList(props, ref) {
  const { index, setIndex, listRef } = useListKeys(props.items, (it) => props.command(it), ref);
  if (!props.items.length) return <div className="menu slash-menu empty">No results</div>;
  return (
    <div className="menu slash-menu" ref={listRef} data-testid="slash-menu">
      <div className="menu-label">Basic blocks</div>
      {props.items.map((it, i) => (
        <button
          key={it.kind}
          data-index={i}
          className={`menu-item ${i === index ? "active" : ""}`}
          onMouseEnter={() => setIndex(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            props.command(it);
          }}
        >
          <span className="menu-icon">{it.icon}</span>
          <span className="menu-text">
            <span className="menu-title">{it.title}</span>
            <span className="menu-hint">{it.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
});

export function SlashCommand(ctx: () => CommandContext) {
  return Extension.create({
    name: "slashCommand",
    addProseMirrorPlugins() {
      const editor = this.editor;
      const options: Omit<SuggestionOptions<BlockItem>, "editor"> = {
        char: "/",
        pluginKey: new PluginKey("slash"),
        allowSpaces: false,
        startOfLine: false,
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          const parent = $from.parent.type.name;
          return parent !== "title" && parent !== "codeBlock";
        },
        items: ({ query }) => {
          const q = query.toLowerCase();
          const synced = ctx().synced;
          return BLOCK_ITEMS.filter((i) => !(synced && NOT_IN_SYNCED.has(i.kind)))
            .filter((i) => !q || i.title.toLowerCase().includes(q) || i.keywords.includes(q))
            .slice(0, 20);
        },
        command: ({ editor: ed, range, props }: { editor: Editor; range: Range; props: BlockItem }) => {
          ed.chain().focus().deleteRange(range).run();
          void runBlockCommand(ed, props.kind, ctx());
        },
        render: popupRenderer<BlockItem>(SlashList),
      };
      return [Suggestion({ editor, ...options })];
    },
  });
}
