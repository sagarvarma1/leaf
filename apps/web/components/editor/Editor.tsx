"use client";
import type { Editor as TEditor } from "@tiptap/core";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Color from "@tiptap/extension-color";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import TextStyle from "@tiptap/extension-text-style";
import Underline from "@tiptap/extension-underline";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Extension } from "@tiptap/core";
import { createPortal } from "react-dom";
import { BubbleMenu, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { common, createLowlight } from "lowlight";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SyncClient } from "@/lib/sync";
import { COLORS, Icon, Popover } from "../ui";
import { BLOCK_ITEMS, runBlockCommand, SlashCommand, TURN_INTO, type BlockKind, type CommandContext } from "./commands";
import { EditorContext } from "./context";
import {
  BlockId,
  Callout,
  codeBlockNodeView,
  Column,
  ColumnList,
  CommentMarks,
  commentKey,
  dragState,
  Indent,
  LayoutNormalizer,
  LeafDocument,
  Nest,
  normalizeLayout,
  SyncedDocument,
  Title,
  Toggle,
} from "./extensions";
import { copySyncedBlock, DatabaseNode, LeafMention, PageLink, SyncedBlock } from "./nodes";
import { LeafSync, renderDoc } from "./sync-binding";

const lowlight = createLowlight(common);

export interface EditorProps {
  /** "synced": the nested editor of a synced block (its own document, no title). */
  variant?: "page" | "synced";
  pageId: string;
  workspaceId: string;
  /** The sync client, and the document this editor shows (the page, or a synced container). */
  sync: SyncClient;
  rootId: string;
  user: { name: string; color: string };
  readOnly: boolean;
  commentedBlocks: Set<string>;
  onComment: (blockId: string | null) => void;
  onReady?: (editor: TEditor) => void;
  /** Rendered right under the title (database row properties). */
  afterTitle?: React.ReactNode;
}

/** A widget slot after the title node that React can portal into. */
function afterTitleExtension(slot: HTMLElement) {
  return Extension.create({
    name: "afterTitle",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: new PluginKey("afterTitle"),
          props: {
            decorations: (state) => {
              const title = state.doc.firstChild;
              if (!title) return null;
              return DecorationSet.create(state.doc, [
                Decoration.widget(title.nodeSize, () => slot, { key: "after-title", side: -1, ignoreSelection: true, stopEvent: () => true }),
              ]);
            },
          },
        }),
      ];
    },
  });
}

