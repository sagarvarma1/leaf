"use client";
/**
 * Leaf AI panel. A run is started here (or from the slash menu / selection toolbar,
 * which pass the block the user is on); its edits appear in the page itself, typed live
 * by the "Leaf AI" collaborator. The panel shows progress and the answer, and lets anyone
 * who can edit keep or discard the run's changes.
 */
import { inlineMarkdown } from "@leaf/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { onWorkspaceEvent, pageTitle, useWorkspace } from "@/lib/store";
import { Icon, timeAgo } from "./ui";

export interface AiRun {
  id: string;
  pageId: string;
  userId: string;
  userName: string;
  prompt: string;
  status: "running" | "done" | "error" | "kept" | "discarded";
  reviewable: boolean;
  steps: Array<{ label: string; at: number }>;
  answer: string | null;
  error: string | null;
  edits: number;
  model: string;
  startedAt: number;
}

export interface AiStatus {
  enabled: boolean;
  model: string | null;
  mock: boolean;
}

let statusCache: Promise<AiStatus> | null = null;
export function useAiStatus(): AiStatus | null {
  const [s, setS] = useState<AiStatus | null>(null);
  useEffect(() => {
    statusCache ??= api<AiStatus>("GET", "/api/ai/status").catch(() => ({ enabled: false, model: null, mock: false }));
    void statusCache.then(setS);
  }, []);
  return s;
}

/** Runs on a page, kept live by the workspace event stream (everyone sees the AI working). */
export function useAiRuns(pageId: string, enabled: boolean) {
  const [runs, setRuns] = useState<AiRun[]>([]);
  useEffect(() => {
    if (!enabled) return;
    setRuns([]);
    api<{ runs: AiRun[] }>("GET", `/api/pages/${pageId}/ai`)
      .then((r) => setRuns(r.runs))
      .catch(() => {});
    return onWorkspaceEvent("ai", (e: { run: AiRun }) => {
      if (e.run.pageId !== pageId) return;
      setRuns((cur) => {
        const i = cur.findIndex((r) => r.id === e.run.id);
        if (i < 0) return [...cur, e.run];
        const next = [...cur];
        next[i] = e.run;
        return next;
      });
    });
  }, [pageId, enabled]);
  return runs;
}

const SUGGESTIONS = [
  "Summarize this page",
  "Turn this page into an action-item checklist",
  "What's the status of the roadmap?",
  "Draft a short launch announcement at the end",
];

export function AiPanel({ pageId, blockId, onClose }: { pageId: string; blockId: string | null; onClose: () => void }) {
  const status = useAiStatus();
  const runs = useAiRuns(pageId, Boolean(status?.enabled));
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const running = runs.some((r) => r.status === "running");

  useEffect(() => {
    input.current?.focus();
  }, [blockId]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [runs]);

  const ask = useCallback(
    async (text: string) => {
      if (!text.trim() || busy) return;
      setBusy(true);
      setError(null);
      try {
        await api("POST", `/api/pages/${pageId}/ai`, { prompt: text, blockId });
        setPrompt("");
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Couldn't reach Leaf AI");
      } finally {
        setBusy(false);
      }
    },
    [pageId, blockId, busy],
  );

  return (
    <aside className="side-panel ai-panel" data-testid="ai-panel">
      <div className="side-head">
        <strong className="ai-title">
          <Icon name="sparkle" size={15} /> Leaf AI
        </strong>
        {status?.mock && (
          <span className="ai-badge" title="LEAF_AI_MOCK=1: a scripted stand-in for Claude">
            demo model
          </span>
        )}
        <button className="icon-btn" onClick={onClose} title="Close" style={{ marginLeft: "auto" }}>
          <Icon name="x" size={14} />
        </button>
      </div>

      {status && !status.enabled ? (
        <div className="empty-note">Leaf AI isn't set up on this server. Set ANTHROPIC_API_KEY for the API server and restart it.</div>
      ) : (
        <>
          {!runs.length && (
            <div className="ai-intro">
              <p className="muted small">Leaf AI edits this page alongside you. Watch its cursor, keep what you like, or discard it in one click (your own edits stay).</p>
              {SUGGESTIONS.map((s) => (
                <button key={s} className="ai-suggestion" onClick={() => void ask(s)} data-testid="ai-suggestion">
                  <Icon name="sparkle" size={12} /> {s}
                </button>
              ))}
            </div>
          )}
          <div className="ai-runs">
            {runs.map((r) => (
              <RunCard key={r.id} run={r} />
            ))}
            <div ref={end} />
          </div>
          <div className="ai-compose">
            {blockId && <div className="ai-context muted small">Working from the block you're on</div>}
            <textarea
              ref={input}
              className="input"
              rows={2}
              placeholder={running ? "Leaf AI is working…" : "Ask Leaf AI to write, edit, or find something…"}
              value={prompt}
              disabled={running}
              data-testid="ai-input"
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void ask(prompt);
                }
              }}
            />
            {error && <div className="ai-error small">{error}</div>}
          </div>
        </>
      )}
    </aside>
  );
}

