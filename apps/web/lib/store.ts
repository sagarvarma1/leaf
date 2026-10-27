"use client";
/**
 * Client cache of the workspace structure: every page, database and row block (no
 * content blocks; those load into the sync client per page). Kept fresh by the server's
 * event stream, so the sidebar, breadcrumbs, page links and databases update live.
 */
import type { Block } from "@leaf/shared";
import { useRef, useSyncExternalStore } from "react";
import { api, wsBase, wsTicket } from "./api";
import { currentSync } from "./sync";

export interface User {
  id: string;
  name: string;
  email: string;
  color: string;
  role?: string;
}

export interface WorkspaceState {
  workspaceId: string | null;
  root: string[];
  blocks: Record<string, Block>;
  favorites: string[];
  members: User[];
  loaded: boolean;
  connected: boolean;
}

type Listener = () => void;
let state: WorkspaceState = { workspaceId: null, root: [], blocks: {}, favorites: [], members: [], loaded: false, connected: false };
const listeners = new Set<Listener>();
const bus = new EventTarget();

function set(patch: Partial<WorkspaceState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const getState = () => state;
export function subscribe(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  return false;
}

/**
 * Subscribe to a slice of the store. Selectors may build new arrays (child pages,
 * database rows); results are cached and compared shallowly so React sees a stable
 * snapshot and only re-renders when the slice really changed.
 */
export function useWorkspace<T>(selector: (s: WorkspaceState) => T): T {
  const cache = useRef<{ state: WorkspaceState; selector: (s: WorkspaceState) => T; value: T } | null>(null);
  const get = () => {
    const c = cache.current;
    if (c && c.state === state && c.selector === selector) return c.value;
    const value = selector(state);
    if (c && shallowEqual(c.value, value)) {
      cache.current = { state, selector, value: c.value };
      return c.value;
    }
    cache.current = { state, selector, value };
    return value;
  };
  return useSyncExternalStore(subscribe, get, get);
}

export function useBlock(id: string | null | undefined): Block | undefined {
  return useWorkspace((s) => (id ? s.blocks[id] : undefined));
}

/** Listen for comment/version events for a page. */
export function onWorkspaceEvent(type: "comments" | "versions" | "members" | "ai", fn: (e: any) => void) {
  const h = (ev: Event) => fn((ev as CustomEvent).detail);
  bus.addEventListener(type, h);
  return () => bus.removeEventListener(type, h);
}

export function upsertBlocks(blocks: Block[]) {
  if (!blocks.length) return;
  const next = { ...state.blocks };
  for (const b of blocks) {
    const cur = next[b.id];
    // Updates can arrive out of order: keep the newest version of each record.
    if (cur && (cur.version ?? 0) > (b.version ?? 0)) continue;
    next[b.id] = b;
  }
  set({ blocks: next });
}

export function removeBlocks(ids: string[]) {
  const next = { ...state.blocks };
  for (const id of ids) delete next[id];
  set({ blocks: next });
}

export async function refreshTree() {
  if (!state.workspaceId) return;
  const r = await api<{ root: string[]; blocks: Block[] }>("GET", `/api/workspaces/${state.workspaceId}/pages`);
  set({ root: r.root, blocks: Object.fromEntries(r.blocks.map((b) => [b.id, b])), loaded: true });
}

export async function refreshMembers() {
  if (!state.workspaceId) return;
  const r = await api<{ members: User[] }>("GET", `/api/workspaces/${state.workspaceId}/members`);
  set({ members: r.members });
}

export async function refreshFavorites() {
  if (!state.workspaceId) return;
  const r = await api<{ favorites: string[] }>("GET", `/api/workspaces/${state.workspaceId}/favorites`);
  set({ favorites: r.favorites });
}

export const setFavorites = (favorites: string[]) => set({ favorites });

let socket: WebSocket | null = null;
let resume: (() => void) | null = null;

// Going offline: close the socket on purpose. A socket that survives a network change can
// be silently dead; closing it means coming back online always opens a fresh one (and
// catches up), instead of trusting one that may never deliver again.
if (typeof window !== "undefined") window.addEventListener("offline", () => socket?.close());
let retry: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 500;

async function connectEvents(workspaceId: string, share?: string | null) {
  if (!navigator.onLine) {
    // Offline: don't spin on reconnects; resume (and catch up) when the network returns.
    resume = () => {
      resume = null;
      if (state.workspaceId === workspaceId) void connectEvents(workspaceId, share);
    };
    window.addEventListener("online", resume, { once: true });
    return;
  }
  const qs = new URLSearchParams({ workspace: workspaceId });
  if (share) qs.set("share", share);
  const sync = currentSync();
  if (sync) qs.set("session", sync.session);
  const ticket = share ? null : await wsTicket();
  if (ticket) qs.set("ticket", ticket);
  if (state.workspaceId !== workspaceId) return; // switched away while fetching the ticket
  const ws = new WebSocket(`${wsBase()}/ws/events?${qs}`);
  socket = ws;
  ws.onopen = () => {
    retryDelay = 500;
    set({ connected: true });
  };
  ws.onmessage = (msg) => {
    const e = JSON.parse(msg.data);
    if (e.type === "hello") {
      if (!share) void refreshTree(); // catch up on anything missed while disconnected
      // The sync client follows its documents over this socket and catches up on them.
      sync?.attach((m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m)));
    } else if (e.type === "commit" || e.type === "presence") {
      sync?.handleEvent(e);
    } else if (e.type === "blocks") {
      upsertBlocks(e.blocks);
      if (!share && e.blocks.some((b: Block) => b.type === "page" && !b.parent_id && !state.root.includes(b.id))) void refreshTree();
    } else if (e.type === "deleted") removeBlocks(e.ids);
    else bus.dispatchEvent(new CustomEvent(e.type, { detail: e }));
    if (e.type === "members") void refreshMembers();
  };
  ws.onclose = () => {
    set({ connected: false });
    if (socket !== ws) return;
    sync?.attach(null);
    socket = null;
    retry = setTimeout(() => void connectEvents(workspaceId, share), retryDelay);
    retryDelay = Math.min(retryDelay * 2, 8000);
  };
}