export function Editor(props: EditorProps) {
  const { sync, rootId, user, readOnly } = props;
  const synced = props.variant === "synced";
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const ctxRef = useRef<CommandContext>({ pageId: props.pageId, workspaceId: props.workspaceId, synced });
  ctxRef.current = { pageId: props.pageId, workspaceId: props.workspaceId, synced };
  const slot = useMemo(() => {
    const el = document.createElement("div");
    el.className = "after-title";
    el.contentEditable = "false";
    return el;
  }, []);

  const editor = useEditor(
    {
      immediatelyRender: false,
      editable: !readOnly,
      content: renderDoc(sync, rootId, !synced),
      extensions: [
        ...(synced ? [SyncedDocument] : [LeafDocument, Title]),
        StarterKit.configure({
          document: false,
          history: false, // the sync client's undo instead: undo only your own changes
          codeBlock: false,
          heading: { levels: [1, 2, 3] },
          dropcursor: { color: "#2383e2", width: 3 },
        }),
        Underline,
        TextStyle,
        Color,
        Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" } }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Toggle,
        Callout,
        CodeBlockLowlight.extend({ addNodeView: () => codeBlockNodeView() }).configure({ lowlight, defaultLanguage: "plain" }),
        Image.configure({ inline: false, allowBase64: false }),
        PageLink,
        DatabaseNode,
        SyncedBlock,
        Nest,
        ColumnList,
        Column,
        LeafMention,
        BlockId,
        Indent,
        LayoutNormalizer,
        CommentMarks,
        SlashCommand(() => ctxRef.current),
        ...(synced ? [] : [afterTitleExtension(slot)]),
        Placeholder.configure({
          showOnlyCurrent: false,
          includeChildren: true,
          placeholder: ({ node, hasAnchor }: { node: PMNode; hasAnchor: boolean }) => {
            if (node.type.name === "title") return "Untitled";
            if (!hasAnchor) return "";
            if (node.type.name === "heading") return `Heading ${node.attrs.level}`;
            if (node.type.name === "paragraph") return "Type '/' for commands, '@' to mention";
            return "";
          },
        } as any),
        LeafSync({ sync, rootId, title: !synced, readOnly: () => readOnlyRef.current }),
      ],
      editorProps: {
        attributes: synced
          ? { class: "leaf-editor synced-editor", spellcheck: "true", "data-testid": "synced-editor" }
          : { class: "leaf-editor", spellcheck: "true", "data-testid": "editor" },
        handleClick: (view, _pos, event) => {
          const el = (event.target as HTMLElement).closest?.(".mention[data-kind=page]") as HTMLElement | null;
          if (el?.dataset.id) {
            window.dispatchEvent(new CustomEvent("leaf-navigate", { detail: el.dataset.id }));
            return true;
          }
          const a = (event.target as HTMLElement).closest?.("a[href]") as HTMLAnchorElement | null;
          if (a && (event.metaKey || event.ctrlKey || !view.editable)) {
            window.open(a.href, "_blank", "noopener");
            return true;
          }
          return false;
        },
      },
    },
    [sync, rootId],
  );

  useEffect(() => {
    if (editor) props.onReady?.(editor);
  }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [editor, readOnly]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(commentKey, props.commentedBlocks));
  }, [editor, props.commentedBlocks]);

  const context = useMemo(
    () => ({
      pageId: props.pageId,
      workspaceId: props.workspaceId,
      sync,
      user,
      readOnly,
      commentedBlocks: props.commentedBlocks,
      onComment: props.onComment,
      Editor,
    }),
    [props.pageId, props.workspaceId, sync, user, readOnly, props.commentedBlocks, props.onComment],
  );

  if (!editor) return <div className="editor-loading" />;
  return (
    <EditorContext.Provider value={context}>
      <div className={`editor-wrap ${synced ? "synced-wrap" : ""}`}>
        {/* Stable wrappers: TipTap moves the bubble menu element into a tippy popup, so React
            must never need to insert siblings next to it. */}
        <div className="editor-overlay">{!readOnly && <BlockHandle editor={editor} ctx={ctxRef} onComment={props.onComment} />}</div>
        <div className="editor-overlay">{!readOnly && <Toolbar editor={editor} ctx={ctxRef} onComment={props.onComment} />}</div>
        <EditorContent editor={editor} />
        {props.afterTitle && !synced ? createPortal(props.afterTitle, slot) : null}
      </div>
    </EditorContext.Provider>
  );
}

// ---------------------------------------------------------------- floating format toolbar

function currentBlockId(editor: TEditor): string | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d >= 1; d--) {
    const id = $from.node(d).attrs.blockId;
    if (id) {
      // Prefer the list item / toggle over its inner paragraph.
      const parent = d > 1 ? $from.node(d - 1) : null;
      if (parent?.attrs.blockId && $from.index(d - 1) === 0 && ["listItem", "taskItem", "toggle", "blockquote"].includes(parent.type.name)) return parent.attrs.blockId;
      return id;
    }
  }
  return null;
}

