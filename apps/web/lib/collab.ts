"use client";
import { useEffect, useState } from "react";
import { IndexeddbPersistence } from "y-indexeddb";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { wsBase, wsTicket } from "./api";

export interface Collab {
  doc: Y.Doc;
  provider: WebsocketProvider;
  /** True once the document has content (from the server or the local IndexedDB cache). */
  ready: boolean;
  status: "connecting" | "connected" | "disconnected";
  synced: boolean;
}

/**
 * One Yjs document per open page:
 *  - WebsocketProvider syncs with the server (and re-syncs diffs after reconnects).
 *  - IndexeddbPersistence keeps a local replica, so offline edits survive a reload and
 *    merge when the connection returns.
 * The editor is only created once the document has content; creating it against an
 * empty fragment would make every client insert its own default title/paragraph.
 */
export function useCollab(pageId: string, share: string | null, opts: { expose?: boolean } = {}): Collab | null {
  const expose = opts.expose !== false;
  const [state, setState] = useState<Collab | null>(null);

  useEffect(() => {
    const doc = new Y.Doc();
    const params: Record<string, string> = {};
    if (share) params.share = share;
    // Connect once a ticket is in hand; refresh it before reconnects (y-websocket reads
    // provider.params on every connect).
    const provider = new WebsocketProvider(`${wsBase()}/ws/doc`, pageId, doc, { params, maxBackoffTime: 4000, connect: false });
    let alive = true;
    void wsTicket().then((t) => {
      if (!alive) return;
      if (t) provider.params.ticket = t;
      provider.connect();
    });
    provider.on("status", (e: { status: string }) => {
      if (e.status === "disconnected") void wsTicket().then((t) => t && (provider.params.ticket = t));
    });
    const idb = share ? null : new IndexeddbPersistence(`leaf-page-${pageId}`, doc);
    const frag = doc.getXmlFragment("default");
    let current: Collab = { doc, provider, ready: frag.length > 0, status: "connecting", synced: false };
    const update = (patch: Partial<Collab>) => {
      current = { ...current, ...patch };
      setState(current);
    };
    setState(current);
    const checkReady = () => {
      if (!current.ready && frag.length > 0) update({ ready: true });
    };
    provider.on("status", (e: { status: Collab["status"] }) => update({ status: e.status }));
    provider.on("sync", (synced: boolean) => {
      update({ synced });
      checkReady();
    });
    idb?.once("synced", checkReady);
    doc.on("update", checkReady);
    // React to the OS network state immediately instead of waiting for a socket timeout.
    const offline = () => provider.disconnect();
    const online = () => provider.connect();
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    // Expose the page's document (not nested synced blocks) for debugging / e2e checks.
    if (expose) {
      (window as any).__leafDoc = doc;
      (window as any).__leafProvider = provider;
    }
    return () => {
      alive = false;
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      provider.destroy();
      void idb?.destroy();
      doc.destroy();
    };
  }, [pageId, share]);

  return state;
}
