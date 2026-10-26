/**
 * REST API over blocks, pages, databases, comments, versions, search and sharing.
 * A deliberately small router on node:http: the interesting code is in app.ts.
 */
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Access, Leaf, User } from "./app.js";
import { parseCookies, SESSION_COOKIE, SESSION_TTL_MS, signTicket } from "./auth.js";
import { seedDemoContent } from "./seed.js";
import { attachRealtime } from "./realtime.js";
import { HttpError } from "./store.js";

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  user: User | null;
  token: string | null;
  share: string | null;
}
type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

export function createHttpServer(leaf: Leaf) {
  const routes: Array<{ method: string; re: RegExp; keys: string[]; handler: Handler }> = [];
  const route = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const re = new RegExp(
      "^" +
        path.replace(/:(\w+)/g, (_, k) => {
          keys.push(k);
          return "([^/]+)";
        }) +
        "$",
    );
    routes.push({ method, re, keys, handler });
  };

  const me = (c: Ctx): User => {
    if (!c.user) throw new HttpError(401, "Sign in required");
    return c.user;
  };
  const can = (c: Ctx, blockId: string, need: "view" | "edit") => leaf.requireAccess(c.user?.id ?? null, blockId, need, c.share);
  // Behind HTTPS in production (LEAF_COOKIE_SECURE=1) the session cookie is Secure.
  const secure = process.env.LEAF_COOKIE_SECURE === "1" ? "; Secure" : "";
  const setCookie = (c: Ctx, token: string, maxAgeMs: number) => {
    c.res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`,
    );
  };
  const clientIp = (c: Ctx) => String(c.req.headers["x-forwarded-for"] ?? "").split(",")[0]!.trim() || c.req.socket.remoteAddress || "unknown";
  const session = (c: Ctx, user: User) => {
    const token = leaf.createSession(user.id);
    setCookie(c, token, SESSION_TTL_MS);
    return { user, workspaces: leaf.workspacesOf(user.id), token };
  };

  // ---------------------------------------------------------------- auth
  route("POST", "/api/auth/signup", (c) => {
    const user = leaf.signup(c.body.email, c.body.name, c.body.password);
    const ws = leaf.createWorkspace(`${user.name.split(" ")[0]}'s Workspace`, user.id);
    leaf.createPage({ workspaceId: ws, userId: user.id, title: "Getting started", icon: "👋", content: [
      { type: "paragraph", properties: { rich_text: [{ text: "Welcome to Leaf. Type " }, { text: "/", marks: { code: true } }, { text: " for blocks, or select text to format it." }] } },
      { type: "to_do", properties: { rich_text: [{ text: "Invite a teammate from Settings → Members" }] } },
    ] });
    return session(c, user);
  });
  route("POST", "/api/auth/login", (c) => session(c, leaf.login(c.body.email, c.body.password)));
  route("POST", "/api/auth/logout", (c) => {
    if (c.token) leaf.logout(c.token);
    setCookie(c, "", 0);
    return { ok: true };
  });
  route("GET", "/api/auth/ws-ticket", (c) => signTicket(me(c).id));
  route("GET", "/api/demo", () => ({
    guest: process.env.LEAF_GUEST !== "0",
    demoUsers: Boolean(leaf.db.prepare("SELECT 1 FROM users WHERE email = 'alice@leaf.dev'").get()),
  }));
  route("POST", "/api/auth/guest", (c) => {
    if (process.env.LEAF_GUEST === "0") throw new HttpError(404, "Guest sandboxes are off");
    const guest = leaf.createGuestSandbox(clientIp(c), (ws, owner, teammate) => seedDemoContent(leaf, ws, owner, teammate));
    return session(c, guest);
  });
  route("POST", "/api/auth/join", (c) => session(c, leaf.joinWithLink(c.body.token, clientIp(c))));
  route("POST", "/api/workspaces/:ws/join-links", (c) => {
    leaf.requireMember(me(c).id, c.params.ws!);
    return { token: leaf.createJoinLink(c.params.ws!, c.user!.id) };
  });
  route("GET", "/api/auth/me", (c) => {
    if (!c.user) return { user: null, workspaces: [] };
    return { user: c.user, workspaces: leaf.workspacesOf(c.user.id) };
  });

  // ---------------------------------------------------------------- workspaces
  route("GET", "/api/workspaces/:ws/pages", (c) => {
    leaf.requireMember(me(c).id, c.params.ws!);
    return { root: leaf.workspaceContent(c.params.ws!), blocks: leaf.store.structure(c.params.ws!) };
  });
  route("GET", "/api/workspaces/:ws/members", (c) => {
    leaf.requireMember(me(c).id, c.params.ws!);
    return { members: leaf.members(c.params.ws!) };
  });
  route("POST", "/api/workspaces/:ws/members", (c) => {
    leaf.requireMember(me(c).id, c.params.ws!);
    leaf.addMember(c.params.ws!, c.body.email);
    return { members: leaf.members(c.params.ws!) };
  });
  route("DELETE", "/api/workspaces/:ws/members/:user", (c) => {
    leaf.requireMember(me(c).id, c.params.ws!);
    leaf.removeMember(c.params.ws!, c.params.user!);
    return { members: leaf.members(c.params.ws!) };
  });
  route("GET", "/api/workspaces/:ws/search", (c) => {
    leaf.requireMember(me(c).id, c.params.ws!);
    return { results: leaf.search(c.params.ws!, c.query.get("q") ?? "") };
  });
  route("GET", "/api/workspaces/:ws/favorites", (c) => ({ favorites: leaf.favorites(me(c).id) }));

  // ---------------------------------------------------------------- pages
  route("POST", "/api/pages", (c) => {
    const user = me(c);
    if (c.body.parentId) can(c, c.body.parentId, "edit");
    else leaf.requireMember(user.id, c.body.workspaceId);
    return {
      page: leaf.createPage({
        workspaceId: c.body.workspaceId,
        parentId: c.body.parentId ?? null,
        title: c.body.title,
        icon: c.body.icon,
        userId: user.id,
        content: c.body.content,
        link: c.body.link !== false,
        afterBlockId: c.body.afterBlockId,
        values: c.body.values,
      }),
    };
  });
  route("GET", "/api/pages/:id", (c) => {
    const page = can(c, c.params.id!, "view");
    if (page.type !== "page") throw new HttpError(400, "Not a page");
    const access: Access = leaf.access(c.user?.id ?? null, page.id, c.share);
    const parent = page.parent_id ? leaf.store.get(page.parent_id) : null;
    return {
      page,
      access,
      breadcrumbs: leaf.breadcrumbs(page.id),
      database: parent?.type === "database" ? parent : null,
      isMember: leaf.isMember(c.user?.id, page.workspace_id),
    };
  });
  route("PATCH", "/api/pages/:id", (c) => {
    can(c, c.params.id!, "edit");
    return { page: leaf.updatePage(c.params.id!, c.user!.id, c.body) };
  });
  route("POST", "/api/pages/:id/move", (c) => {
    can(c, c.params.id!, "edit");
    if (c.body.parentId) can(c, c.body.parentId, "edit");
    return { page: leaf.movePage(c.params.id!, c.user!.id, c.body.parentId ?? null, c.body.beforeId) };
  });
  route("DELETE", "/api/pages/:id", (c) => {
    const p = can(c, c.params.id!, "edit");
    leaf.requireMember(me(c).id, p.workspace_id);
    leaf.trashPage(c.params.id!, c.user!.id);
    return { ok: true };
  });
  route("POST", "/api/pages/:id/restore", (c) => {
    const p = can(c, c.params.id!, "edit");
    leaf.requireMember(me(c).id, p.workspace_id);
    leaf.restorePage(c.params.id!, c.user!.id);
    return { ok: true };
  });
  route("DELETE", "/api/pages/:id/permanent", (c) => {
    const p = can(c, c.params.id!, "edit");
    leaf.requireMember(me(c).id, p.workspace_id);
    leaf.deletePermanently(c.params.id!);
    return { ok: true };
  });
  route("GET", "/api/pages/:id/blocks", (c) => {
    can(c, c.params.id!, "view");
    return leaf.pageBlocks(c.params.id!);
  });
  route("GET", "/api/pages/:id/export", (c) => {
    can(c, c.params.id!, "view");
    const md = leaf.exportMarkdown(c.params.id!);
    const title = (leaf.store.get(c.params.id!)!.properties.title || "Untitled").replace(/[^\w\- ]+/g, "").trim() || "page";
    c.res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${title}.md"`,
    });
    c.res.end(md);
    return undefined;
  });
  route("PUT", "/api/pages/:id/favorite", (c) => {
    can(c, c.params.id!, "view");
    return { favorites: leaf.setFavorite(me(c).id, c.params.id!, true) };
  });
  route("DELETE", "/api/pages/:id/favorite", (c) => ({ favorites: leaf.setFavorite(me(c).id, c.params.id!, false) }));

  // ---------------------------------------------------------------- blocks (Notion-API style)
  route("GET", "/api/blocks/:id", (c) => ({ block: can(c, c.params.id!, "view") }));
  route("GET", "/api/blocks/:id/children", (c) => {
    const b = can(c, c.params.id!, "view");
    if (b.type === "page") leaf.pageBlocks(b.id);
    const fresh = leaf.store.get(b.id)!;
    return { results: fresh.content.map((id) => leaf.store.get(id)).filter(Boolean) };
  });
  route("POST", "/api/blocks/:id/children", (c) => {
    can(c, c.params.id!, "edit");
    return { results: leaf.appendChildren(c.params.id!, c.user!.id, c.body.children, c.body.after) };
  });
  route("PATCH", "/api/blocks/:id", (c) => {
    can(c, c.params.id!, "edit");
    return { block: leaf.updateBlock(c.params.id!, c.user!.id, c.body) };
  });
  route("DELETE", "/api/blocks/:id", (c) => {
    can(c, c.params.id!, "edit");
    leaf.deleteContentBlock(c.params.id!, c.user!.id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- synced blocks
  route("POST", "/api/synced-blocks", (c) => {
    can(c, c.body.pageId, "edit");
    return { container: leaf.createSyncedBlock({ pageId: c.body.pageId, userId: me(c).id, content: c.body.content }) };
  });
  route("GET", "/api/synced-blocks/:id", (c) => {
    can(c, c.params.id!, "view");
    return leaf.syncedInfo(c.params.id!);
  });

  // ---------------------------------------------------------------- databases
  route("POST", "/api/databases", (c) => {
    can(c, c.body.pageId, "edit");
    return { database: leaf.createDatabase({ pageId: c.body.pageId, userId: me(c).id, title: c.body.title, append: Boolean(c.body.append) }) };
  });
  route("GET", "/api/databases/:id", (c) => {
    can(c, c.params.id!, "view");
    return leaf.getDatabase(c.params.id!);
  });
  route("POST", "/api/databases/:id/ops", (c) => {
    can(c, c.params.id!, "edit");
    return { database: leaf.applyDatabaseOp(c.params.id!, c.user!.id, c.body) };
  });
  route("POST", "/api/databases/:id/rows", (c) => {
    can(c, c.params.id!, "edit");
    return { row: leaf.createPage({ parentId: c.params.id!, userId: me(c).id, title: c.body.title ?? "", values: c.body.values }) };
  });
  route("PATCH", "/api/rows/:id", (c) => {
    can(c, c.params.id!, "edit");
    return { row: leaf.setRowValues(c.params.id!, c.user!.id, c.body.values ?? {}) };
  });

  // ---------------------------------------------------------------- comments
  route("GET", "/api/pages/:id/comments", (c) => {
    can(c, c.params.id!, "view");
    return { comments: leaf.comments(c.params.id!) };
  });
  route("POST", "/api/pages/:id/comments", (c) => {
    can(c, c.params.id!, "view");
    return { comment: leaf.addComment(c.params.id!, me(c).id, c.body) };
  });
  route("PATCH", "/api/comments/:id", (c) => {
    can(c, leaf.commentPageId(c.params.id!), "view");
    leaf.updateComment(c.params.id!, me(c).id, c.body);
    return { ok: true };
  });
  route("DELETE", "/api/comments/:id", (c) => {
    can(c, leaf.commentPageId(c.params.id!), "view");
    leaf.deleteComment(c.params.id!, me(c).id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- version history
  route("GET", "/api/pages/:id/versions", (c) => {
    can(c, c.params.id!, "view");
    return { versions: leaf.versions(c.params.id!) };
  });
  route("POST", "/api/pages/:id/versions", (c) => {
    can(c, c.params.id!, "edit");
    const id = leaf.docs.snapshot(c.params.id!, me(c).id, c.body.label ?? "Saved version");
    leaf.docs.scheduleUnload(c.params.id!);
    return { id };
  });
  route("GET", "/api/versions/:id", (c) => {
    can(c, leaf.versionPageId(c.params.id!), "view");
    return leaf.versionPreview(c.params.id!);
  });
  route("POST", "/api/versions/:id/restore", (c) => {
    can(c, leaf.versionPageId(c.params.id!), "edit");
    return { page: leaf.restoreVersion(c.params.id!, me(c).id) };
  });

  // ---------------------------------------------------------------- sharing
  route("GET", "/api/pages/:id/share", (c) => {
    const p = can(c, c.params.id!, "view");
    leaf.requireMember(me(c).id, p.workspace_id);
    return { share: leaf.getShare(c.params.id!) };
  });
  route("PUT", "/api/pages/:id/share", (c) => {
    const p = can(c, c.params.id!, "edit");
    leaf.requireMember(me(c).id, p.workspace_id);
    return { share: leaf.setShare(c.params.id!, c.user!.id, c.body) };
  });
  route("GET", "/api/share/:token", (c) => {
    const link = leaf.shareLinkByToken(c.params.token);
    if (!link) throw new HttpError(404, "This link is invalid or has been turned off");
    const page = leaf.store.get(link.page_id);
    if (!page || page.archived) throw new HttpError(404, "This page no longer exists");
    return { pageId: link.page_id, access: leaf.access(c.user?.id ?? null, link.page_id, c.params.token), workspaceId: page.workspace_id };
  });

  // ---------------------------------------------------------------- Leaf AI
  route("GET", "/api/ai/status", () => leaf.ai.status());
  route("GET", "/api/pages/:id/ai", (c) => {
    can(c, c.params.id!, "edit");
    return { runs: leaf.ai.list(c.params.id!) };
  });
  route("POST", "/api/pages/:id/ai", (c) => {
    const p = can(c, c.params.id!, "edit");
    leaf.requireMember(me(c).id, p.workspace_id);
    return { run: leaf.ai.start(c.params.id!, c.user!, c.body.prompt, c.body.blockId) };
  });
  for (const action of ["stop", "keep", "discard"] as const) {
    route("POST", `/api/ai/runs/:id/${action}`, (c) => {
      const run = leaf.ai.get(c.params.id!);
      can(c, run.summary.pageId, "edit");
      return { run: action === "discard" ? leaf.ai.discard(run.summary.id, me(c).id) : leaf.ai[action](run.summary.id) };
    });
  }

  route("GET", "/api/health", () => ({ ok: true, docsOpen: leaf.docs.docs.size, subscribers: leaf.hub.size }));

  // ---------------------------------------------------------------- server
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const cookies = parseCookies(req.headers.cookie);
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const token = bearer ?? cookies[SESSION_COOKIE] ?? null;
    const ctx: Ctx = {
      req,
      res,
      params: {},
      query: url.searchParams,
      body: {},
      user: leaf.sessionUser(token ?? undefined),
      token,
      share: (req.headers["x-leaf-share"] as string | undefined) ?? url.searchParams.get("share"),
    };
    try {
      const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!match) throw new HttpError(404, "Not found");
      const m = match.re.exec(url.pathname)!;
      match.keys.forEach((k, i) => (ctx.params[k] = decodeURIComponent(m[i + 1]!)));
      if (req.method !== "GET" && req.method !== "DELETE") {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 5 * 1024 * 1024) throw new HttpError(413, "Body too large");
          chunks.push(chunk);
        }
        const text = Buffer.concat(chunks).toString("utf8");
        ctx.body = text ? JSON.parse(text) : {};
      }
      const out = await match.handler(ctx);
      if (out !== undefined && !res.headersSent) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
      }
    } catch (err: any) {
      const status = err instanceof HttpError ? err.status : err instanceof SyntaxError ? 400 : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: status === 500 ? "Internal error" : err.message }));
      }
    }
  });

  const realtime = attachRealtime(leaf);
  server.on("upgrade", realtime.handleUpgrade);
  return { server, wss: realtime.wss };
}
