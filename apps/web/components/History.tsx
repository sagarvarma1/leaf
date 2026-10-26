"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { onWorkspaceEvent } from "@/lib/store";
import { Modal } from "./ui";

interface Version {
  id: string;
  title: string;
  label: string | null;
  created_at: number;
  author_name: string | null;
}

/** Tiny Markdown renderer for version previews (headings, lists, quotes, code, paragraphs). */
function renderMarkdown(md: string) {
  const out: React.ReactNode[] = [];
  const lines = md.split("\n");
  let i = 0;
  let key = 0;
  const inline = (s: string) =>
    s
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/(^|\s)_(.+?)_(?=\s|$)/g, "$1$2")
      .replace(/~~(.+?)~~/g, "$1")
      .replace(/<\/?u>/g, "")
      .replace(/\[(.+?)\]\((.+?)\)/g, "$1");
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
      out.push(<pre key={key++}>{code.join("\n")}</pre>);
    } else if (/^#{1,4} /.test(l)) {
      const level = l.match(/^#+/)![0].length;
      const Tag = (["h1", "h1", "h2", "h3"][level - 1] ?? "h3") as "h1";
      out.push(<Tag key={key++}>{inline(l.replace(/^#+ /, ""))}</Tag>);
    } else if (/^\s*- \[[ x]\] /.test(l)) {
      out.push(
        <div key={key++} className="md-todo">
          {l.includes("[x]") ? "☑" : "☐"} {inline(l.replace(/^\s*- \[[ x]\] /, ""))}
        </div>,
      );
    } else if (/^\s*([-*]|\d+\.) /.test(l)) {
      out.push(
        <div key={key++} className="md-li" style={{ paddingLeft: (l.match(/^\s*/)![0].length / 2) * 18 + 4 }}>
          • {inline(l.replace(/^\s*([-*]|\d+\.) /, ""))}
        </div>,
      );
    } else if (l.startsWith("> ")) {
      out.push(<blockquote key={key++}>{inline(l.slice(2))}</blockquote>);
    } else if (l === "---") {
      out.push(<hr key={key++} />);
    } else if (l.trim() && !l.startsWith("<")) {
      out.push(<p key={key++}>{inline(l)}</p>);
    }
    i++;
  }
  return out;
}

export function HistoryModal({ pageId, canRestore, onClose }: { pageId: string; canRestore: boolean; onClose: () => void }) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ markdown: string; title: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<{ versions: Version[] }>("GET", `/api/pages/${pageId}/versions`).then((r) => {
      setVersions(r.versions);
      setSelected((s) => s ?? r.versions[0]?.id ?? null);
    });
  }, [pageId]);
  useEffect(() => {
    load();
    return onWorkspaceEvent("versions", (e) => e.pageId === pageId && load());
  }, [pageId, load]);
  useEffect(() => {
    if (!selected) return setPreview(null);
    api<{ markdown: string; title: string }>("GET", `/api/versions/${selected}`).then(setPreview);
  }, [selected]);

  return (
    <Modal onClose={onClose} className="history-modal" testId="history-modal">
      <div className="history">
        <div className="history-preview">{preview ? <div className="md-preview">{renderMarkdown(preview.markdown)}</div> : <div className="muted">No versions yet.</div>}</div>
        <div className="history-list">
          <div className="history-head">
            <strong>Version history</strong>
            {canRestore && (
              <button className="btn small" onClick={() => void api("POST", `/api/pages/${pageId}/versions`, { label: "Saved version" }).then(load)} data-testid="save-version">
                Save version
              </button>
            )}
          </div>
          <div className="history-items">
            {versions.map((v) => (
              <button key={v.id} className={`history-item ${v.id === selected ? "active" : ""}`} onClick={() => setSelected(v.id)} data-testid="version-item">
                <div>{new Date(v.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>
                <div className="muted small">
                  {v.label ?? "Autosave"} · {v.author_name ?? "Leaf"}
                </div>
              </button>
            ))}
          </div>
          {canRestore && selected && (
            <button
              className="btn primary"
              disabled={busy}
              data-testid="restore-version"
              onClick={async () => {
                setBusy(true);
                await api("POST", `/api/versions/${selected}/restore`);
                setBusy(false);
                onClose();
              }}
            >
              Restore this version
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
