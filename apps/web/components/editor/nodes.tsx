"use client";
import { Node, mergeAttributes } from "@tiptap/core";
import Mention from "@tiptap/extension-mention";
import { PluginKey } from "@tiptap/pm/state";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import type { SuggestionProps } from "@tiptap/suggestion";
import { forwardRef, useEffect, useState } from "react";
import { api, ApiError, getShareToken } from "@/lib/api";
import { useDoc } from "@/lib/sync";
import { Icon, Popover } from "../ui";
import { useEditorContext } from "./context";
import { getState, isAlive, pageTitle, upsertBlocks, useBlock, useWorkspace } from "@/lib/store";
import { DatabaseView } from "../database/DatabaseView";
import { popupRenderer, useListKeys, type ListHandle } from "./commands";

const navigate = (id: string) => window.dispatchEvent(new CustomEvent("leaf-navigate", { detail: id }));

function PageLinkView({ node, selected }: NodeViewProps) {
  const id = node.attrs.pageId as string;
  const page = useBlock(id);
  const alive = useWorkspace((s) => (s.blocks[id] ? isAlive(s, id) : true));
  useEffect(() => {
    // Not in the local cache yet (just created by a collaborator, or a share-link guest).
    if (!page && id) api("GET", `/api/pages/${id}`).then((r) => upsertBlocks([r.page])).catch(() => {});
  }, [id, page]);
  return (
    <NodeViewWrapper className={`page-link ${selected ? "selected" : ""} ${!alive ? "deleted" : ""}`} data-drag-handle="" data-block-id={node.attrs.blockId}>
      <a
        href="#"
        contentEditable={false}
        onClick={(e) => {
          e.preventDefault();
          navigate(id);
        }}
      >
        <span className="page-link-icon">{page?.properties.icon || "📄"}</span>
        <span className="page-link-title">{page ? pageTitle(page) : "Page"}</span>
        {!alive && <span className="page-link-note">(in trash)</span>}
      </a>
    </NodeViewWrapper>
  );
}

export const PageLink = Node.create({
  name: "pageLink",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return { pageId: { default: null, parseHTML: (el) => el.getAttribute("data-page-id"), renderHTML: (a) => ({ "data-page-id": a.pageId }) } };
  },
  parseHTML: () => [{ tag: "div[data-type=page-link]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "page-link" })],
  renderText: ({ node }) => pageTitle(getState().blocks[node.attrs.pageId]),
  addNodeView() {
    return ReactNodeViewRenderer(PageLinkView);
  },
});

function DatabaseNodeView({ node, editor }: NodeViewProps) {
  return (
    <NodeViewWrapper className="database-block" contentEditable={false} data-database-id={node.attrs.databaseId}>
      <DatabaseView id={node.attrs.databaseId} readOnly={!editor.isEditable} />
    </NodeViewWrapper>
  );
}

export const DatabaseNode = Node.create({
  name: "database",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  isolating: true,
  addAttributes() {
    return { databaseId: { default: null, parseHTML: (el) => el.getAttribute("data-database-id"), renderHTML: (a) => ({ "data-database-id": a.databaseId }) } };
  },
  parseHTML: () => [{ tag: "div[data-type=database]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "database" })],
  addNodeView() {
    // All events inside the database UI belong to React, not ProseMirror.
    return ReactNodeViewRenderer(DatabaseNodeView, { stopEvent: () => true });
  },
});

// ---------------------------------------------------------------- synced blocks

interface SyncedInfo {
  original: string | null;
  pages: Array<{ id: string; title: string; icon: string | null }>;
}

/** Copy a synced block so pasting it anywhere creates another live instance. */
export async function copySyncedBlock(syncId: string) {
  const html = `<div data-type="synced-block" data-sync-id="${syncId}"></div>`;
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob(["Synced block"], { type: "text/plain" }) }),
    ]);
  } catch {
    // Clipboard API unavailable (http, old browser): fall back to a copy event.
    const onCopy = (e: ClipboardEvent) => {
      e.preventDefault();
      e.clipboardData?.setData("text/html", html);
      e.clipboardData?.setData("text/plain", "Synced block");
    };
    document.addEventListener("copy", onCopy, { once: true });
    document.execCommand("copy");
  }
}

