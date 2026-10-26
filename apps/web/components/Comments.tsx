"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { onWorkspaceEvent } from "@/lib/store";
import { Avatar, Icon, timeAgo } from "./ui";

export interface Comment {
  id: string;
  page_id: string;
  block_id: string | null;
  thread_id: string;
  author_id: string;
  author_name: string;
  author_color: string;
  body: string;
  resolved: boolean;
  created_at: number;
}

export function useComments(pageId: string) {
  const [comments, setComments] = useState<Comment[]>([]);
  const load = useCallback(() => {
    api<{ comments: Comment[] }>("GET", `/api/pages/${pageId}/comments`)
      .then((r) => setComments(r.comments))
      .catch(() => {});
  }, [pageId]);
  useEffect(() => {
    load();
    return onWorkspaceEvent("comments", (e) => e.pageId === pageId && load());
  }, [pageId, load]);
  return { comments, reload: load };
}

function blockExcerpt(blockId: string | null): string {
  if (!blockId) return "Page";
  const el = document.querySelector(`.leaf-editor [data-block-id="${blockId}"]`);
  const text = el?.textContent?.trim();
  return text ? (text.length > 70 ? text.slice(0, 70) + "…" : text) : "Deleted block";
}

function focusBlock(blockId: string | null) {
  if (!blockId) return;
  const el = document.querySelector(`.leaf-editor [data-block-id="${blockId}"]`) as HTMLElement | null;
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1200);
}

export function CommentsPanel({
  pageId,
  meId,
  canComment,
  comments,
  draftBlock,
  onDraftDone,
  onClose,
}: {
  pageId: string;
  meId: string | null;
  canComment: boolean;
  comments: Comment[];
  draftBlock: string | null | undefined;
  onDraftDone: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"open" | "resolved">("open");
  const [draft, setDraft] = useState("");
  const threads = useMemo(() => {
    const map = new Map<string, Comment[]>();
    for (const c of comments) {
      if (!map.has(c.thread_id)) map.set(c.thread_id, []);
      map.get(c.thread_id)!.push(c);
    }
    return [...map.values()].filter((t) => (tab === "open" ? !t[0]!.resolved : t[0]!.resolved));
  }, [comments, tab]);

  useEffect(() => {
    if (draftBlock !== undefined) focusBlock(draftBlock);
  }, [draftBlock]);

  const post = async (body: string, extra: Record<string, unknown>) => {
    if (!body.trim()) return;
    await api("POST", `/api/pages/${pageId}/comments`, { body, ...extra });
  };

  return (
    <aside className="side-panel" data-testid="comments-panel">
      <div className="side-head">
        <strong>Comments</strong>
        <div className="seg">
          <button className={tab === "open" ? "on" : ""} onClick={() => setTab("open")}>
            Open
          </button>
          <button className={tab === "resolved" ? "on" : ""} onClick={() => setTab("resolved")}>
            Resolved
          </button>
        </div>
        <button className="icon-btn" onClick={onClose} title="Close">
          <Icon name="x" size={14} />
        </button>
      </div>
      {draftBlock !== undefined && canComment && (
        <div className="thread new">
          <div className="thread-anchor">{blockExcerpt(draftBlock)}</div>
          <textarea
            autoFocus
            className="input"
            placeholder="Add a comment…"
            value={draft}
            data-testid="comment-input"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void post(draft, { blockId: draftBlock }).then(() => {
                  setDraft("");
                  onDraftDone();
                });
              }
            }}
          />
          <div className="thread-actions">
            <button className="btn small" onClick={onDraftDone}>
              Cancel
            </button>
            <button
              className="btn primary small"
              data-testid="comment-send"
              onClick={() =>
                void post(draft, { blockId: draftBlock }).then(() => {
                  setDraft("");
                  onDraftDone();
                })
              }
            >
              Comment
            </button>
          </div>
        </div>
      )}
      {!threads.length && draftBlock === undefined && (
        <div className="empty-note">
          {tab === "open" ? "No open comments. Select text or use a block's ⋮⋮ menu to comment." : "No resolved threads."}
          {canComment && tab === "open" && (
            <button className="link-btn" onClick={() => window.dispatchEvent(new CustomEvent("leaf-comment", { detail: null }))}>
              Comment on the page
            </button>
          )}
        </div>
      )}
      {threads.map((t) => (
        <Thread key={t[0]!.id} thread={t} meId={meId} canComment={canComment} onReply={(b) => post(b, { threadId: t[0]!.id })} />
      ))}
    </aside>
  );
}

function Thread({ thread, meId, canComment, onReply }: { thread: Comment[]; meId: string | null; canComment: boolean; onReply: (body: string) => Promise<void> }) {
  const [reply, setReply] = useState("");
  const root = thread[0]!;
  return (
    <div className="thread" data-testid="comment-thread">
      <button className="thread-anchor" onClick={() => focusBlock(root.block_id)}>
        {blockExcerpt(root.block_id)}
      </button>
      {thread.map((c) => (
        <div key={c.id} className="comment">
          <div className="comment-head">
            <Avatar name={c.author_name} color={c.author_color} size="xs" />
            <strong>{c.author_name}</strong>
            <span className="muted small">{timeAgo(c.created_at)}</span>
            {c.author_id === meId && (
              <button className="icon-btn tiny" title="Delete" onClick={() => void api("DELETE", `/api/comments/${c.id}`)}>
                <Icon name="trash" size={12} />
              </button>
            )}
          </div>
          <div className="comment-body">{c.body}</div>
        </div>
      ))}
      {canComment && (
        <div className="reply">
          <input
            className="input"
            placeholder="Reply…"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && reply.trim()) void onReply(reply).then(() => setReply(""));
            }}
          />
          <button className="btn small" onClick={() => void api("PATCH", `/api/comments/${root.id}`, { resolved: !root.resolved })} data-testid="comment-resolve">
            {root.resolved ? "Reopen" : "Resolve"}
          </button>
        </div>
      )}
    </div>
  );
}
