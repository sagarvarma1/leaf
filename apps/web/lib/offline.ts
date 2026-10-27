"use client";
/*
 * Offline mode.
 *
 * Two layers, deliberately separate (as in "How we made Notion available offline"):
 *  1. Content: the sync client's RecordCache keeps each page's records and text in
 *     IndexedDB; `warmWorkspace` downloads pages in the background, and they stay
 *     followed so their copies keep up. Edits made offline wait in the TransactionQueue
 *     (also IndexedDB) and are sent on reconnect: text merges as CRDT ops, structure is
 *     ordered by the server.
 *  2. Shell: public/sw.js serves the app (HTML, JS, read-only API responses) from cache
 *     when the network is down, so a reload or a cold start works on a plane.
 *
 * Each page is kept for one or more reasons (favorite, recently visited, part of the
 * workspace's top pages), like Notion's offline page trees; it's dropped only when no
 * reason is left. Database edits and comments still need the server.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { Block } from "@leaf/shared";
import { clearSyncData, type SyncClient } from "./sync";

// ---------------------------------------------------------------- network state

const netListeners = new Set<() => void>();
if (typeof window !== "undefined") {
  const fire = () => netListeners.forEach((l) => l());
  window.addEventListener("online", fire);
  window.addEventListener("offline", fire);
}

export const isOnline = () => (typeof navigator === "undefined" ? true : navigator.onLine);

export function useOnline(): boolean {
  return useSyncExternalStore(
    (l) => {
      netListeners.add(l);
      return () => netListeners.delete(l);
    },
    isOnline,
    () => true,
  );
}

// ---------------------------------------------------------------- saved pages

const SAVED_KEY = "leaf:offline";
/** page id -> when its cached copy last matched the server (Notion's lastDownloadedTimestamp). */
type Saved = Record<string, number>;
const REASONS_KEY = "leaf:offline-reasons";
export type OfflineReason = "favorite" | "recent" | "workspace" | "inherited";
let saved: Saved = {};
const savedListeners = new Set<() => void>();

function loadSaved() {
  try {
    saved = JSON.parse(localStorage.getItem(SAVED_KEY) ?? "{}");
  } catch {
    saved = {};
  }
}
if (typeof window !== "undefined") loadSaved();

export function markSaved(pageId: string) {
  saved = { ...saved, [pageId]: Date.now() };
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(saved));
  } catch {}
  savedListeners.forEach((l) => l());
}

export const isSaved = (pageId: string) => pageId in saved;

export function useSavedPages(): Saved {
  return useSyncExternalStore(
    (l) => {
      savedListeners.add(l);
      return () => savedListeners.delete(l);
    },
    () => saved,
    () => saved,
  );
}

// ---------------------------------------------------------------- service worker

function sw(): ServiceWorker | null {
  return typeof navigator !== "undefined" ? (navigator.serviceWorker?.controller ?? null) : null;
}

/** Ask the service worker to fetch and keep these URLs (no-op without one). */
export function keepUrls(urls: string[]) {
  sw()?.postMessage({ type: "cache", urls });
}

/** Register the worker once per load, and hand it what this page loaded before it took control. */
export function useServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || process.env.NEXT_PUBLIC_LEAF_SW === "0") return;
    void navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready);
    const seed = () => {
      const urls = performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .filter((u) => u.startsWith(location.origin));
      // Also requests made before the worker took control (the session, the page tree).
      keepUrls([location.pathname, "/api/auth/me", ...urls]);
    };
    if (navigator.serviceWorker.controller) seed();
    else navigator.serviceWorker.addEventListener("controllerchange", seed, { once: true });
  }, []);
}

// ---------------------------------------------------------------- background download

export interface WarmState {
  running: boolean;
  done: number;
  total: number;
}
let warm: WarmState = { running: false, done: 0, total: 0 };
const warmListeners = new Set<() => void>();
const setWarm = (w: Partial<WarmState>) => {
  warm = { ...warm, ...w };
  (window as any).__leafWarm = warm;
  warmListeners.forEach((l) => l());
};
export function useWarmState(): WarmState {
  return useSyncExternalStore(
    (l) => {
      warmListeners.add(l);
      return () => warmListeners.delete(l);
    },
    () => warm,
    () => warm,
  );
}