function Toolbar({ editor, ctx, onComment }: { editor: TEditor; ctx: React.RefObject<CommandContext>; onComment: (id: string | null) => void }) {
  const [menu, setMenu] = useState<null | { kind: "turn" | "color"; el: HTMLElement }>(null);
  const btn = (name: string, label: string, active: boolean, run: () => void, testId?: string) => (
    <button
      className={`tb-btn ${active ? "active" : ""}`}
      title={label}
      data-testid={testId}
      onMouseDown={(e) => {
        e.preventDefault();
        run();
      }}
    >
      {name}
    </button>
  );
  const blockLabel = () => {
    const { $from } = editor.state.selection;
    const n = $from.parent;
    if (n.type.name === "heading") return `Heading ${n.attrs.level}`;
    for (let d = $from.depth; d > 0; d--) {
      const t = $from.node(d).type.name;
      if (t === "taskItem") return "To-do list";
      if (t === "bulletList") return "Bulleted list";
      if (t === "orderedList") return "Numbered list";
      if (t === "toggle") return "Toggle list";
      if (t === "blockquote") return "Quote";
      if (t === "callout") return "Callout";
    }
    return "Text";
  };
  return (
    <>
      <BubbleMenu
        editor={editor}
        tippyOptions={{ duration: 100, maxWidth: "none", placement: "top-start" }}
        shouldShow={({ editor: ed, state, from, to }) => {
          if (from === to || !ed.isEditable || state.selection instanceof NodeSelection) return false;
          const parent = state.selection.$from.parent.type.name;
          return parent !== "title" && parent !== "codeBlock" && !!state.doc.textBetween(from, to).trim();
        }}
      >
        <div className="toolbar" data-testid="format-toolbar">
          <button className="tb-btn wide" onMouseDown={(e) => (e.preventDefault(), setMenu({ kind: "turn", el: e.currentTarget }))}>
            {blockLabel()} ▾
          </button>
          <span className="tb-sep" />
          {btn("B", "Bold (⌘B)", editor.isActive("bold"), () => editor.chain().focus().toggleBold().run(), "tb-bold")}
          {btn("i", "Italic (⌘I)", editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run(), "tb-italic")}
          {btn("U", "Underline (⌘U)", editor.isActive("underline"), () => editor.chain().focus().toggleUnderline().run())}
          {btn("S", "Strikethrough", editor.isActive("strike"), () => editor.chain().focus().toggleStrike().run())}
          {btn("</>", "Inline code (⌘E)", editor.isActive("code"), () => editor.chain().focus().toggleCode().run())}
          {btn("🔗", "Link", editor.isActive("link"), () => {
            const prev = editor.getAttributes("link").href as string | undefined;
            const url = window.prompt("Link URL", prev ?? "https://");
            if (url === null) return;
            if (!url) editor.chain().focus().extendMarkRange("link").unsetLink().run();
            else editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
          })}
          <button className="tb-btn" title="Text color" onMouseDown={(e) => (e.preventDefault(), setMenu({ kind: "color", el: e.currentTarget }))}>
            <span style={{ textDecoration: "underline", textDecorationColor: editor.getAttributes("textStyle").color ?? "currentColor" }}>A</span> ▾
          </button>
          <span className="tb-sep" />
          {!ctx.current?.synced && (
            <button
              className="tb-btn ai-tb"
              title="Ask Leaf AI about this"
              data-testid="tb-ai"
              onMouseDown={(e) => (e.preventDefault(), window.dispatchEvent(new CustomEvent("leaf-ai", { detail: currentBlockId(editor) })))}
            >
              <Icon name="sparkle" size={13} /> Ask AI
            </button>
          )}
          <button className="tb-btn" title="Comment" data-testid="tb-comment" onMouseDown={(e) => (e.preventDefault(), onComment(currentBlockId(editor)))}>
            <Icon name="comment" size={14} />
          </button>
        </div>
      </BubbleMenu>
      {menu?.kind === "turn" && (
        <Popover anchor={menu.el} onClose={() => setMenu(null)} className="menu">
          <div className="menu-label">Turn into</div>
          {TURN_INTO.map((k) => {
            const it = BLOCK_ITEMS.find((i) => i.kind === k)!;
            return (
              <button key={k} className="menu-item compact" onMouseDown={(e) => (e.preventDefault(), setMenu(null), void runBlockCommand(editor, k, ctx.current!))}>
                <span className="menu-icon small">{it.icon}</span>
                <span className="menu-title">{it.title}</span>
              </button>
            );
          })}
        </Popover>
      )}
      {menu?.kind === "color" && (
        <Popover anchor={menu.el} onClose={() => setMenu(null)} className="menu">
          <div className="menu-label">Color</div>
          {COLORS.map((c) => (
            <button
              key={c.name}
              className="menu-item compact"
              onMouseDown={(e) => {
                e.preventDefault();
                setMenu(null);
                if (!c.text) editor.chain().focus().unsetColor().run();
                else editor.chain().focus().setColor(c.text).run();
              }}
            >
              <span className="color-swatch" style={{ color: c.text || "inherit" }}>
                A
              </span>
              <span className="menu-title">{c.label}</span>
            </button>
          ))}
        </Popover>
      )}
    </>
  );
}

