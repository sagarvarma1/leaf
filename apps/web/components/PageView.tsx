"use client";
import type { Block } from "@leaf/shared";
import type { Editor as TEditor } from "@tiptap/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { syncFor, useDoc, usePresence, useSyncVersion, type SyncClient } from "@/lib/sync";
import { keepUrls, markSaved, useOnline } from "@/lib/offline";
import { setFavorites, upsertBlocks, useBlock, useWorkspace } from "@/lib/store";
import { useTheme } from "@/lib/session";
import { AiPanel, useAiStatus } from "./AiPanel";
import { CommentsPanel, useComments } from "./Comments";
import { RowProperties } from "./database/DatabaseView";
import { Editor } from "./editor/Editor";
import { HistoryModal } from "./History";
import { ShareMenu } from "./ShareMenu";
import { Avatar, EmojiPicker, Icon, Popover, timeAgo } from "./ui";

export const COVERS = ["gradient-1", "gradient-2", "gradient-3", "gradient-4", "gradient-5", "gradient-6"];

interface PageMeta {
  page: Block;
  access: "edit" | "view";
  breadcrumbs: Array<{ id: string; type: string; title: string; icon: string | null }>;
  isMember: boolean;
}

interface Peer {
  key: string;
  name: string;
  color: string;
}

