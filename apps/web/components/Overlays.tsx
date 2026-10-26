"use client";
import type { Block } from "@leaf/shared";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { pageTitle, refreshMembers, useWorkspace } from "@/lib/store";
import { Avatar, Icon, Modal } from "./ui";

const navigate = (id: string | null) => window.dispatchEvent(new CustomEvent("leaf-navigate", { detail: id }));

interface Result {
  id: string;
  title: string;
  icon: string | null;
  snippet: string;
  path: string;
}

function Snippet({ text }: { text: string }) {
  // The server marks matches with \u0002 … \u0003 (never HTML, so nothing to escape).
  const parts = text.split(/(\u0002[^\u0003]*\u0003)/);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("\u0002") ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>,
      )}
    </>
  );
}

export function QuickFind({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [index, setIndex] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    const t = setTimeout(() => {
      api<{ results: Result[] }>("GET", `/api/workspaces/${workspaceId}/search?q=${encodeURIComponent(q)}`).then((r) => {
        if (n === seq.current) {
          setResults(r.results);
          setIndex(0);
        }
      });
    }, 80);
    return () => clearTimeout(t);
  }, [q, workspaceId]);
  const go = (r: Result | undefined) => {
    if (!r) return;
    onClose();
    navigate(r.id);
  };
  return (
    <Modal onClose={onClose} className="quickfind" testId="quickfind">
      <div className="qf-input">
        <Icon name="search" />
        <input
          autoFocus
          placeholder="Search pages and content…"
          value={q}
          data-testid="quickfind-input"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), setIndex((i) => Math.min(i + 1, results.length - 1)));
            if (e.key === "ArrowUp") (e.preventDefault(), setIndex((i) => Math.max(i - 1, 0)));
            if (e.key === "Enter") go(results[index]);
          }}
        />
      </div>
      <div className="qf-results">
        <div className="menu-label">{q ? "Best matches" : "Recently edited"}</div>
        {!results.length && <div className="empty-note">No results for “{q}”.</div>}
        {results.map((r, i) => (
          <button key={r.id} className={`qf-item ${i === index ? "active" : ""}`} onMouseEnter={() => setIndex(i)} onClick={() => go(r)} data-testid="quickfind-result">
            <span className="qf-icon">{r.icon || "📄"}</span>
            <span className="qf-text">
              <span className="qf-title">
                {r.title || "Untitled"}
                {r.path && <span className="muted small"> — {r.path}</span>}
              </span>
              {r.snippet && (
                <span className="qf-snippet">
                  <Snippet text={r.snippet} />
                </span>
              )}
            </span>
          </button>
        ))}
      </div>
      <div className="qf-foot muted small">↑↓ to navigate · ↵ to open · esc to close</div>
    </Modal>
  );
}

export function TrashModal({ onClose }: { onClose: () => void }) {
  const trashed = useWorkspace((s) =>
    Object.values(s.blocks)
      .filter((b) => b.type === "page" && b.archived && !(b.parent_id && s.blocks[b.parent_id]?.archived))
      .sort((a, b) => b.last_edited_at - a.last_edited_at),
  );
  const blocks = useWorkspace((s) => s.blocks);
  return (
    <Modal onClose={onClose} className="trash-modal" testId="trash">
      <div className="modal-head">
        <strong>Trash</strong>
        <button className="icon-btn" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {!trashed.length && <div className="empty-note">Trash is empty.</div>}
      {trashed.map((b: Block) => (
        <div key={b.id} className="trash-item" data-testid="trash-item">
          <span>{b.properties.icon || "📄"}</span>
          <span className="trash-title">
            {pageTitle(b)}
            {b.parent_id && blocks[b.parent_id] && <span className="muted small"> in {pageTitle(blocks[b.parent_id])}</span>}
          </span>
          <button className="btn small" data-testid="trash-restore" onClick={() => void api("POST", `/api/pages/${b.id}/restore`)}>
            Restore
          </button>
          <button
            className="btn small danger"
            onClick={() => {
              if (confirm(`Delete “${pageTitle(b)}” forever?`)) void api("DELETE", `/api/pages/${b.id}/permanent`);
            }}
          >
            Delete
          </button>
        </div>
      ))}
    </Modal>
  );
}

export function SettingsModal({ workspaceId, meId, onClose }: { workspaceId: string; meId: string; onClose: () => void }) {
  const members = useWorkspace((s) => s.members);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Modal onClose={onClose} className="settings-modal">
      <div className="modal-head">
        <strong>Members</strong>
        <button className="icon-btn" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <p className="muted small">Members can view and edit every page in this workspace. Invite people who already have a Leaf account.</p>
      <div className="row">
        <input className="input" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button
          className="btn primary small"
          onClick={async () => {
            try {
              await api("POST", `/api/workspaces/${workspaceId}/members`, { email });
              setEmail("");
              setMsg("Invited.");
              void refreshMembers();
            } catch (e) {
              setMsg(e instanceof ApiError ? e.message : "Could not invite");
            }
          }}
        >
          Invite
        </button>
      </div>
      {msg && <div className="muted small">{msg}</div>}
      <div className="member-list">
        {members.map((m) => (
          <div key={m.id} className="member">
            <Avatar name={m.name} color={m.color} size="xs" />
            <span>
              {m.name}
              {m.id === meId && " (you)"}
            </span>
            <span className="muted small">{m.email}</span>
            <span className="right">
              {m.role === "owner" ? (
                <span className="muted small">Owner</span>
              ) : (
                <button className="btn small" onClick={() => void api("DELETE", `/api/workspaces/${workspaceId}/members/${m.id}`).then(refreshMembers)}>
                  Remove
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
    </Modal>
  );
}