// ---------------------------------------------------------------- drag handle + block menu

const HANDLE_TYPES = new Set(["paragraph", "heading", "listItem", "taskItem", "toggle", "blockquote", "callout", "codeBlock", "horizontalRule", "image", "pageLink", "database", "syncedBlock", "nest"]);
const CONTAINERS = new Set(["listItem", "taskItem", "toggle", "blockquote", "nest"]);

interface Hovered {
  pos: number;
  node: PMNode;
  top: number;
  left: number;
  height: number;
}

function findBlock(editor: TEditor, x: number, y: number): Hovered | null {
  const view = editor.view;
  const box = view.dom.getBoundingClientRect();
  const hit = view.posAtCoords({ left: Math.max(box.left + 4, Math.min(x, box.right - 4)), top: y });
  if (!hit) return null;
  const doc = view.state.doc;
  let candidate: { pos: number; node: PMNode } | null = null;
  if (hit.inside >= 0) {
    const n = doc.nodeAt(hit.inside);
    if (n && n.isAtom && HANDLE_TYPES.has(n.type.name)) candidate = { pos: hit.inside, node: n };
  }
  if (!candidate) {
    const $p = doc.resolve(hit.pos);
    for (let d = $p.depth; d >= 1; d--) {
      const node = $p.node(d);
      if (!HANDLE_TYPES.has(node.type.name)) continue;
      const parent = $p.node(d - 1);
      if (node.type.name === "paragraph" && CONTAINERS.has(parent.type.name) && $p.index(d - 1) === 0) continue;
      // The head of a nest is dragged together with its children.
      if (parent.type.name === "nest" && $p.index(d - 1) === 0) continue;
      candidate = { pos: $p.before(d), node };
      break;
    }
  }
  if (!candidate) return null;
  const dom = view.nodeDOM(candidate.pos) as HTMLElement | null;
  if (!dom || !(dom instanceof HTMLElement)) return null;
  const r = dom.getBoundingClientRect();
  return { ...candidate, top: r.top, left: r.left, height: r.height };
}

/** Stable key of a handle target: its block id (a nest is keyed by its head). */
function nodeKey(node: PMNode): string | null {
  if (node.type.name === "nest") return node.firstChild?.attrs.blockId ?? null;
  return node.attrs.blockId ?? node.attrs.databaseId ?? null;
}

/** Find a handle target by key in the current doc (positions go stale between events). */
function findById(editor: TEditor, id: string | null): { pos: number; node: PMNode } | null {
  if (!id) return null;
  let found: { pos: number; node: PMNode } | null = null;
  // A nest is visited before its head, so a head's id resolves to the whole nest.
  editor.state.doc.descendants((n, pos) => {
    if (found) return false;
    if (n.type.name === "nest" ? n.firstChild?.attrs.blockId === id : n.attrs.blockId === id || (n.attrs.databaseId && n.attrs.databaseId === id)) {
      found = { pos, node: n };
    }
    return true;
  });
  return found;
}

interface ColumnDrop {
  targetId: string;
  side: "left" | "right";
  top: number;
  left: number;
  height: number;
}