export async function openWorkspace(workspaceId: string) {
  if (state.workspaceId === workspaceId && state.loaded) return;
  closeWorkspace();
  set({ workspaceId, loaded: false, blocks: {}, root: [] });
  // Members and favorites are nice-to-haves offline; the tree is required.
  await Promise.all([refreshTree(), refreshMembers().catch(() => {}), refreshFavorites().catch(() => {})]);
  void connectEvents(workspaceId);
}

/** Share-link guests: subscribe to events without loading the whole tree. */
export function openShared(workspaceId: string, token: string, blocks: Block[]) {
  closeWorkspace();
  set({ workspaceId, loaded: true, blocks: Object.fromEntries(blocks.map((b) => [b.id, b])), root: [] });
  void connectEvents(workspaceId, token);
}

export function closeWorkspace() {
  if (retry) clearTimeout(retry);
  if (resume) window.removeEventListener("online", resume);
  resume = null;
  const s = socket;
  socket = null;
  s?.close();
}

// ---------------------------------------------------------------- tree helpers

export function childPages(s: WorkspaceState, parentId: string | null): Block[] {
  const all = Object.values(s.blocks).filter((b) => b.type === "page" && b.parent_id === parentId && !b.archived);
  const order = parentId ? (s.blocks[parentId]?.content ?? []) : s.root;
  const idx = new Map(order.map((id, i) => [id, i]));
  return all.sort((a, b) => (idx.get(a.id) ?? 1e9) - (idx.get(b.id) ?? 1e9) || a.created_at - b.created_at);
}

export function isAlive(s: WorkspaceState, id: string): boolean {
  let cur: Block | undefined = s.blocks[id];
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    if (cur.archived) return false;
    seen.add(cur.id);
    cur = cur.parent_id ? s.blocks[cur.parent_id] : undefined;
  }
  return true;
}

export function databaseRows(s: WorkspaceState, dbId: string): Block[] {
  const db = s.blocks[dbId];
  if (!db) return [];
  const rows = Object.values(s.blocks).filter((b) => b.parent_id === dbId && b.type === "page" && !b.archived);
  const idx = new Map(db.content.map((id, i) => [id, i]));
  return rows.sort((a, b) => (idx.get(a.id) ?? 1e9) - (idx.get(b.id) ?? 1e9) || a.created_at - b.created_at);
}

export const pageTitle = (b: Block | undefined) => (b?.properties.title ? String(b.properties.title) : "Untitled");
