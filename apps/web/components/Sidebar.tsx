"use client";
import type { Block } from "@leaf/shared";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useOnline, useSavedPages, useWarmState } from "@/lib/offline";
import { logout, useTheme, type Session } from "@/lib/session";
import { childPages, getState, isAlive, pageTitle, upsertBlocks, useWorkspace } from "@/lib/store";
import { Avatar, EmojiPicker, Icon, Popover } from "./ui";

const navigate = (id: string | null) => window.dispatchEvent(new CustomEvent("leaf-navigate", { detail: id }));

function useExpanded() {
  const [open, setOpen] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("leaf:expanded") ?? "[]"));
    } catch {
      return new Set();
    }
  });
  const toggle = (id: string, force?: boolean) =>
    setOpen((s) => {
      const n = new Set(s);
      if (force ?? !n.has(id)) n.add(id);
      else n.delete(id);
      localStorage.setItem("leaf:expanded", JSON.stringify([...n]));
      return n;
    });
  return { open, toggle };
}

export async function createPage(workspaceId: string, parentId: string | null) {
  const r = await api<{ page: Block }>("POST", "/api/pages", { workspaceId, parentId, title: "" });
  upsertBlocks([r.page]);
  navigate(r.page.id);
  return r.page;
}

type DropMode = "before" | "inside" | "after";

export function Sidebar({
  session,
  workspaceId,
  currentId,
  onClose,
  onSearch,
  onTrash,
  onSettings,
}: {
  session: Session;
  workspaceId: string;
  currentId: string | null;
  onClose: () => void;
  onSearch: () => void;
  onTrash: () => void;
  onSettings: () => void;
}) {
  const roots = useWorkspace((s) => childPages(s, null));
  const favorites = useWorkspace((s) => s.favorites.map((id) => s.blocks[id]).filter((b): b is Block => !!b && isAlive(s, b.id)));
  const connected = useWorkspace((s) => s.connected);
  const online = useOnline();
  const saved = useSavedPages();
  const { open, toggle } = useExpanded();
  const [wsMenu, setWsMenu] = useState<HTMLElement | null>(null);
  const [theme, setTheme] = useTheme();
  const dragId = useRef<string | null>(null);
  const ws = session.workspaces.find((w) => w.id === workspaceId);

  // Reveal the current page in the tree.
  useEffect(() => {
    if (!currentId) return;
    let cur = getState().blocks[currentId];
    while (cur?.parent_id) {
      const parent = getState().blocks[cur.parent_id];
      if (parent?.type === "page") toggle(parent.id, true);
      cur = parent;
    }
  }, [currentId]); // eslint-disable-line react-hooks/exhaustive-deps

  const drop = async (target: Block | null, mode: DropMode) => {
    const id = dragId.current;
    dragId.current = null;
    if (!id || id === target?.id) return;
    let parentId: string | null;
    let beforeId: string | null = null;
    if (!target) parentId = null;
    else if (mode === "inside") {
      parentId = target.id;
      toggle(target.id, true);
    } else {
      parentId = target.parent_id;
      const sibs = childPages(getState(), parentId).filter((b) => b.id !== id);
      const idx = sibs.findIndex((b) => b.id === target.id);
      beforeId = mode === "before" ? target.id : (sibs[idx + 1]?.id ?? null);
    }
    try {
      await api("POST", `/api/pages/${id}/move`, { parentId, beforeId });
    } catch (e: any) {
      alert(e.message);
    }
  };

  return (
    <aside className="sidebar" data-testid="sidebar">
      <div className="sb-top">
        <button className="ws-switch" onClick={(e) => setWsMenu(e.currentTarget)}>
          <span className="ws-icon">{ws?.icon ?? "🌿"}</span>
          <span className="ws-name">{ws?.name ?? "Workspace"}</span>
          <span className={`conn-dot ${connected ? "on" : ""}`} title={connected ? "Live" : "Reconnecting…"} />
        </button>
        <button className="icon-btn" title="Close sidebar" onClick={onClose}>
          <Icon name="doubleLeft" size={14} />
        </button>
      </div>
      {ws?.expires_at && <SandboxBanner workspaceId={workspaceId} expiresAt={ws.expires_at} />}
      <div className="sb-actions">
        <button className="sb-item" onClick={onSearch} data-testid="open-search">
          <Icon name="search" size={15} /> Search <kbd>⌘K</kbd>
        </button>
        <button className="sb-item" onClick={onSettings}>
          <Icon name="settings" size={15} /> Settings & members
        </button>
        <button className="sb-item" onClick={() => void createPage(workspaceId, null)} data-testid="new-page">
          <Icon name="plus" size={15} /> New page
        </button>
      </div>
      <div className="sb-scroll">
        {favorites.length > 0 && (
          <div className="sb-section">
            <div className="sb-label">Favorites</div>
            {favorites.map((b) => (
              <button
                key={b.id}
                className={`sb-item tree-row ${b.id === currentId ? "active" : ""} ${!online && !saved[b.id] ? "unavailable" : ""}`}
                title={!online && !saved[b.id] ? "Not saved on this device" : undefined}
                onClick={() => (online || saved[b.id]) && navigate(b.id)}
              >
                <span className="tree-icon">{b.properties.icon || "📄"}</span>
                <span className="tree-title">{pageTitle(b)}</span>
              </button>
            ))}
          </div>
        )}
        <div className="sb-section">
          <div className="sb-label">
            Workspace
            <button className="icon-btn tiny" title="New page" onClick={() => void createPage(workspaceId, null)}>
              <Icon name="plus" size={12} />
            </button>
          </div>
          <div className="tree" data-testid="page-tree">
            {roots.map((b) => (
              <TreeItem key={b.id} page={b} depth={0} currentId={currentId} open={open} toggle={toggle} workspaceId={workspaceId} dragId={dragId} onDrop={drop} />
            ))}
            <div
              className="tree-root-drop"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void drop(null, "after");
              }}
            />
          </div>
        </div>
      </div>
      <OfflineStatus online={online} />
      <div className="sb-bottom">
        <button className="sb-item" onClick={onTrash} data-testid="open-trash">
          <Icon name="trash" size={15} /> Trash
        </button>
        <button className="sb-item" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} data-testid="theme-toggle">
          <Icon name={theme === "dark" ? "sun" : "moon"} size={15} /> {theme === "dark" ? "Light mode" : "Dark mode"}
        </button>
      </div>
      {wsMenu && (
        <Popover anchor={wsMenu} onClose={() => setWsMenu(null)} className="menu ws-menu">
          {session.user && (
            <div className="ws-user">
              <Avatar name={session.user.name} color={session.user.color} />
              <div>
                <div>{session.user.name}</div>
                <div className="muted small">{session.user.email}</div>
              </div>
            </div>
          )}
          <div className="menu-label">Workspaces</div>
          {session.workspaces.map((w) => (
            <button key={w.id} className={`menu-item compact ${w.id === workspaceId ? "active" : ""}`} onClick={() => (location.href = `/w/${w.id}`)}>
              <span className="menu-icon small">{w.icon}</span> <span className="menu-title">{w.name}</span>
            </button>
          ))}
          <div className="menu-sep" />
          <button className="menu-item compact" onClick={() => void logout().then(() => (location.href = "/login"))} data-testid="logout">
            <Icon name="logout" size={14} /> <span className="menu-title">Log out</span>
          </button>
        </Popover>
      )}
    </aside>
  );
}

