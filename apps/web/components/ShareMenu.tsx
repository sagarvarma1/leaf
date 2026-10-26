"use client";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { refreshMembers, useWorkspace } from "@/lib/store";
import { Avatar, Popover } from "./ui";

export function ShareMenu({ pageId, workspaceId, anchor, onClose }: { pageId: string; workspaceId: string; anchor: HTMLElement; onClose: () => void }) {
  const members = useWorkspace((s) => s.members);
  const [share, setShare] = useState<{ token: string; access: "view" | "edit"; enabled: number } | null>(null);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    api<{ share: any }>("GET", `/api/pages/${pageId}/share`).then((r) => setShare(r.share));
  }, [pageId]);
  const update = async (enabled: boolean, access: "view" | "edit") => {
    const r = await api<{ share: any }>("PUT", `/api/pages/${pageId}/share`, { enabled, access });
    setShare(r.share);
  };
  const link = share ? `${location.origin}/s/${share.token}` : "";
  return (
    <Popover anchor={anchor} onClose={onClose} placement="bottom-end" className="share-pop" testId="share-menu">
      <div className="share-section">
        <div className="share-title">Invite to workspace</div>
        <div className="row">
          <input className="input" placeholder="Email of a Leaf user" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button
            className="btn primary small"
            onClick={async () => {
              try {
                await api("POST", `/api/workspaces/${workspaceId}/members`, { email });
                setEmail("");
                setMsg("Added to the workspace.");
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
              <span>{m.name}</span>
              <span className="muted small">{m.email}</span>
              <span className="muted small right">{m.role === "owner" ? "Owner" : "Can edit"}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="share-section">
        <div className="row spread">
          <div>
            <div className="share-title">Share to web</div>
            <div className="muted small">Anyone with the link can {share?.access === "edit" ? "edit (after signing in)" : "view"} this page and its sub-pages.</div>
          </div>
          <label className="switch">
            <input type="checkbox" checked={Boolean(share?.enabled)} onChange={(e) => void update(e.target.checked, share?.access ?? "view")} data-testid="share-toggle" />
            <span />
          </label>
        </div>
        {share?.enabled ? (
          <>
            <div className="row">
              <input className="input" readOnly value={link} data-testid="share-link" onFocus={(e) => e.target.select()} />
              <button
                className="btn small"
                onClick={() => {
                  void navigator.clipboard?.writeText(link);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <select className="input" value={share.access} onChange={(e) => void update(true, e.target.value as "view" | "edit")} data-testid="share-access">
              <option value="view">Can view</option>
              <option value="edit">Can edit</option>
            </select>
          </>
        ) : null}
      </div>
    </Popover>
  );
}