export function PageView({
  pageId,
  workspaceId,
  me,
  share,
  onToggleSidebar,
  sidebarOpen,
}: {
  pageId: string;
  workspaceId: string;
  me: { id: string; name: string; color: string } | null;
  share: string | null;
  onToggleSidebar?: () => void;
  sidebarOpen?: boolean;
}) {
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useBlock(pageId) ?? meta?.page;
  const blocks = useWorkspace((s) => s.blocks);
  const favorites = useWorkspace((s) => s.favorites);
  // The tab's sync client; the page's records load into it (network, else offline cache).
  const sync = useMemo(() => syncFor(me?.id ?? null, workspaceId), [me?.id, workspaceId]);
  const doc = useDoc(sync, pageId);
  useSyncVersion(sync);
  const presence = usePresence(sync, pageId);
  // A page loaded from the server is now on this device too.
  useEffect(() => {
    if (doc.ready && !doc.fromCache && !share) markSaved(pageId);
  }, [doc.ready, doc.fromCache, pageId, share]);
  const [panel, setPanel] = useState<"comments" | "ai" | null>(null);
  const [aiBlock, setAiBlock] = useState<string | null>(null);
  const aiStatus = useAiStatus();
  const [draftBlock, setDraftBlock] = useState<string | null | undefined>(undefined);
  const [history, setHistory] = useState(false);
  const [pop, setPop] = useState<null | { kind: "share" | "more" | "icon"; el: HTMLElement }>(null);
  const { comments } = useComments(pageId);
  const [, setTheme] = useTheme();
  const editorRef = useRef<TEditor | null>(null);
  const online = useOnline();

  useEffect(() => {
    setMeta(null);
    setError(null);
    setPanel(null);
    setDraftBlock(undefined);
    api<PageMeta & { database: Block | null }>("GET", `/api/pages/${pageId}`)
      .then((r) => {
        setMeta(r);
        upsertBlocks([r.page, ...(r.database ? [r.database] : [])]);
      })
      .catch((e) => setError(e instanceof ApiError && e.status === 0 ? "offline" : e instanceof ApiError ? e.message : "Could not open this page"));
    // Keep this page's shell and metadata for offline use (opened via client navigation,
    // its HTML was never fetched as a document).
    if (!share) keepUrls([location.pathname, `/api/pages/${pageId}`, `/api/pages/${pageId}/comments`]);
  }, [pageId]); // eslint-disable-line react-hooks/exhaustive-deps

  const readOnly = !meta || meta.access !== "edit" || !me;
  const user = useMemo(() => ({ name: me?.name ?? "Guest", color: me?.color ?? "#999" }), [me?.name, me?.color]);

  // Everyone else on the page (one avatar per person, whatever the number of tabs).
  const peers = useMemo(() => {
    const seen = new Map<string, Peer>();
    for (const p of presence) {
      if (!p.user || p.session === sync.session || p.user.id === me?.id) continue;
      if (!seen.has(p.user.id)) seen.set(p.user.id, { key: p.session, name: p.user.name, color: p.user.color });
    }
    return [...seen.values()];
  }, [presence, sync, me?.id]);

  useEffect(() => {
    const h = (e: Event) => {
      setPanel("comments");
      setDraftBlock((e as CustomEvent).detail ?? null);
    };
    window.addEventListener("leaf-comment", h);
    // "Ask AI" from the slash menu or the selection toolbar, with the block the user is on.
    const ai = (e: Event) => {
      setPanel("ai");
      setAiBlock((e as CustomEvent).detail ?? null);
    };
    window.addEventListener("leaf-ai", ai);
    return () => {
      window.removeEventListener("leaf-comment", h);
      window.removeEventListener("leaf-ai", ai);
    };
  }, []);

  const openThreads = useMemo(() => new Set(comments.filter((c) => !c.resolved && c.block_id).map((c) => c.block_id!)), [comments]);
  const onComment = useCallback((blockId: string | null) => {
    setPanel("comments");
    setDraftBlock(blockId);
  }, []);

  // Offline and this page was never downloaded to this device.
  if (error === "offline" || doc.error === "offline") {
    return (
      <div className="page-error" data-testid="not-offline">
        <div className="page-error-icon">☁️</div>
        <div>This page isn't saved on this device yet.</div>
        <div className="muted small">It will open once you're back online.</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-error">
        <div className="page-error-icon">🔒</div>
        <div>{error}</div>
      </div>
    );
  }

  const page = live;
  const isRow = page?.parent_id ? blocks[page.parent_id]?.type === "database" : false;
  const crumbs = meta
    ? meta.breadcrumbs.map((c) => {
        const b = blocks[c.id];
        return { ...c, title: b?.properties.title ?? c.title, icon: b?.properties.icon ?? c.icon };
      })
    : [];
  const fav = favorites.includes(pageId);
  const cover = page?.properties.cover as string | null | undefined;
  const icon = page?.properties.icon as string | null | undefined;
  const setProps = (patch: Record<string, unknown>) =>
    api<{ page: Block }>("PATCH", `/api/pages/${pageId}`, patch).then((r) => upsertBlocks([r.page]));

  return (
    <div className="page-area">
      <header className="topbar">
        {onToggleSidebar && !sidebarOpen && (
          <button className="icon-btn" onClick={onToggleSidebar} title="Open sidebar">
            <Icon name="menu" />
          </button>
        )}
        <nav className="crumbs" data-testid="breadcrumbs">
          {crumbs.map((c, i) => (
            <span key={c.id} className="crumb-wrap">
              {i > 0 && <span className="crumb-sep">/</span>}
              <button className="crumb" onClick={() => c.type === "page" && window.dispatchEvent(new CustomEvent("leaf-navigate", { detail: c.id }))}>
                {c.icon && <span>{c.icon}</span>} {c.title || "Untitled"}
              </button>
            </span>
          ))}
        </nav>
        <div className="topbar-right">
          {doc.ready && <SyncStatus sync={sync} online={online} />}
          {meta?.access === "view" && <span className="status-pill muted">View only</span>}
          {page && <span className="muted small edited">Edited {timeAgo(page.last_edited_at)}</span>}
          <div className="presence" data-testid="presence">
            {peers.slice(0, 5).map((p) => (
              <Avatar key={p.key} name={p.name} color={p.color} title={`${p.name} is here`} />
            ))}
            {peers.length > 5 && <span className="avatar sm more">+{peers.length - 5}</span>}
          </div>
          {meta?.isMember && (
            <button className="btn ghost small" onClick={(e) => setPop({ kind: "share", el: e.currentTarget })} data-testid="share-btn">
              Share
            </button>
          )}
          {meta?.isMember && !readOnly && aiStatus?.enabled && online && (
            <button className={`btn ghost small ai-btn ${panel === "ai" ? "on" : ""}`} title="Leaf AI" data-testid="ai-btn" onClick={() => (setPanel(panel === "ai" ? null : "ai"), setAiBlock(null))}>
              <Icon name="sparkle" size={14} /> AI
            </button>
          )}
          <button className={`icon-btn ${panel === "comments" ? "on" : ""}`} title="Comments" data-testid="comments-btn" onClick={() => (setPanel(panel === "comments" ? null : "comments"), setDraftBlock(undefined))}>
            <Icon name="comment" />
          </button>
          <button className="icon-btn" title="Version history" data-testid="history-btn" onClick={() => setHistory(true)}>
            <Icon name="clock" />
          </button>
          {meta?.isMember && (
            <button
              className={`icon-btn ${fav ? "fav" : ""}`}
              title={fav ? "Remove from favorites" : "Add to favorites"}
              data-testid="favorite-btn"
              onClick={() => void api<{ favorites: string[] }>(fav ? "DELETE" : "PUT", `/api/pages/${pageId}/favorite`).then((r) => setFavorites(r.favorites))}
            >
              <Icon name="star" />
            </button>
          )}
          <button className="icon-btn" title="More" data-testid="more-btn" onClick={(e) => setPop({ kind: "more", el: e.currentTarget })}>
            <Icon name="dots" />
          </button>
        </div>
      </header>

      <div className="page-body">
        <div className="page-scroll">
          {cover && (
            <div className={`cover ${cover.startsWith("http") ? "" : cover}`} style={cover.startsWith("http") ? { backgroundImage: `url(${cover})` } : undefined}>
              {!readOnly && (
                <div className="cover-actions">
                  <button className="btn small ghost-light" onClick={() => void setProps({ cover: COVERS[(COVERS.indexOf(cover) + 1) % COVERS.length] })}>
                    Change cover
                  </button>
                  <button className="btn small ghost-light" onClick={() => void setProps({ cover: null })}>
                    Remove
                  </button>
                </div>
              )}
            </div>
          )}
          <div className={`page-content ${cover ? "has-cover" : ""} ${icon ? "has-icon" : ""}`}>
            {icon && (
              <button className="page-icon" disabled={readOnly} onClick={(e) => setPop({ kind: "icon", el: e.currentTarget })} data-testid="page-icon">
                {icon}
              </button>
            )}
            {!readOnly && (
              <div className="page-controls">
                {!icon && (
                  <button className="ctrl-btn" onClick={(e) => setPop({ kind: "icon", el: e.currentTarget })} data-testid="add-icon">
                    ☺ Add icon
                  </button>
                )}
                {!cover && (
                  <button className="ctrl-btn" onClick={() => void setProps({ cover: COVERS[Math.floor(Math.random() * COVERS.length)] })} data-testid="add-cover">
                    ▭ Add cover
                  </button>
                )}
                <button className="ctrl-btn" onClick={() => onComment(null)}>
                  💬 Add comment
                </button>
              </div>
            )}
            {doc.ready && meta && sync.view.getBlock(pageId) ? (
              <Editor
                key={pageId}
                pageId={pageId}
                workspaceId={workspaceId}
                sync={sync}
                rootId={pageId}
                user={user}
                readOnly={readOnly}
                commentedBlocks={openThreads}
                onComment={onComment}
                afterTitle={page && isRow ? <RowProperties row={page} readOnly={readOnly} /> : null}
                onReady={(ed) => {
                  editorRef.current = ed;
                  (window as any).__leafEditor = ed;
                  const title = page?.properties.title;
                  if (!readOnly && !title) setTimeout(() => ed.commands.focus("start"), 30);
                }}
              />
            ) : (
              <div className="page-skeleton">
                <div className="sk sk-title" />
                <div className="sk" />
                <div className="sk short" />
              </div>
            )}
          </div>
        </div>
        {panel === "ai" && <AiPanel pageId={pageId} blockId={aiBlock} onClose={() => setPanel(null)} />}
        {panel === "comments" && (
          <CommentsPanel
            pageId={pageId}
            meId={me?.id ?? null}
            canComment={Boolean(me)}
            comments={comments}
            draftBlock={draftBlock}
            onDraftDone={() => setDraftBlock(undefined)}
            onClose={() => setPanel(null)}
          />
        )}
      </div>

      {history && <HistoryModal pageId={pageId} canRestore={!readOnly} onClose={() => setHistory(false)} />}
      {pop?.kind === "share" && <ShareMenu pageId={pageId} workspaceId={workspaceId} anchor={pop.el} onClose={() => setPop(null)} />}
      {pop?.kind === "icon" && (
        <EmojiPicker
          anchor={pop.el}
          onClose={() => setPop(null)}
          onPick={(e) => {
            setPop(null);
            void setProps({ icon: e });
          }}
        />
      )}
      {pop?.kind === "more" && (
        <Popover anchor={pop.el} onClose={() => setPop(null)} placement="bottom-end" className="menu" testId="more-menu">
          <a className="menu-item compact" href={`/api/pages/${pageId}/export${share ? `?share=${share}` : ""}`} download data-testid="export-md">
            <Icon name="download" size={14} /> <span className="menu-title">Export as Markdown</span>
          </a>
          <button className="menu-item compact" onClick={() => (setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"), setPop(null))}>
            <Icon name="moon" size={14} /> <span className="menu-title">Toggle dark mode</span>
          </button>
          <button
            className="menu-item compact"
            onClick={() => {
              void navigator.clipboard?.writeText(location.href);
              setPop(null);
            }}
          >
            <Icon name="link" size={14} /> <span className="menu-title">Copy link</span>
          </button>
          {meta?.isMember && !readOnly && (
            <button
              className="menu-item compact danger"
              data-testid="page-trash"
              onClick={() => {
                setPop(null);
                void api("DELETE", `/api/pages/${pageId}`).then(() => {
                  const parent = page?.parent_id && blocks[page.parent_id]?.type === "page" ? page.parent_id : null;
                  window.dispatchEvent(new CustomEvent("leaf-navigate", { detail: parent }));
                });
              }}
            >
              <Icon name="trash" size={14} /> <span className="menu-title">Move to trash</span>
            </button>
          )}
        </Popover>
      )}
    </div>
  );
}

/**
 * Connection state for the open page. Offline edits are queued transactions kept in
 * IndexedDB, so the message is "N changes saved on this device", then "synced" once the
 * server has committed them.
 */
function SyncStatus({ sync, online }: { sync: SyncClient; online: boolean }) {
  const [flash, setFlash] = useState(false);
  const hadPending = useRef(0);
  const pending = sync.pendingCount;
  const live = online && sync.connected && pending === 0;
  useEffect(() => {
    if (!live) {
      if (!online || !sync.connected) hadPending.current = Math.max(hadPending.current, pending);
      return;
    }
    if (!hadPending.current) return;
    hadPending.current = 0;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 2500);
    return () => clearTimeout(t);
  }, [live, pending, online, sync.connected]);

  if (live) {
    return flash ? (
      <span className="status-pill synced" data-testid="synced-pill">
        ✓ All changes synced
      </span>
    ) : null;
  }
  const n = pending;
  const offline = !online || !sync.connected;
  // Online and just waiting for the server to confirm a keystroke: say nothing.
  if (!offline && n <= 2) return null;
  return (
    <span className={`status-pill ${offline ? "offline" : ""}`} data-testid="offline-pill" title="Edits are kept on this device and merge with everyone else's when you reconnect">
      {offline ? (
        <>
          <span className="pill-dot" /> Offline · {n ? `${n} change${n === 1 ? "" : "s"} saved on this device` : "saved on this device"}
        </>
      ) : n ? (
        `Syncing ${n} change${n === 1 ? "" : "s"}…`
      ) : (
        "Connecting…"
      )}
    </span>
  );
}
