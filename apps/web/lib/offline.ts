"use client";
/*
 * Offline mode.
 *
 * Two layers, deliberately separate:
 *  1. Content: every page is a Yjs document. useCollab keeps a replica in IndexedDB for
 *     pages you open; `warmWorkspace` downloads the rest in the background. Edits made
 *     offline are ordinary CRDT updates and merge with everyone else's on reconnect, with
 *     no conflict UI because there is nothing to resolve.
 *  2. Shell: public/sw.js serves the app (HTML, JS, read-only API responses) from cache
 *     when the network is down, so a reload or a cold start works on a plane.
 *
 * Structural actions (creating pages, database rows, comments) still need the server;
 * they fail with a clear "you're offline" message instead of being queued.
 */
import { useEffect, useSyncExternalStore } from "react";
import { IndexeddbPersistence } from "y-indexeddb";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import type { Block } from "@leaf/shared";
import { wsBase, wsTicket } from "./api";

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
type Saved = Record<string, number>; // page id -> when its replica last matched the server
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

/** Unsynced local edit counts, kept across reloads so "N changes" survives an offline restart. */
const PENDING_KEY = "leaf:pending:";
export function getPending(pageId: string): number {
  try {
    return Number(localStorage.getItem(PENDING_KEY + pageId) ?? 0) || 0;
  } catch {
    return 0;
  }
}
export function setPending(pageId: string, n: number) {
  try {
    if (n) localStorage.setItem(PENDING_KEY + pageId, String(n));
    else localStorage.removeItem(PENDING_KEY + pageId);
  } catch {}
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

/** Sync one document into IndexedDB and return the synced-block containers it shows. */
async function syncDoc(id: string): Promise<string[]> {
  const doc = new Y.Doc();
  const idb = new IndexeddbPersistence(`leaf-page-${id}`, doc);
  await idb.whenSynced;
  const ticket = await wsTicket();
  const provider = new WebsocketProvider(`${wsBase()}/ws/doc`, id, doc, { params: ticket ? { ticket } : {}, connect: false, maxBackoffTime: 4000 });
  provider.awareness.setLocalState(null); // a background download, not a visitor: no presence
  try {
    const ok = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 15_000);
      provider.on("sync", (s: boolean) => s && (clearTimeout(t), resolve(true)));
      provider.connect();
    });
    if (!ok) return [];
    markSaved(id);
    const synced: string[] = [];
    const walk = (node: Y.XmlFragment | Y.XmlElement) => {
      for (const child of node.toArray()) {
        if (!(child instanceof Y.XmlElement)) continue;
        if (child.nodeName === "syncedBlock" && child.getAttribute("syncId")) synced.push(String(child.getAttribute("syncId")));
        walk(child);
      }
    };
    walk(doc.getXmlFragment("default"));
    return synced;
  } finally {
    provider.destroy();
    await idb.destroy(); // waits for pending IndexedDB writes
    doc.destroy();
  }
}

const MAX_WARM = 80;
let warmToken = 0;

/**
 * Download the workspace for offline use: favorites and recent pages first, then the rest
 * of the tree, skipping pages whose replica is already newer than their last edit. Runs
 * one page at a time in the background; switching workspaces cancels it.
 */
export async function warmWorkspace(workspaceId: string, blocks: Record<string, Block>, priority: string[]) {
  const token = ++warmToken;
  if (!isOnline()) return;
  const pages = Object.values(blocks).filter((b) => b.type === "page" && !b.archived);
  const order = [...new Set([...priority, ...pages.map((p) => p.id)])].filter((id) => blocks[id]?.type === "page").slice(0, MAX_WARM);
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

  const seenSynced = new Set<string>();
  for (const id of stale) {
    if (token !== warmToken || !isOnline()) break;
    try {
      for (const syncId of await syncDoc(id)) {
        if (seenSynced.has(syncId)) continue;
        seenSynced.add(syncId);
        keepUrls([`/api/synced-blocks/${syncId}`]);
        await syncDoc(syncId);
      }
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
  try {
    const dbs = (await indexedDB.databases?.()) ?? [];
    await Promise.all(dbs.filter((d) => d.name?.startsWith("leaf-page-")).map((d) => new Promise((r) => {
      const req = indexedDB.deleteDatabase(d.name!);
      req.onsuccess = req.onerror = req.onblocked = r;
    })));
  } catch {}
  saved = {};
  localStorage.removeItem(SAVED_KEY);
  localStorage.removeItem(RECENT_KEY);
  for (const k of Object.keys(localStorage)) if (k.startsWith(PENDING_KEY)) localStorage.removeItem(k);
  savedListeners.forEach((l) => l());
}
