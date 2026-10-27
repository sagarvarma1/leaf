/**
 * WebSocket endpoint: /ws/events, one socket per client (Leaf's MessageStore).
 *
 * Server -> client: workspace events, commits for the documents the client follows, and
 * presence. Client -> server:
 *   { type: "sub", docs: [...] }              which documents to follow (open + offline pages)
 *   { type: "presence", doc, sel }            where my cursor is in a document (sel null: no caret)
 *   { type: "presence", doc, leave: true }    I closed that document
 * Writes don't go through the socket: clients POST transactions (see http.ts), like
 * Notion's /saveTransactions, and the server broadcasts the commit here.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { Leaf, User } from "./app.js";
import { parseCookies, SESSION_COOKIE, verifyTicket } from "./auth.js";
import type { Subscriber } from "./hub.js";

export function attachRealtime(leaf: Leaf) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

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

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws/events") return reject(socket, 404, "Not Found");
    const user = authenticate(req, url);
    const share = url.searchParams.get("share");
    const workspaceId = url.searchParams.get("workspace") ?? "";
    const member = Boolean(user && leaf.isMember(user.id, workspaceId));
    const link = leaf.shareLinkByToken(share);
    if (!member && !link) return reject(socket, user ? 403 : 401, "Forbidden");
    const ws0 = member ? workspaceId : (leaf.store.get(link.page_id)?.workspace_id ?? "");
    const session = (url.searchParams.get("session") ?? "").slice(0, 64) || undefined;

    wss.handleUpgrade(req, socket, head, (ws) => {
      keepAlive(ws);
      const sub: Subscriber = {
        workspaceId: ws0,
        member,
        session,
        user: user ? { id: user.id, name: user.name, color: user.color } : { id: `guest-${session ?? "x"}`, name: "Guest", color: "#9b9a97" },
        docs: new Set(),
        presence: new Map(),
        canSee: (b) => member || leaf.store.ancestors(b.page_id ?? b.id).some((a) => a.id === link.page_id),
        send: (json) => ws.readyState === WebSocket.OPEN && ws.send(json),
      };
      const remove = leaf.hub.add(sub);
      ws.on("close", remove);
      ws.on("message", (raw: Buffer) => {
        let msg: any;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg?.type === "sub" && Array.isArray(msg.docs)) {
          // Follow only documents this client may read.
          const docs = msg.docs
            .slice(0, 500)
            .map(String)
            .filter((id: string) => {
              const b = leaf.store.get(id);
              return !!b && b.workspace_id === ws0 && leaf.access(user?.id ?? null, id, share) !== null;
            });
          leaf.hub.subscribe(sub, docs);
        } else if (msg?.type === "presence" && typeof msg.doc === "string") {
          if (msg.leave) leaf.hub.setPresence(sub, msg.doc, null, true);
          else if (sub.docs?.has(msg.doc)) leaf.hub.setPresence(sub, msg.doc, msg.sel ?? null);
        }
      });
      ws.send(JSON.stringify({ type: "hello" }));
    });
  }

  return { wss, handleUpgrade };
}