/**
 * Why each page is kept offline (Notion's offline_action rows): a page stays while any
 * reason remains. Recomputed on every warm-up from favorites, recent visits and the
 * workspace's top pages; sub-pages of a kept page are kept as "inherited".
 */
export function offlineReasons(): Record<string, OfflineReason[]> {
  try {
    return JSON.parse(localStorage.getItem(REASONS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function setReasons(r: Record<string, OfflineReason[]>) {
  try {
    localStorage.setItem(REASONS_KEY, JSON.stringify(r));
  } catch {}
}

const MAX_WARM = 80;
let warmToken = 0;

/**
 * Download the workspace for offline use: favorites and recent pages first, then the rest
 * of the tree, skipping pages whose replica is already newer than their last edit. Runs
 * one page at a time in the background; switching workspaces cancels it.
 */
export async function warmWorkspace(sync: SyncClient, workspaceId: string, blocks: Record<string, Block>, favorites: string[], recent: string[]) {
  const token = ++warmToken;
  if (!isOnline()) return;
  const alive = (b: Block | undefined) => !!b && b.type === "page" && !b.archived;
  // Reasons, then an order: favorites and recent pages first, then the rest of the tree.
  const reasons: Record<string, OfflineReason[]> = {};
  const add = (id: string, r: OfflineReason) => alive(blocks[id]) && (reasons[id] = [...new Set([...(reasons[id] ?? []), r])]);
  favorites.forEach((id) => add(id, "favorite"));
  recent.forEach((id) => add(id, "recent"));
  Object.values(blocks)
    .filter((b) => alive(b) && !b.parent_id)
    .forEach((b) => add(b.id, "workspace"));
  for (const id of Object.keys(reasons)) {
    for (const child of Object.values(blocks)) if (alive(child) && child.parent_id === id) add(child.id, "inherited");
  }
  const order = [...new Set([...favorites, ...recent, ...Object.keys(reasons), ...Object.values(blocks).filter(alive).map((b) => b.id)])]
    .filter((id) => alive(blocks[id]))
    .slice(0, MAX_WARM);
  for (const id of order) if (!reasons[id]) reasons[id] = ["workspace"];
  setReasons(reasons);

  // Refetch only pages edited since they were last downloaded.
  const stale = order.filter((id) => !(saved[id] && saved[id]! >= (blocks[id]!.last_edited_at ?? 0)));
  const databases = Object.values(blocks).filter((b) => b.type === "database" && !b.archived);
  setWarm({ running: true, done: order.length - stale.length, total: order.length });

  // The shell for every page, plus read-only data views render from.
  keepUrls([
    `/api/workspaces/${workspaceId}/pages`,
    `/api/workspaces/${workspaceId}/members`,
    `/api/workspaces/${workspaceId}/favorites`,
    ...order.flatMap((id) => [`/w/${workspaceId}/${id}`, `/api/pages/${id}`, `/api/pages/${id}/comments`]),
    ...databases.map((d) => `/api/databases/${d.id}`),
  ]);

  for (const id of stale) {
    if (token !== warmToken || !isOnline()) break;
    try {
      await sync.keepDoc(id);
      markSaved(id);
    } catch {
      // Skip pages we can't reach (deleted, permissions changed); the next run retries.
    }
    if (token === warmToken) setWarm({ done: warm.done + 1 });
  }
  if (token === warmToken) setWarm({ running: false });
}

export const cancelWarm = () => void ++warmToken;

// ---------------------------------------------------------------- recent pages

const RECENT_KEY = "leaf:recent";
export function recentPages(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}
export function touchRecent(pageId: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([pageId, ...recentPages().filter((id) => id !== pageId)].slice(0, 20)));
  } catch {}
}

// ---------------------------------------------------------------- logout

/** Remove everything this device kept for the signed-in user. */
export async function clearOfflineData() {
  cancelWarm();
  sw()?.postMessage({ type: "clear" });
  try {
    await caches.delete("leaf-v1");
  } catch {}
  await clearSyncData();
  saved = {};
  localStorage.removeItem(SAVED_KEY);
  localStorage.removeItem(REASONS_KEY);
  localStorage.removeItem(RECENT_KEY);
  savedListeners.forEach((l) => l());
}