/** Dragging a block onto the left/right edge of a top-level block (or a block in a column). */
function columnZone(editor: TEditor, x: number, y: number): Omit<ColumnDrop, "top" | "left" | "height"> & { rect: DOMRect } | null {
  const b = findBlock(editor, x, y);
  if (!b || b.node.type.name === "title") return null;
  const $p = editor.state.doc.resolve(b.pos);
  if ($p.parent.type.name !== "doc" && $p.parent.type.name !== "column") return null;
  const dom = editor.view.nodeDOM(b.pos) as HTMLElement | null;
  const key = nodeKey(b.node);
  if (!dom || !key) return null;
  const rect = dom.getBoundingClientRect();
  // Narrow on the left: a plain vertical drag passes just left of the blocks (where the
  // handle is), and must keep meaning "reorder". Wider on the right, which is mostly empty.
  if (x >= rect.left && x < rect.left + 20) return { targetId: key, side: "left", rect };
  if (x > rect.right - Math.min(72, rect.width / 4)) return { targetId: key, side: "right", rect };
  return null;
}

/** Move the dragged block next to the target, creating (or extending) columns. */
function dropIntoColumns(editor: TEditor, sourceId: string, targetId: string, side: "left" | "right") {
  const src = findById(editor, sourceId);
  const target = findById(editor, targetId);
  if (!src || !target || sourceId === targetId) return;
  if (target.pos > src.pos && target.pos < src.pos + src.node.nodeSize) return; // into itself
  const { schema } = editor.state;
  const $src = editor.state.doc.resolve(src.pos);
  // A list item travels inside a list of its own kind.
  let moving = src.node;
  if (moving.type.name === "listItem" || moving.type.name === "taskItem") moving = $src.parent.type.create(null, moving);
  const tr = editor.state.tr.delete(src.pos, src.pos + src.node.nodeSize);
  const tPos = tr.mapping.map(target.pos);
  const tNode = tr.doc.nodeAt(tPos);
  if (!tNode) return;
  const $t = tr.doc.resolve(tPos);
  const column = schema.nodes.column!.create({ width: 1 }, moving);
  if ($t.parent.type.name === "column") {
    const colPos = $t.before($t.depth);
    tr.insert(side === "left" ? colPos : colPos + $t.parent.nodeSize, column);
  } else {
    const other = schema.nodes.column!.create({ width: 1 }, tNode);
    tr.replaceWith(tPos, tPos + tNode.nodeSize, schema.nodes.columnList!.create(null, side === "left" ? [column, other] : [other, column]));
  }
  editor.view.dispatch(normalizeLayout(tr, { prunedColumn: dragState.sourceColumn }).scrollIntoView());
  dragState.sourceColumn = null;
}

