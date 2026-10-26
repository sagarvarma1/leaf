/**
 * WebSocket endpoints.
 *
 *   /ws/doc/<pageId>   Yjs sync + awareness for one page (the y-websocket wire protocol,
 *                      implemented here so we control auth, read-only and persistence).
 *   /ws/events         Workspace event stream (structure changes, comments, versions).
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebSocket, WebSocketServer } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import type { Leaf, User } from "./app.js";
import { parseCookies, SESSION_COOKIE, verifyTicket } from "./auth.js";
import type { ConnInfo, LiveDoc, Origin } from "./docs.js";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_QUERY_AWARENESS = 3;

export function attachRealtime(leaf: Leaf) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const withAwareness = new WeakSet<LiveDoc>();

  leaf.docs.onUpdate = (live, update, origin) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    const msg = encoding.toUint8Array(enc);
    const from = (origin as Origin | null)?.conn;
    for (const c of live.conns) if (c !== from) c.send(msg);
  };

  function installAwareness(live: LiveDoc) {
    if (withAwareness.has(live)) return;
    withAwareness.add(live);
    live.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      const conn = (origin as { conn?: ConnInfo } | null)?.conn;
      if (conn) {
        for (const id of added) conn.awarenessIds.add(id);
        for (const id of removed) conn.awarenessIds.delete(id);
      }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(live.awareness, changed));
      const msg = encoding.toUint8Array(enc);
      for (const c of live.conns) c.send(msg);
    });
  }

  /** Session cookie (same-site deployments), a signed ticket (cross-site), or a bearer token (scripts). */
  function authenticate(req: IncomingMessage, url: URL): User | null {
    const ticketUser = verifyTicket(url.searchParams.get("ticket"));
    if (ticketUser) return leaf.getUser(ticketUser);
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? url.searchParams.get("token") ?? undefined;
    return leaf.sessionUser(token);
  }

  function reject(socket: Duplex, status: number, message: string) {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  function keepAlive(ws: WebSocket) {
    let alive = true;
    ws.on("pong", () => (alive = true));
    const timer = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30_000);
    ws.on("close", () => clearInterval(timer));
  }

  function handleDoc(ws: WebSocket, live: LiveDoc, user: User | null, readOnly: boolean) {
    installAwareness(live);
    if (live.unloadTimer) {
      clearTimeout(live.unloadTimer);
      live.unloadTimer = null;
    }
    const conn: ConnInfo = {
      userId: user?.id ?? null,
      readOnly,
      awarenessIds: new Set(),
      send(data) {
        if (ws.readyState === WebSocket.OPEN) ws.send(data, (err) => err && ws.terminate());
      },
    };
    live.conns.add(conn);
    const origin: Origin = { conn };

    ws.on("message", (raw: Buffer) => {
      try {
        const decoder = decoding.createDecoder(new Uint8Array(raw));
        const enc = encoding.createEncoder();
        const type = decoding.readVarUint(decoder);
        if (type === MSG_SYNC) {
          encoding.writeVarUint(enc, MSG_SYNC);
          if (readOnly) {
            // Viewers may ask for state (step 1) but their updates are ignored.
            const sub = decoding.readVarUint(decoder);
            if (sub === syncProtocol.messageYjsSyncStep1) syncProtocol.readSyncStep1(decoder, enc, live.doc);
          } else {
            syncProtocol.readSyncMessage(decoder, enc, live.doc, origin);
          }
          if (encoding.length(enc) > 1) conn.send(encoding.toUint8Array(enc));
        } else if (type === MSG_AWARENESS) {
          awarenessProtocol.applyAwarenessUpdate(live.awareness, decoding.readVarUint8Array(decoder), origin);
        } else if (type === MSG_QUERY_AWARENESS) {
          encoding.writeVarUint(enc, MSG_AWARENESS);
          encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(live.awareness, [...live.awareness.getStates().keys()]));
          conn.send(encoding.toUint8Array(enc));
        }
      } catch (err) {
        console.error("[ws] bad message", err);
      }
    });

    ws.on("close", () => {
      live.conns.delete(conn);
      awarenessProtocol.removeAwarenessStates(live.awareness, [...conn.awarenessIds], null);
      if (live.conns.size === 0) {
        leaf.docs.project(live.pageId);
        leaf.docs.persist(live.pageId);
        leaf.docs.scheduleUnload(live.pageId);
      }
    });

    // Sync step 1 from the server, plus everyone's current presence.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, live.doc);
    conn.send(encoding.toUint8Array(enc));
    const states = [...live.awareness.getStates().keys()];
    if (states.length) {
      const a = encoding.createEncoder();
      encoding.writeVarUint(a, MSG_AWARENESS);
      encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(live.awareness, states));
      conn.send(encoding.toUint8Array(a));
    }
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const user = authenticate(req, url);
    const share = url.searchParams.get("share");

    const docMatch = /^\/ws\/doc\/([\w-]+)$/.exec(url.pathname);
    if (docMatch) {
      const pageId = docMatch[1]!;
      const page = leaf.store.get(pageId);
      const ownsDoc = page && (page.type === "page" || (page.type === "synced_block" && !page.page_id));
      if (!page || !ownsDoc) return reject(socket, 404, "Not Found");
      const access = leaf.access(user?.id ?? null, pageId, share);
      if (!access) return reject(socket, user ? 403 : 401, user ? "Forbidden" : "Unauthorized");
      const live = leaf.docs.get(pageId);
      wss.handleUpgrade(req, socket, head, (ws) => {
        keepAlive(ws);
        handleDoc(ws, live, user, access !== "edit");
      });
      return;
    }

    if (url.pathname === "/ws/events") {
      const workspaceId = url.searchParams.get("workspace") ?? "";
      const member = user && leaf.isMember(user.id, workspaceId);
      const link = leaf.shareLinkByToken(share);
      if (!member && !link) return reject(socket, user ? 403 : 401, "Forbidden");
      wss.handleUpgrade(req, socket, head, (ws) => {
        keepAlive(ws);
        const remove = leaf.hub.add({
          workspaceId: member ? workspaceId : leaf.store.get(link.page_id)?.workspace_id ?? "",
          member: Boolean(member),
          canSee: (b) => member || leaf.store.ancestors(b.page_id ?? b.id).some((a) => a.id === link.page_id),
          send: (json) => ws.readyState === WebSocket.OPEN && ws.send(json),
        });
        ws.on("close", remove);
        ws.send(JSON.stringify({ type: "hello" }));
      });
      return;
    }
    reject(socket, 404, "Not Found");
  }

  return { wss, handleUpgrade };
}