function SyncedBlockView({ node, selected }: NodeViewProps) {
  const syncId = node.attrs.syncId as string;
  const ctx = useEditorContext();
  const [info, setInfo] = useState<SyncedInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [copied, setCopied] = useState(false);
  const load = () =>
    api<SyncedInfo>("GET", `/api/synced-blocks/${syncId}`)
      .then((r) => (setInfo(r), setError(null)))
      .catch((e) => setError(e instanceof ApiError && e.status === 404 ? "This synced block was deleted." : "You don't have access to this synced block."));
  useEffect(() => {
    if (syncId) void load();
  }, [syncId]); // eslint-disable-line react-hooks/exhaustive-deps
  const count = info?.pages.length ?? 0;
  return (
    <NodeViewWrapper className={`synced-block ${selected ? "selected" : ""}`} data-sync-id={syncId} data-block-id={node.attrs.blockId} data-testid="synced-block">
      <div className="synced-label" contentEditable={false}>
        <button
          className="synced-tag"
          data-testid="synced-tag"
          onClick={(e) => {
            void load();
            setMenu(e.currentTarget);
          }}
        >
          <span className="synced-icon">⟳</span> {count > 1 ? `Editing in ${count} pages` : "Synced block"}
        </button>
        {!ctx.readOnly && (
          <button
            className="synced-copy"
            data-testid="synced-copy"
            onClick={() => {
              void copySyncedBlock(syncId).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? "Copied — paste anywhere" : "Copy and sync"}
          </button>
        )}
      </div>
      <div className="synced-body">
        {error ? <div className="synced-error">{error}</div> : info ? <SyncedEditor syncId={syncId} /> : <div className="synced-loading" />}
      </div>
      {menu && info && (
        <Popover anchor={menu} onClose={() => setMenu(null)} className="menu" testId="synced-menu">
          <div className="menu-label">Synced in {count} {count === 1 ? "page" : "pages"}</div>
          {info.pages.map((p) => (
            <button key={p.id} className="menu-item compact" onClick={() => (setMenu(null), navigate(p.id))}>
              <span className="menu-icon small">{p.icon || "📄"}</span>
              <span className="menu-title">{p.title || "Untitled"}</span>
              {p.id === info.original && <span className="menu-kind">Original</span>}
              {p.id === ctx.pageId && <span className="menu-kind">This page</span>}
            </button>
          ))}
        </Popover>
      )}
    </NodeViewWrapper>
  );
}

/** The synced content: its own document (the container's blocks), edited by a nested editor. */
function SyncedEditor({ syncId }: { syncId: string }) {
  const ctx = useEditorContext();
  const doc = useDoc(ctx.sync, syncId);
  if (!doc.ready || !ctx.sync.view.getBlock(syncId)) return <div className="synced-loading" />;
  const Inner = ctx.Editor;
  return (
    <Inner
      variant="synced"
      pageId={ctx.pageId}
      workspaceId={ctx.workspaceId}
      sync={ctx.sync}
      rootId={syncId}
      user={ctx.user}
      readOnly={ctx.readOnly}
      commentedBlocks={ctx.commentedBlocks}
      onComment={ctx.onComment}
    />
  );
}

export const SyncedBlock = Node.create({
  name: "syncedBlock",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  isolating: true,
  addAttributes() {
    return { syncId: { default: null, parseHTML: (el) => el.getAttribute("data-sync-id"), renderHTML: (a) => ({ "data-sync-id": a.syncId }) } };
  },
  parseHTML: () => [{ tag: "div[data-type=synced-block]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "synced-block" })],
  renderText: () => "",
  addNodeView() {
    // The nested editor owns every event inside the block.
    return ReactNodeViewRenderer(SyncedBlockView, { stopEvent: () => true });
  },
});

// ---------------------------------------------------------------- @mentions

interface MentionItem {
  kind: "user" | "page";
  id: string;
  label: string;
  icon: string;
  color?: string;
}

const MentionList = forwardRef<ListHandle, SuggestionProps<MentionItem>>(function MentionList(props, ref) {
  const { index, setIndex, listRef } = useListKeys(props.items, (it) => props.command(it as any), ref);
  if (!props.items.length) return <div className="menu mention-menu empty">No matches</div>;
  return (
    <div className="menu mention-menu" ref={listRef} data-testid="mention-menu">
      {props.items.map((it, i) => (
        <button
          key={it.kind + it.id}
          data-index={i}
          className={`menu-item compact ${i === index ? "active" : ""}`}
          onMouseEnter={() => setIndex(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            props.command(it as any);
          }}
        >
          {it.kind === "user" ? (
            <span className="avatar xs" style={{ background: it.color }}>
              {it.label[0]}
            </span>
          ) : (
            <span className="menu-icon small">{it.icon}</span>
          )}
          <span className="menu-title">{it.label}</span>
          <span className="menu-kind">{it.kind === "user" ? "Person" : "Page"}</span>
        </button>
      ))}
    </div>
  );
});

export const LeafMention = Mention.extend({
  addAttributes() {
    return {
      id: { default: null, parseHTML: (el) => el.getAttribute("data-id"), renderHTML: (a) => ({ "data-id": a.id }) },
      label: { default: null, parseHTML: (el) => el.getAttribute("data-label"), renderHTML: (a) => ({ "data-label": a.label }) },
      kind: { default: "user", parseHTML: (el) => el.getAttribute("data-kind"), renderHTML: (a) => ({ "data-kind": a.kind }) },
    };
  },
}).configure({
  HTMLAttributes: { class: "mention" },
  renderText: ({ node }) => (node.attrs.kind === "user" ? "@" : "") + (node.attrs.label ?? ""),
  renderHTML: ({ node, options }) => {
    const live = node.attrs.kind === "page" ? getState().blocks[node.attrs.id] : null;
    const label = live ? pageTitle(live) : node.attrs.label;
    return [
      "span",
      mergeAttributes(options.HTMLAttributes, {
        "data-kind": node.attrs.kind,
        "data-id": node.attrs.id,
        "data-label": node.attrs.label,
      }),
      node.attrs.kind === "user" ? `@${label}` : `↗ ${live?.properties.icon ?? "📄"} ${label}`,
    ];
  },
  suggestion: {
    char: "@",
    pluginKey: new PluginKey("mention"),
    items: ({ query }: { query: string }) => {
      const s = getState();
      const q = query.toLowerCase();
      const people: MentionItem[] = s.members.map((m) => ({ kind: "user", id: m.id, label: m.name, icon: "", color: m.color }));
      const pages: MentionItem[] = Object.values(s.blocks)
        .filter((b) => b.type === "page" && isAlive(s, b.id))
        .map((b) => ({ kind: "page", id: b.id, label: pageTitle(b), icon: b.properties.icon || "📄" }));
      return [...people, ...pages].filter((i) => i.label.toLowerCase().includes(q)).slice(0, 8);
    },
    command: ({ editor, range, props }: any) => {
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          { type: "mention", attrs: { id: props.id, label: props.label, kind: props.kind } },
          { type: "text", text: " " },
        ])
        .run();
    },
    render: popupRenderer<MentionItem>(MentionList),
  } as any,
});