function TreeItem({
  page,
  depth,
  currentId,
  open,
  toggle,
  workspaceId,
  dragId,
  onDrop,
}: {
  page: Block;
  depth: number;
  currentId: string | null;
  open: Set<string>;
  toggle: (id: string, force?: boolean) => void;
  workspaceId: string;
  dragId: React.MutableRefObject<string | null>;
  onDrop: (target: Block, mode: DropMode) => void;
}) {
  const kids = useWorkspace((s) => childPages(s, page.id));
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [emoji, setEmoji] = useState<HTMLElement | null>(null);
  const [dropMode, setDropMode] = useState<DropMode | null>(null);
  const isOpen = open.has(page.id);
  const online = useOnline();
  const saved = useSavedPages();
  const unavailable = !online && !saved[page.id];

  const rename = async (title: string) => {
    setRenaming(false);
    if (title !== page.properties.title) {
      const r = await api<{ page: Block }>("PATCH", `/api/pages/${page.id}`, { title });
      upsertBlocks([r.page]);
    }
  };

  return (
    <div className="tree-node">
      <div
        className={`tree-row sb-item ${page.id === currentId ? "active" : ""} ${dropMode ? `drop-${dropMode}` : ""} ${unavailable ? "unavailable" : ""}`}
        title={unavailable ? "Not saved on this device" : undefined}
        style={{ paddingLeft: 8 + depth * 14 }}
        draggable={!renaming}
        data-testid="tree-row"
        data-page-id={page.id}
        onDragStart={(e) => {
          dragId.current = page.id;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", page.id);
        }}
        onDragOver={(e) => {
          if (!dragId.current || dragId.current === page.id) return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          const y = (e.clientY - r.top) / r.height;
          setDropMode(y < 0.25 ? "before" : y > 0.75 ? "after" : "inside");
        }}
        onDragLeave={() => setDropMode(null)}
        onDrop={(e) => {
          e.preventDefault();
          const m = dropMode ?? "inside";
          setDropMode(null);
          onDrop(page, m);
        }}
        onClick={() => !renaming && !unavailable && navigate(page.id)}
        onDoubleClick={() => {
          setName(page.properties.title ?? "");
          setRenaming(true);
        }}
      >
        <button
          className={`tree-toggle ${isOpen ? "open" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            toggle(page.id);
          }}
          aria-label="Expand"
        >
          <Icon name="chevron" size={12} />
        </button>
        <button
          className="tree-icon"
          onClick={(e) => {
            e.stopPropagation();
            setEmoji(e.currentTarget);
          }}
        >
          {page.properties.icon || "📄"}
        </button>
        {renaming ? (
          <input
            className="tree-rename"
            autoFocus
            value={name}
            data-testid="tree-rename"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void rename(name)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void rename(name);
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <span className="tree-title">{pageTitle(page)}</span>
        )}
        <span className="tree-actions">
          <button
            className="icon-btn tiny"
            title="More"
            data-testid="tree-more"
            onClick={(e) => {
              e.stopPropagation();
              setMenu(e.currentTarget);
            }}
          >
            <Icon name="dots" size={13} />
          </button>
          <button
            className="icon-btn tiny"
            title="Add a page inside"
            data-testid="tree-add"
            onClick={(e) => {
              e.stopPropagation();
              toggle(page.id, true);
              void createPage(workspaceId, page.id);
            }}
          >
            <Icon name="plus" size={13} />
          </button>
        </span>
      </div>
      {isOpen && (
        <div className="tree-children">
          {kids.length ? (
            kids.map((k) => <TreeItem key={k.id} page={k} depth={depth + 1} currentId={currentId} open={open} toggle={toggle} workspaceId={workspaceId} dragId={dragId} onDrop={onDrop} />)
          ) : (
            <div className="tree-empty" style={{ paddingLeft: 30 + depth * 14 }}>
              No pages inside
            </div>
          )}
        </div>
      )}
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)} className="menu">
          <button
            className="menu-item compact"
            onClick={() => {
              setMenu(null);
              setName(page.properties.title ?? "");
              setRenaming(true);
            }}
          >
            <span className="menu-title">Rename</span>
          </button>
          <button
            className="menu-item compact"
            onClick={() => {
              const el = menu;
              setMenu(null);
              setEmoji(el);
            }}
          >
            <span className="menu-title">Change icon</span>
          </button>
          <button
            className="menu-item compact danger"
            data-testid="tree-delete"
            onClick={() => {
              setMenu(null);
              void api("DELETE", `/api/pages/${page.id}`).then(() => {
                if (page.id === currentId) navigate(page.parent_id);
              });
            }}
          >
            <Icon name="trash" size={14} /> <span className="menu-title">Move to trash</span>
          </button>
        </Popover>
      )}
      {emoji && (
        <EmojiPicker
          anchor={emoji}
          onClose={() => setEmoji(null)}
          onPick={(icon) => {
            setEmoji(null);
            void api<{ page: Block }>("PATCH", `/api/pages/${page.id}`, { icon }).then((r) => upsertBlocks([r.page]));
          }}
        />
      )}
    </div>
  );
}

/** Offline mode: what's on this device, and the background download's progress. */
function OfflineStatus({ online }: { online: boolean }) {
  const saved = useSavedPages();
  const warm = useWarmState();
  const pages = useWorkspace((s) => Object.keys(saved).filter((id) => s.blocks[id]?.type === "page" && !s.blocks[id]!.archived).length);
  if (online && !warm.running) return null;
  return (
    <div className={`offline-status ${online ? "" : "off"}`} data-testid="offline-status">
      {online ? (
        <>
          <Icon name="download" size={13} /> Saving pages for offline… {warm.done}/{warm.total}
        </>
      ) : (
        <>
          <span className="pill-dot" /> Offline · {pages} page{pages === 1 ? "" : "s"} on this device
        </>
      )}
    </div>
  );
}

/** Guest sandboxes: how long they last, and an invite link to bring someone in. */
function SandboxBanner({ workspaceId, expiresAt }: { workspaceId: string; expiresAt: number }) {
  const [link, setLink] = useState<string | null>(null);
  const hours = Math.max(1, Math.round((expiresAt - Date.now()) / 3_600_000));
  const invite = async () => {
    const { token } = await api<{ token: string }>("POST", `/api/workspaces/${workspaceId}/join-links`);
    const url = `${location.origin}/join/${token}`;
    setLink(url);
    void navigator.clipboard?.writeText(url).catch(() => {});
  };
  return (
    <div className="sandbox" data-testid="sandbox-banner">
      <div>
        <strong>Your demo sandbox</strong> <span className="muted">· resets in {hours}h</span>
      </div>
      {link ? (
        <div className="sandbox-link">
          <input className="input" readOnly value={link} onFocus={(e) => e.currentTarget.select()} data-testid="invite-link" />
          <span className="muted small">Copied. Open it in a private window (or send it to a friend) to edit together.</span>
        </div>
      ) : (
        <button className="btn small block" onClick={() => void invite()} data-testid="invite-btn">
          <Icon name="link" size={13} /> Invite a collaborator
        </button>
      )}
    </div>
  );
}