function RunCard({ run }: { run: AiRun }) {
  const act = (action: "stop" | "keep" | "discard") => void api("POST", `/api/ai/runs/${run.id}/${action}`).catch(() => {});
  return (
    <div className={`ai-run ${run.status}`} data-testid="ai-run" data-status={run.status}>
      <div className="ai-prompt">
        <span className="muted small">
          {run.userName} · {timeAgo(run.startedAt)}
        </span>
        <div>{run.prompt}</div>
      </div>
      {run.steps.length > 0 && (
        <ul className="ai-steps">
          {run.steps.map((s, i) => (
            <li key={i} className={run.status === "running" && i === run.steps.length - 1 ? "active" : ""}>
              {s.label}
            </li>
          ))}
        </ul>
      )}
      {run.status === "running" && (
        <div className="ai-working">
          <span className="ai-dots" /> Working…
          <button className="link-btn" onClick={() => act("stop")}>
            Stop
          </button>
        </div>
      )}
      {run.answer && (
        <div className="ai-answer" data-testid="ai-answer">
          <Answer text={run.answer} />
        </div>
      )}
      {run.error && <div className="ai-error small">{run.error}</div>}
      {run.reviewable && (
        <div className="ai-review">
          <button className="btn primary small" onClick={() => act("keep")} data-testid="ai-keep">
            Keep
          </button>
          <button className="btn small" onClick={() => act("discard")} data-testid="ai-discard">
            Discard changes
          </button>
        </div>
      )}
      {run.status === "kept" && <div className="muted small">Kept</div>}
      {run.status === "discarded" && <div className="muted small">Discarded: the page is back the way it was, with everyone else's edits in place.</div>}
    </div>
  );
}

/** The model's answer: short Markdown with links to Leaf pages (citations). */
function Answer({ text }: { text: string }) {
  const blocks = useWorkspace((s) => s.blocks);
  return (
    <>
      {text.split(/\n+/).map((line, i) => {
        const bullet = /^\s*[-*]\s+/.test(line);
        const runs = inlineMarkdown(line.replace(/^\s*[-*]\s+/, ""));
        const body = runs.map((r, j) => {
          if (r.mention?.type === "page") {
            const id = r.mention.id;
            return (
              <button key={j} className="ai-cite" onClick={() => window.dispatchEvent(new CustomEvent("leaf-navigate", { detail: id }))} data-testid="ai-citation">
                ↗ {blocks[id] ? pageTitle(blocks[id]) : r.text}
              </button>
            );
          }
          const m = r.marks ?? {};
          let node: React.ReactNode = r.text;
          if (m.code) node = <code>{node}</code>;
          if (m.bold) node = <strong>{node}</strong>;
          if (m.italic) node = <em>{node}</em>;
          if (m.link) node = <a href={m.link} target="_blank" rel="noopener noreferrer">{node}</a>;
          return <span key={j}>{node}</span>;
        });
        return bullet ? (
          <div key={i} className="ai-bullet">
            • {body}
          </div>
        ) : (
          <p key={i}>{body}</p>
        );
      })}
    </>
  );
}