function BlockHandle({ editor, ctx, onComment }: { editor: TEditor; ctx: React.RefObject<CommandContext>; onComment: (id: string | null) => void }) {
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const [menu, setMenu] = useState<{ el: HTMLElement; target: Hovered; sub?: "turn" | "color" } | null>(null);
  const [columnDrop, setColumnDrop] = useState<ColumnDrop | null>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const frozen = useRef(false);
  const dragging = useRef<string | null>(null);
  const columnDropRef = useRef<ColumnDrop | null>(null);
  columnDropRef.current = columnDrop;

  useEffect(() => {
    const wrap = editor.view.dom.closest(".editor-wrap") as HTMLElement | null;
    const scroller = wrap?.closest(".page-scroll") ?? window;
    if (!wrap) return;
    // A synced block's nested editor has its own handles: ignore events from inside it.
    const inNested = (t: EventTarget | null) => {
      const inner = (t as Element | null)?.closest?.(".editor-wrap");
      return Boolean(inner && inner !== wrap);
    };
    const move = (e: MouseEvent) => {
      if (frozen.current) return;
      if (handleRef.current?.contains(e.target as globalThis.Node)) return;
      if (inNested(e.target)) return setHovered(null);
      const b = findBlock(editor, e.clientX, e.clientY);
      setHovered(b);
    };
    const dragOver = (e: DragEvent) => {
      if (!dragging.current || inNested(e.target)) return;
      const z = columnZone(editor, e.clientX, e.clientY);
      if (!z || z.targetId === dragging.current) {
        if (columnDropRef.current) setColumnDrop(null);
        return;
      }
      // Our indicator replaces ProseMirror's drop cursor in the column zones.
      e.preventDefault();
      e.stopPropagation();
      editor.view.dom.dispatchEvent(new DragEvent("dragleave", { relatedTarget: document.body }));
      const w = wrap.getBoundingClientRect();
      const next = { targetId: z.targetId, side: z.side, top: z.rect.top - w.top, height: z.rect.height, left: (z.side === "left" ? z.rect.left - 6 : z.rect.right + 2) - w.left };
      const cur = columnDropRef.current;
      if (!cur || cur.targetId !== next.targetId || cur.side !== next.side || cur.top !== next.top) setColumnDrop(next);
    };
    const drop = (e: DragEvent) => {
      const z = columnDropRef.current;
      const src = dragging.current;
      if (!z || !src) return;
      e.preventDefault();
      e.stopPropagation();
      (editor.view as any).dragging = null;
      setColumnDrop(null);
      dragging.current = null;
      dropIntoColumns(editor, src, z.targetId, z.side);
    };
    wrap.addEventListener("dragover", dragOver, true);
    wrap.addEventListener("drop", drop, true);
    const leave = (e: MouseEvent) => {
      if (frozen.current) return;
      if (handleRef.current?.contains(e.relatedTarget as globalThis.Node)) return;
      setHovered(null);
    };
    const hide = () => !frozen.current && setHovered(null);
    wrap.addEventListener("mousemove", move);
    wrap.addEventListener("mouseleave", leave);
    scroller.addEventListener("scroll", hide, { passive: true });
    editor.on("update", hide);
    return () => {
      wrap.removeEventListener("dragover", dragOver, true);
      wrap.removeEventListener("drop", drop, true);
      wrap.removeEventListener("mousemove", move);
      wrap.removeEventListener("mouseleave", leave);
      scroller.removeEventListener("scroll", hide);
      editor.off("update", hide);
    };
  }, [editor]);

  const target = menu?.target ?? hovered;
  const wrapRect = editor.view.dom.closest(".editor-wrap")?.getBoundingClientRect();

  const fresh = (t: Hovered) => findById(editor, nodeKey(t.node));

  const act = (fn: (pos: number, node: PMNode) => void) => {
    const t = menu?.target;
    setMenu(null);
    frozen.current = false;
    if (!t) return;
    const f = fresh(t);
    if (f) fn(f.pos, f.node);
  };

  const textPos = (pos: number, node: PMNode) => (node.isTextblock ? pos + 1 : pos + 2);

  return (
    <>
      {columnDrop && <div className="column-drop" data-testid="column-drop" style={{ top: columnDrop.top, left: columnDrop.left, height: columnDrop.height }} />}
      {target && wrapRect && (
        <div
          ref={handleRef}
          className="block-handle"
          style={{ top: target.top - wrapRect.top + Math.min(target.height / 2, 14) - 12, left: target.left - wrapRect.left - 48 }}
          onMouseLeave={(e) => {
            if (!frozen.current && !editor.view.dom.contains(e.relatedTarget as globalThis.Node)) setHovered(null);
          }}
        >
          <button
            className="handle-btn"
            title="Click to add below"
            data-testid="block-add"
            onClick={() => {
              const f = fresh(target);
              if (!f) return;
              const $p = editor.state.doc.resolve(f.pos);
              const top = $p.depth === 0 ? f.pos + f.node.nodeSize : $p.after(1);
              editor.chain().insertContentAt(top, { type: "paragraph" }).setTextSelection(top + 1).focus().insertContent("/").run();
            }}
          >
            <Icon name="plus" size={14} />
          </button>
          <div
            className="handle-btn grip"
            draggable
            title="Drag to move · click for options"
            data-testid="block-grip"
            onDragStart={(e) => {
              const f = fresh(target);
              if (!f) return;
              const $src = editor.state.doc.resolve(f.pos);
              dragState.sourceColumn = $src.parent.type.name === "column" ? $src.parent.attrs.blockId : null;
              dragging.current = nodeKey(f.node);
              const view = editor.view;
              const sel = NodeSelection.create(view.state.doc, f.pos);
              view.dispatch(view.state.tr.setSelection(sel));
              const slice = sel.content();
              // Hand the slice to ProseMirror: its drop handler moves the node.
              (view as any).dragging = { slice, move: true };
              e.dataTransfer.effectAllowed = "copyMove";
              e.dataTransfer.setData("text/plain", f.node.textContent);
              const dom = view.nodeDOM(f.pos) as HTMLElement | null;
              if (dom) e.dataTransfer.setDragImage(dom, 0, 0);
            }}
            onDragEnd={() => {
              setHovered(null);
              setColumnDrop(null);
              dragging.current = null;
            }}
            onClick={(e) => {
              frozen.current = true;
              setMenu({ el: e.currentTarget, target });
              const f = fresh(target);
              if (f) editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, f.pos)));
            }}
          >
            <Icon name="grip" size={14} />
          </div>
        </div>
      )}
      {menu && (
        <Popover
          anchor={menu.el}
          placement="bottom-start"
          className="menu block-menu"
          testId="block-menu"
          onClose={() => {
            setMenu(null);
            frozen.current = false;
          }}
        >
          {menu.target.node.isTextblock || CONTAINERS.has(menu.target.node.type.name) ? (
            <>
              <div className="menu-label">Turn into</div>
              <div className="turn-grid">
                {TURN_INTO.map((k: BlockKind) => {
                  const it = BLOCK_ITEMS.find((i) => i.kind === k)!;
                  return (
                    <button
                      key={k}
                      className="menu-item compact"
                      data-testid={`turn-${k}`}
                      onClick={() =>
                        act((pos, node) => {
                          editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(textPos(pos, node)))));
                          void runBlockCommand(editor, k, ctx.current!);
                        })
                      }
                    >
                      <span className="menu-icon small">{it.icon}</span>
                      <span className="menu-title">{it.title}</span>
                    </button>
                  );
                })}
              </div>
              <div className="menu-sep" />
              <div className="menu-label">Color</div>
              <div className="color-row">
                {COLORS.map((c) => (
                  <button
                    key={c.name}
                    className="color-dot"
                    title={c.label}
                    style={{ color: c.text || "inherit" }}
                    onClick={() =>
                      act((pos, node) => {
                        const chain = editor.chain().setTextSelection({ from: pos + 1, to: pos + node.nodeSize - 1 });
                        (c.text ? chain.setColor(c.text) : chain.unsetColor()).run();
                      })
                    }
                  >
                    A
                  </button>
                ))}
              </div>
              <div className="menu-sep" />
            </>
          ) : null}
          {menu.target.node.type.name === "syncedBlock" && (
            <button className="menu-item compact" data-testid="block-copy-sync" onClick={() => act((_p, node) => void copySyncedBlock(node.attrs.syncId))}>
              <span className="menu-icon small">⟳</span> <span className="menu-title">Copy and sync</span>
            </button>
          )}
          <button className="menu-item compact" data-testid="block-comment" onClick={() => act((_p, node) => onComment(nodeKey(node)))}>
            <Icon name="comment" size={14} /> <span className="menu-title">Comment</span>
          </button>
          {!menu.target.node.isAtom || menu.target.node.type.name === "image" || menu.target.node.type.name === "horizontalRule" ? (
          <button
            className="menu-item compact"
            data-testid="block-duplicate"
            onClick={() =>
              act((pos, node) => {
                const tr = editor.state.tr.insert(pos + node.nodeSize, node.type.create(node.attrs, node.content, node.marks));
                editor.view.dispatch(tr);
              })
            }
          >
            <Icon name="page" size={14} /> <span className="menu-title">Duplicate</span>
          </button>
          ) : null}
          <button
            className="menu-item compact danger"
            data-testid="block-delete"
            onClick={() =>
              act((pos) => {
                const tr = editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)).deleteSelection();
                editor.view.dispatch(normalizeLayout(tr));
              })
            }
          >
            <Icon name="trash" size={14} /> <span className="menu-title">Delete</span>
          </button>
        </Popover>
      )}
    </>
  );
}
