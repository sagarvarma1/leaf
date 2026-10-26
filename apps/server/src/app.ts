/**
 * Leaf application services. Every mutation goes through here; HTTP and WebSocket
 * handlers are thin adapters. Two write paths exist:
 *
 *   1. Page content (rich text blocks): a CRDT. Clients edit their Yjs replica; the
 *      server merges, logs, persists and projects into the block table. Server-side
 *      writes to content (REST block API, renames, sub-page links, restores) are
 *      applied as Yjs transactions via DocManager.mutate so editors receive them live.
 *   2. Structure (page tree, icons, covers, databases, cells, comments, sharing):
 *      server-authoritative operations committed in a SQLite transaction, then
 *      published to every subscribed client through the Hub.
 */
import {
  appendBlocks,
  applyDatabaseOp,
  defaultDatabase,
  deleteBlock,
  getFragment,
  hasPageLink,
  newId,
  normalizeValue,
  pageToMarkdown,
  projectFragment,
  removePageLinks,
  replaceFragment,
  setBlockText,
  setTitle,
  type Block,
  type BlockInput,
  type DatabaseOp,
  type DatabaseProperties,
  type RichText,
  type RowProperties,
  DatabaseOpError,
  buildSequence,
  COMPUTED_TYPES,
  computedCell,
  displayValue,
  relatedRows,
  type ValueContext,
} from "@leaf/shared";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { hashPassword, newToken, SESSION_TTL_MS, USER_COLORS, verifyPassword } from "./auth.js";
import { openDb, tx, type DB } from "./db.js";
import { DocManager, type DocOptions } from "./docs.js";
import { Hub } from "./hub.js";
import { AiAgent } from "./ai/agent.js";
import { createModel, type AiModel } from "./ai/model.js";
import { BlockStore, HttpError } from "./store.js";

export interface User {
  id: string;
  email: string;
  name: string;
  color: string;
}
export type Access = "edit" | "view" | null;

export interface LeafOptions extends Partial<DocOptions> {
  dbFile: string;
  /** The model behind Leaf AI; defaults to Claude when credentials are set (or the mock with LEAF_AI_MOCK=1). */
  aiModel?: AiModel | null;
  /** Delay between typed chunks when the AI writes (ms). */
  aiTypingMs?: number;
}

const now = () => Date.now();
const db0 = (blocks: Block[]) => blocks[0]!;
const GUEST_TTL_MS = Number(process.env.LEAF_GUEST_TTL_HOURS ?? 24) * 3_600_000;
const GUEST_NAMES = ["Otter", "Fox", "Heron", "Lynx", "Panda", "Koala", "Falcon", "Badger", "Orca", "Ibis", "Marten", "Puffin"];

export class Leaf {
  readonly db: DB;
  readonly store: BlockStore;
  readonly hub = new Hub();
  readonly docs: DocManager;
  readonly ai: AiAgent;

  constructor(opts: LeafOptions) {
    this.db = openDb(opts.dbFile);
    this.store = new BlockStore(this.db);
    this.docs = new DocManager(this.db, this.store, this.hub, {
      persistDebounceMs: opts.persistDebounceMs ?? 1000,
      projectDebounceMs: opts.projectDebounceMs ?? 300,
      snapshotIntervalMs: opts.snapshotIntervalMs ?? 10 * 60 * 1000,
      unloadAfterMs: opts.unloadAfterMs ?? 30_000,
    });
    this.ai = new AiAgent(this, opts.aiModel === undefined ? createModel() : opts.aiModel, {
      typingDelayMs: opts.aiTypingMs ?? Number(process.env.LEAF_AI_TYPING_MS ?? 16),
      maxRunsPerHour: Number(process.env.LEAF_AI_RUNS_PER_HOUR ?? 30),
    });
  }

  close() {
    this.ai.close();
    this.docs.close();
    this.db.close();
  }

  // ------------------------------------------------------------------ users & auth

  signup(email: string, name: string, password: string): User {
    email = String(email ?? "").trim().toLowerCase();
    name = String(name ?? "").trim();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, "Enter a valid email");
    if (!name) throw new HttpError(400, "Enter your name");
    if (String(password ?? "").length < 6) throw new HttpError(400, "Password must be at least 6 characters");
    if (this.db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) throw new HttpError(409, "An account with that email exists");
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
    const user: User = { id: randomUUID(), email, name, color: USER_COLORS[count % USER_COLORS.length]! };
    this.db
      .prepare("INSERT INTO users (id, email, name, password_hash, color, created_at) VALUES (?,?,?,?,?,?)")
      .run(user.id, email, name, hashPassword(password), user.color, now());
    return user;
  }

  login(email: string, password: string): User {
    const row = this.db.prepare("SELECT * FROM users WHERE email = ?").get(String(email ?? "").trim().toLowerCase()) as any;
    if (!row || !verifyPassword(String(password ?? ""), row.password_hash)) throw new HttpError(401, "Wrong email or password");
    return { id: row.id, email: row.email, name: row.name, color: row.color };
  }

  createSession(userId: string): string {
    const token = newToken();
    this.db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)").run(token, userId, now(), now() + SESSION_TTL_MS);
    return token;
  }

  sessionUser(token: string | undefined): User | null {
    if (!token) return null;
    const row = this.db
      .prepare("SELECT u.id, u.email, u.name, u.color, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?")
      .get(token) as any;
    if (!row || row.expires_at < now()) return null;
    return { id: row.id, email: row.email, name: row.name, color: row.color };
  }

  logout(token: string) {
    this.db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  }

  getUser(id: string): User | null {
    return (this.db.prepare("SELECT id, email, name, color FROM users WHERE id = ?").get(id) as unknown as User) ?? null;
  }

  // ------------------------------------------------------------------ workspaces

  createWorkspace(name: string, ownerId: string, icon = "🌿"): string {
    const id = randomUUID();
    tx(this.db, () => {
      this.db.prepare("INSERT INTO workspaces (id, name, icon, created_at) VALUES (?,?,?,?)").run(id, name, icon, now());
      this.db.prepare("INSERT INTO members (workspace_id, user_id, role) VALUES (?,?,?)").run(id, ownerId, "owner");
    });
    return id;
  }

  workspacesOf(userId: string) {
    return this.db
      .prepare("SELECT w.id, w.name, w.icon, m.role, w.expires_at FROM workspaces w JOIN members m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at")
      .all(userId) as Array<{ id: string; name: string; icon: string; role: string; expires_at: number | null }>;
  }

  // ------------------------------------------------------------------ guest sandboxes

  private guestStarts = new Map<string, number[]>();

  /** Rate limit by client address (sandboxes are cheap but not free). */
  private allowGuest(ip: string) {
    const now = Date.now();
    const recent = (this.guestStarts.get(ip) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= Number(process.env.LEAF_GUESTS_PER_HOUR ?? 10)) throw new HttpError(429, "Too many demo workspaces from your network. Try again in a bit.");
    this.guestStarts.set(ip, [...recent, now]);
  }

  private createGuestUser(name: string): User {
    const user: User = { id: randomUUID(), email: `guest-${randomUUID()}@guest.leaf`, name, color: USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)]! };
    this.db
      .prepare("INSERT INTO users (id, email, name, password_hash, color, created_at, guest) VALUES (?,?,?,?,?,?,1)")
      .run(user.id, user.email, user.name, "!", user.color, now());
    return user;
  }

  /**
   * "Try Leaf": a private copy of the demo workspace for one visitor, with a stand-in
   * teammate so mentions and owners make sense. Deleted when it expires.
   */
  createGuestSandbox(ip: string, seedContent: (ws: string, owner: string, teammate: string) => void): User {
    this.allowGuest(ip);
    const guest = this.createGuestUser(`Guest ${GUEST_NAMES[Math.floor(Math.random() * GUEST_NAMES.length)]}`);
    const teammate = this.createGuestUser("Bob Rivera");
    const ws = this.createWorkspace(`${guest.name.split(" ")[1]}'s Leaf`, guest.id);
    this.db.prepare("UPDATE workspaces SET expires_at = ? WHERE id = ?").run(now() + GUEST_TTL_MS, ws);
    this.db.prepare("INSERT INTO members (workspace_id, user_id, role) VALUES (?,?,?)").run(ws, teammate.id, "member");
    seedContent(ws, guest.id, teammate.id);
    return guest;
  }

  /** A link that signs a new guest into the workspace (bring a friend into your sandbox). */
  createJoinLink(workspaceId: string, userId: string): string {
    const ws = this.db.prepare("SELECT expires_at FROM workspaces WHERE id = ?").get(workspaceId) as { expires_at: number | null };
    const token = newToken().slice(0, 32);
    this.db
      .prepare("INSERT INTO join_links (token, workspace_id, created_by, created_at, expires_at) VALUES (?,?,?,?,?)")
      .run(token, workspaceId, userId, now(), ws.expires_at ?? now() + 7 * 86_400_000);
    return token;
  }

  joinWithLink(token: string, ip: string): User {
    const link = this.db.prepare("SELECT * FROM join_links WHERE token = ? AND expires_at > ?").get(String(token ?? ""), now()) as any;
    if (!link) throw new HttpError(404, "This invite link has expired.");
    this.allowGuest(ip);
    const guest = this.createGuestUser(`Guest ${GUEST_NAMES[Math.floor(Math.random() * GUEST_NAMES.length)]}`);
    this.db.prepare("INSERT INTO members (workspace_id, user_id, role) VALUES (?,?,?)").run(link.workspace_id, guest.id, "member");
    this.hub.publish(link.workspace_id, { type: "members" });
    return guest;
  }

  /** Delete expired sandboxes: their blocks, documents, history, comments, links and guest users. */
  sweepExpired(at = now()): number {
    const expired = this.db.prepare("SELECT id FROM workspaces WHERE expires_at IS NOT NULL AND expires_at < ?").all(at) as Array<{ id: string }>;
    for (const { id } of expired) {
      const pages = this.db.prepare("SELECT id FROM blocks WHERE workspace_id = ? AND (type = 'page' OR (type = 'synced_block' AND page_id IS NULL))").all(id) as Array<{ id: string }>;
      for (const p of pages) this.docs.drop(p.id);
      tx(this.db, () => {
        for (const p of pages) {
          this.db.prepare("DELETE FROM comments WHERE page_id = ?").run(p.id);
          this.db.prepare("DELETE FROM share_links WHERE page_id = ?").run(p.id);
          this.db.prepare("DELETE FROM favorites WHERE page_id = ?").run(p.id);
        }
        this.db.prepare("DELETE FROM blocks WHERE workspace_id = ?").run(id);
        this.db.prepare("DELETE FROM page_search WHERE workspace_id = ?").run(id);
        this.db.prepare("DELETE FROM join_links WHERE workspace_id = ?").run(id);
        this.db.prepare("DELETE FROM members WHERE workspace_id = ?").run(id);
        this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
        // Guests who no longer belong anywhere go too (sessions cascade).
        this.db.prepare("DELETE FROM users WHERE guest = 1 AND id NOT IN (SELECT user_id FROM members)").run();
      });
    }
    return expired.length;
  }

  isMember(userId: string | null | undefined, workspaceId: string): boolean {
    if (!userId) return false;
    return Boolean(this.db.prepare("SELECT 1 FROM members WHERE workspace_id = ? AND user_id = ?").get(workspaceId, userId));
  }

  requireMember(userId: string | null | undefined, workspaceId: string) {
    if (!this.isMember(userId, workspaceId)) throw new HttpError(403, "Not a member of this workspace");
  }

  members(workspaceId: string) {
    return this.db
      .prepare("SELECT u.id, u.name, u.email, u.color, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY u.name")
      .all(workspaceId);
  }

  addMember(workspaceId: string, email: string) {
    const user = this.db.prepare("SELECT id FROM users WHERE email = ?").get(String(email).trim().toLowerCase()) as { id: string } | undefined;
    if (!user) throw new HttpError(404, "No Leaf account with that email. Ask them to sign up first.");
    this.db.prepare("INSERT OR IGNORE INTO members (workspace_id, user_id, role) VALUES (?,?,?)").run(workspaceId, user.id, "member");
    this.hub.publish(workspaceId, { type: "members" });
  }

  removeMember(workspaceId: string, userId: string) {
    const role = this.db.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?").get(workspaceId, userId) as any;
    if (role?.role === "owner") throw new HttpError(400, "The owner cannot be removed");
    this.db.prepare("DELETE FROM members WHERE workspace_id = ? AND user_id = ?").run(workspaceId, userId);
    this.hub.publish(workspaceId, { type: "members" });
  }

  workspaceContent(workspaceId: string): string[] {
    const row = this.db.prepare("SELECT content FROM workspaces WHERE id = ?").get(workspaceId) as { content: string } | undefined;
    if (!row) throw new HttpError(404, "workspace not found");
    return JSON.parse(row.content);
  }

  private setWorkspaceContent(workspaceId: string, content: string[]) {
    this.db.prepare("UPDATE workspaces SET content = ? WHERE id = ?").run(JSON.stringify(content), workspaceId);
  }

  // ------------------------------------------------------------------ access control

  shareLinkByToken(token: string | null | undefined) {
    if (!token) return null;
    return (this.db.prepare("SELECT * FROM share_links WHERE token = ? AND enabled = 1").get(token) as any) ?? null;
  }

  /**
   * Members of the workspace can edit everything in it. A share link grants its access
   * level on the shared page and everything beneath it; editing via a link requires
   * being signed in.
   */
  access(userId: string | null, blockId: string, shareToken?: string | null): Access {
    const b = this.store.get(blockId);
    if (!b) return null;
    if (this.isMember(userId, b.workspace_id)) return "edit";
    const link = this.shareLinkByToken(shareToken);
    if (link) {
      const chain = this.store.ancestors(b.page_id ?? b.id);
      if (chain.some((a) => a.id === link.page_id)) return link.access === "edit" && userId ? "edit" : "view";
    }
    return null;
  }

  requireAccess(userId: string | null, blockId: string, need: "view" | "edit", shareToken?: string | null): Block {
    const b = this.store.get(blockId);
    if (!b) throw new HttpError(404, "Not found");
    const a = this.access(userId, blockId, shareToken);
    if (!a) throw new HttpError(userId ? 403 : 401, "You don't have access to this page");
    if (need === "edit" && a !== "edit") throw new HttpError(403, "You can only view this page");
    return b;
  }

  // ------------------------------------------------------------------ pages

  createPage(input: {
    workspaceId?: string;
    parentId?: string | null;
    title?: string;
    icon?: string | null;
    cover?: string | null;
    userId: string | null;
    content?: BlockInput[];
    link?: boolean;
    afterBlockId?: string | null;
    values?: Record<string, any>;
  }): Block {
    const parent = input.parentId ? this.store.require(input.parentId, ["page", "database"]) : null;
    const workspaceId = parent?.workspace_id ?? input.workspaceId;
    if (!workspaceId) throw new HttpError(400, "workspaceId required");
    const id = randomUUID();
    const t = now();
    const title = String(input.title ?? "");
    let properties: Record<string, any>;
    if (parent?.type === "database") {
      const db = parent.properties as DatabaseProperties;
      const values: Record<string, any> = {};
      for (const [k, v] of Object.entries(input.values ?? {})) {
        const def = db.schema[k];
        if (def && k !== "title") values[k] = normalizeValue(def, v);
      }
      properties = { title, icon: input.icon ?? null, values } satisfies RowProperties;
    } else {
      properties = { title, icon: input.icon ?? null, cover: input.cover ?? null };
    }
    const page: Block = {
      id,
      type: "page",
      workspace_id: workspaceId,
      parent_id: parent?.id ?? null,
      page_id: null,
      properties,
      content: [],
      created_by: input.userId,
      created_at: t,
      last_edited_by: input.userId,
      last_edited_at: t,
      archived: false,
    };
    const changed: Block[] = [];
    tx(this.db, () => {
      this.store.insert(page);
      if (!parent) this.setWorkspaceContent(workspaceId, [...this.workspaceContent(workspaceId), id]);
      if (parent?.type === "database") {
        this.store.update(parent.id, { content: [...parent.content, id] });
        changed.push(this.store.get(parent.id)!);
      }
    });
    // Build the page's document (title + body) and project it.
    this.docs.mutate(id, input.userId, (frag) => {
      if (frag.length) frag.delete(0, frag.length);
      const titleEl = new Y.XmlElement("title");
      if (title) titleEl.insert(0, [new Y.XmlText(title)]);
      const body = input.content?.length ? input.content : [{ type: "paragraph" as const }];
      frag.insert(0, [titleEl, ...buildSequence(body)]);
    });
    if (parent?.type === "page" && input.link !== false) {
      this.docs.mutate(parent.id, input.userId, (frag) => appendBlocks(frag, [{ id, type: "child_page" }], input.afterBlockId));
    }
    this.releaseIfIdle(id);
    changed.push(this.store.get(id)!);
    this.hub.publishBlocks(workspaceId, changed);
    return this.store.get(id)!;
  }

  /** Unload a document nobody is editing (keeps memory bounded after bulk creates). */
  private releaseIfIdle(pageId: string) {
    const live = this.docs.docs.get(pageId);
    if (live && live.conns.size === 0) this.docs.scheduleUnload(pageId);
  }

  updatePage(id: string, userId: string | null, patch: { title?: string; icon?: string | null; cover?: string | null; fullWidth?: boolean }) {
    const page = this.store.require(id, "page");
    if (patch.title !== undefined) {
      this.docs.mutate(id, userId, (frag) => setTitle(frag, String(patch.title)));
      this.releaseIfIdle(id);
    }
    const props: Record<string, any> = { ...this.store.get(id)!.properties };
    let touched = false;
    for (const k of ["icon", "cover", "fullWidth"] as const) {
      if (patch[k] !== undefined) {
        props[k] = patch[k];
        touched = true;
      }
    }
    if (touched) {
      this.store.update(id, { properties: props, last_edited_by: userId, last_edited_at: now() });
    }
    const updated = this.store.get(id)!;
    this.hub.publishBlocks(page.workspace_id, [updated]);
    return updated;
  }

  movePage(id: string, userId: string | null, parentId: string | null, beforeId?: string | null) {
    const page = this.store.require(id, "page");
    const oldParent = page.parent_id ? this.store.get(page.parent_id) : null;
    if (oldParent?.type === "database") throw new HttpError(400, "Database rows can't be moved out of their database");
    const newParent = parentId ? this.store.require(parentId, ["page"]) : null;
    if (newParent && newParent.workspace_id !== page.workspace_id) throw new HttpError(400, "Cross-workspace moves are not supported");
    if (newParent && this.store.ancestors(newParent.id).some((a) => a.id === id)) throw new HttpError(400, "Can't move a page inside itself");

    // Re-parent first, so the projection of the old parent doesn't treat the removed
    // link as a deletion.
    tx(this.db, () => {
      this.store.update(id, { parent_id: newParent?.id ?? null });
      const root = this.workspaceContent(page.workspace_id).filter((p) => p !== id);
      if (!newParent) {
        const at = beforeId ? root.indexOf(beforeId) : -1;
        if (at >= 0) root.splice(at, 0, id);
        else root.push(id);
      }
      this.setWorkspaceContent(page.workspace_id, root);
    });
    if (oldParent?.type === "page") this.docs.mutate(oldParent.id, userId, (frag) => removePageLinks(frag, id));
    if (newParent) {
      this.docs.mutate(newParent.id, userId, (frag) => {
        removePageLinks(frag, id);
        let anchorIdx = -1;
        if (beforeId) {
          anchorIdx = frag.toArray().findIndex((c) => c instanceof Y.XmlElement && c.nodeName === "pageLink" && c.getAttribute("pageId") === beforeId);
        }
        const [el] = buildSequence([{ id, type: "child_page" }]);
        frag.insert(anchorIdx >= 0 ? anchorIdx : frag.length, [el!]);
      });
    }
    const changed = [this.store.get(id)!];
    if (oldParent) changed.push(this.store.get(oldParent.id)!);
    if (newParent) changed.push(this.store.get(newParent.id)!);
    this.hub.publishBlocks(page.workspace_id, changed);
    return this.store.get(id)!;
  }

  trashPage(id: string, userId: string | null) {
    const page = this.store.require(id, ["page"]);
    this.store.update(id, { archived: true, last_edited_by: userId, last_edited_at: now() });
    const parent = page.parent_id ? this.store.get(page.parent_id) : null;
    if (parent?.type === "page") this.docs.mutate(parent.id, userId, (frag) => removePageLinks(frag, id));
    this.db.prepare("DELETE FROM favorites WHERE page_id = ?").run(id);
    this.hub.publishBlocks(page.workspace_id, [this.store.get(id)!]);
  }

  restorePage(id: string, userId: string | null) {
    const page = this.store.require(id, ["page"]);
    let parent = page.parent_id ? this.store.get(page.parent_id) : null;
    if (parent && this.store.ancestors(parent.id).some((a) => a.archived)) {
      // Parent is gone: restore to the workspace root, like Notion.
      this.store.update(id, { parent_id: null });
      this.setWorkspaceContent(page.workspace_id, [...this.workspaceContent(page.workspace_id).filter((p) => p !== id), id]);
      parent = null;
    }
    this.store.update(id, { archived: false });
    if (parent?.type === "page") {
      this.docs.mutate(parent.id, userId, (frag) => {
        if (!hasPageLink(frag, id)) appendBlocks(frag, [{ id, type: "child_page" }]);
      });
    }
    this.hub.publishBlocks(page.workspace_id, [this.store.get(id)!]);
  }

  deletePermanently(id: string) {
    const page = this.store.require(id, ["page"]);
    if (!page.archived) throw new HttpError(400, "Move the page to trash first");
    const all = [page, ...this.store.descendants(id)];
    tx(this.db, () => {
      for (const b of all) {
        if (b.type === "page") {
          this.docs.drop(b.id);
          this.db.prepare("DELETE FROM blocks WHERE page_id = ?").run(b.id);
          this.db.prepare("DELETE FROM favorites WHERE page_id = ?").run(b.id);
          this.db.prepare("DELETE FROM comments WHERE page_id = ?").run(b.id);
          this.db.prepare("DELETE FROM share_links WHERE page_id = ?").run(b.id);
        }
        this.store.delete([b.id]);
      }
      this.setWorkspaceContent(page.workspace_id, this.workspaceContent(page.workspace_id).filter((p) => p !== id));
      const parent = page.parent_id ? this.store.get(page.parent_id) : null;
      if (parent?.type === "database") this.store.update(parent.id, { content: parent.content.filter((c) => c !== id) });
    });
    this.hub.publish(page.workspace_id, { type: "deleted", ids: all.map((b) => b.id) });
  }

  /** The projected block tree of a page (fresh: projects the live doc first). */
  pageBlocks(pageId: string) {
    const page = this.store.require(pageId, "page");
    if (this.docs.docs.has(pageId)) this.docs.project(pageId);
    else if (!this.db.prepare("SELECT 1 FROM ydocs WHERE doc_id = ?").get(pageId)) {
      this.docs.get(pageId);
      this.releaseIfIdle(pageId);
    }
    return { page: this.store.get(page.id)!, blocks: this.store.contentOf(pageId) };
  }

  breadcrumbs(id: string) {
    return this.store
      .ancestors(id)
      .reverse()
      .map((b) => ({ id: b.id, type: b.type, title: b.properties.title ?? "", icon: b.properties.icon ?? null }));
  }

  // ------------------------------------------------------------------ content blocks (REST over the CRDT)

  appendChildren(pageId: string, userId: string | null, children: BlockInput[], after?: string | null) {
    const owner = this.store.require(pageId, ["page", "synced_block"]);
    if (owner.page_id) throw new HttpError(400, "Append to the synced block's container instead");
    if (!Array.isArray(children) || !children.length) throw new HttpError(400, "children required");
    for (const c of children) {
      if (c.type === "child_page" || c.type === "child_database") throw new HttpError(400, "create pages and databases with their own endpoints");
      c.id = newId();
    }
    this.docs.mutate(pageId, userId, (frag) => appendBlocks(frag, children, after));
    this.releaseIfIdle(pageId);
    return children.map((c) => this.store.get(c.id!)).filter(Boolean);
  }

  updateBlock(blockId: string, userId: string | null, patch: { rich_text?: RichText; checked?: boolean }) {
    const b = this.store.require(blockId);
    if (!b.page_id) throw new HttpError(400, "Use the page endpoints for pages");
    this.docs.mutate(b.page_id, userId, (frag) => {
      if (patch.rich_text) setBlockText(frag, blockId, patch.rich_text);
      if (patch.checked !== undefined) {
        const walk = (p: Y.XmlFragment | Y.XmlElement): void => {
          for (const k of p.toArray()) {
            if (!(k instanceof Y.XmlElement)) continue;
            if (k.getAttribute("blockId") === blockId) k.setAttribute("checked", Boolean(patch.checked) as any);
            else walk(k);
          }
        };
        walk(frag);
      }
    });
    this.releaseIfIdle(b.page_id);
    return this.store.get(blockId);
  }

  deleteContentBlock(blockId: string, userId: string | null) {
    const b = this.store.require(blockId);
    if (!b.page_id) throw new HttpError(400, "Use the page endpoints for pages");
    this.docs.mutate(b.page_id, userId, (frag) => deleteBlock(frag, blockId));
    this.releaseIfIdle(b.page_id);
  }

  exportMarkdown(pageId: string): string {
    const { page, blocks } = this.pageBlocks(pageId);
    const map = new Map(blocks.map((b) => [b.id, b]));
    return pageToMarkdown(page, {
      get: (id) => map.get(id) ?? this.store.get(id),
      renderDatabase: (id) => this.databaseMarkdown(id),
    });
  }

  private databaseMarkdown(id: string): string {
    const db = this.store.get(id);
    if (!db) return "";
    const props = db.properties as DatabaseProperties;
    const users = new Map((this.members(db.workspace_id) as any[]).map((u) => [u.id, u.name]));
    const cols = props.order.map((p) => props.schema[p]!).filter(Boolean);
    const rows = db.content.map((r) => this.store.get(r)).filter((r): r is Block => !!r && !r.archived);
    const ctx = this.valueContext(db.workspace_id);
    const cell = (row: Block, pid: string) => {
      const def = props.schema[pid]!;
      if (COMPUTED_TYPES.has(def.type)) {
        const r = computedCell(row, def, props, ctx);
        return (r.error ? `⚠ ${r.error}` : displayValue(def, r.value)).replace(/\|/g, "\\|");
      }
      if (def.type === "relation") return relatedRows(row, def, ctx).map((r) => r.properties.title || "Untitled").join(", ");
      const v = pid === "title" ? row.properties.title : row.properties.values?.[pid];
      if (v === null || v === undefined) return "";
      if (def.type === "select") return def.options?.find((o) => o.id === v)?.name ?? "";
      if (def.type === "multi_select") return (v as string[]).map((x) => def.options?.find((o) => o.id === x)?.name ?? "").join(", ");
      if (def.type === "checkbox") return v ? "☑" : "☐";
      if (def.type === "person") return users.get(v) ?? "";
      return String(v).replace(/\|/g, "\\|");
    };
    return [
      `**${props.title}**`,
      "",
      `| ${cols.map((c) => c.name).join(" | ")} |`,
      `| ${cols.map(() => "---").join(" | ")} |`,
      ...rows.map((r) => `| ${cols.map((c) => cell(r, c.id)).join(" | ")} |`),
    ].join("\n");
  }

  // ------------------------------------------------------------------ databases

  createDatabase(input: { pageId: string; userId: string | null; title?: string; append?: boolean; rows?: Array<{ title: string; values?: Record<string, any> }>; database?: DatabaseProperties }) {
    const page = this.store.require(input.pageId, "page");
    const id = randomUUID();
    const t = now();
    const props = input.database ?? defaultDatabase(input.title ?? "Untitled database");
    this.store.insert({
      id,
      type: "database",
      workspace_id: page.workspace_id,
      parent_id: page.id,
      page_id: null,
      properties: props,
      content: [],
      created_by: input.userId,
      created_at: t,
      last_edited_by: input.userId,
      last_edited_at: t,
      archived: false,
    });
    const rows = input.rows ?? [
      { title: "First task", values: { status: "todo" } },
      { title: "Second task", values: { status: "doing" } },
      { title: "Third task", values: { status: "done" } },
    ];
    for (const r of rows) this.createPage({ parentId: id, userId: input.userId, title: r.title, values: r.values });
    if (input.append) this.docs.mutate(page.id, input.userId, (frag) => appendBlocks(frag, [{ id, type: "child_database" }]));
    const db = this.store.get(id)!;
    this.hub.publishBlocks(page.workspace_id, [db]);
    return db;
  }

  getDatabase(id: string) {
    const db = this.store.require(id, "database");
    const rows = db.content.map((r) => this.store.get(r)).filter((r): r is Block => !!r);
    return { database: db, rows };
  }

  /**
   * Apply one schema/view operation. Relations can span two databases: a two-way
   * relation adds a mirror property on the other database, and deleting one side turns
   * the other into a one-way relation. Both sides change in one transaction.
   */
  applyDatabaseOp(id: string, userId: string | null, op: DatabaseOp & { twoWay?: boolean }) {
    const changed: Block[] = [];
    const apply = (dbId: string, o: DatabaseOp) => {
      const db = this.store.require(dbId, "database");
      try {
        const next = applyDatabaseOp(db.properties as DatabaseProperties, db.content, o);
        this.store.update(dbId, { properties: next.db, content: next.rows, last_edited_by: userId, last_edited_at: now() });
      } catch (e) {
        if (e instanceof DatabaseOpError) throw new HttpError(400, e.message);
        throw e;
      }
      changed.push(this.store.get(dbId)!);
      return this.store.get(dbId)!;
    };
    tx(this.db, () => {
      const db = this.store.require(id, "database");
      const props = db.properties as DatabaseProperties;
      if (op.op === "addProperty" && op.type === "relation") {
        const target = this.store.require(op.relation?.databaseId ?? "", "database");
        if (target.workspace_id !== db.workspace_id) throw new HttpError(400, "Relations stay inside one workspace");
        const propId = op.id ?? newId().slice(0, 8);
        apply(id, { ...op, id: propId, relation: { databaseId: target.id, syncedPropertyId: null } });
        if (op.twoWay) {
          const mirrorId = newId().slice(0, 8);
          const mirrorName = target.id === id ? `Related to ${op.name}` : props.title || "Related";
          apply(target.id, { op: "addProperty", id: mirrorId, name: mirrorName, type: "relation", relation: { databaseId: id, syncedPropertyId: propId } });
          apply(id, { op: "updateProperty", id: propId, relation: { databaseId: target.id, syncedPropertyId: mirrorId } });
        }
        return;
      }
      if (op.op === "deleteProperty") {
        const rel = props.schema[op.id]?.relation;
        if (rel?.syncedPropertyId) {
          const other = this.store.get(rel.databaseId);
          const mirror = other && (other.properties as DatabaseProperties).schema[rel.syncedPropertyId];
          if (mirror?.relation) apply(rel.databaseId, { op: "updateProperty", id: mirror.id, relation: { databaseId: mirror.relation.databaseId, syncedPropertyId: null } });
        }
      }
      apply(id, op);
    });
    this.hub.publishBlocks(db0(changed).workspace_id, changed);
    return changed.filter((b) => b.id === id).pop()!;
  }

  /** Context for computed properties (rollups, formulas) evaluated on the server. */
  valueContext(workspaceId: string): ValueContext {
    const users = new Map((this.members(workspaceId) as any[]).map((u) => [u.id, u.name as string]));
    return {
      row: (id) => this.store.get(id),
      database: (id) => this.store.get(id)?.properties as DatabaseProperties | undefined,
      userName: (id) => users.get(id),
    };
  }

  /**
   * Set cells on a row. Each property is an independent last-writer-wins register.
   * A two-way relation cell also adds/removes this row on the mirror property of the
   * rows it links to, in the same transaction.
   */
  setRowValues(rowId: string, userId: string | null, values: Record<string, any>) {
    const row = this.store.require(rowId, "page");
    const db = row.parent_id ? this.store.get(row.parent_id) : undefined;
    if (!db || db.type !== "database") throw new HttpError(400, "Not a database row");
    const schema = (db.properties as DatabaseProperties).schema;
    if ("title" in values) this.updatePage(rowId, userId, { title: String(values.title ?? "") });
    const touched: Block[] = [];
    tx(this.db, () => {
      const fresh = this.store.get(rowId)!;
      const next = { ...(fresh.properties.values ?? {}) };
      for (const [k, v] of Object.entries(values)) {
        if (k === "title") continue;
        const def = schema[k];
        if (!def) throw new HttpError(400, `Unknown property ${k}`);
        if (COMPUTED_TYPES.has(def.type)) throw new HttpError(400, `${def.name} is computed`);
        let value = normalizeValue(def, v);
        if (def.type === "relation" && def.relation) {
          // Only rows of the related database can be linked.
          const target = this.store.get(def.relation.databaseId);
          value = (value as string[]).filter((id) => target?.content.includes(id));
          const before: string[] = Array.isArray(next[k]) ? next[k] : [];
          if (def.relation.syncedPropertyId) {
            const mirror = def.relation.syncedPropertyId;
            const added = (value as string[]).filter((id) => !before.includes(id));
            const removed = before.filter((id) => !(value as string[]).includes(id));
            for (const other of [...added, ...removed]) {
              if (other === rowId) continue; // self-link: handled by this row's own write
              const o = this.store.get(other);
              if (!o) continue;
              const cur: string[] = Array.isArray(o.properties.values?.[mirror]) ? o.properties.values[mirror] : [];
              const upd = added.includes(other) ? [...new Set([...cur, rowId])] : cur.filter((x) => x !== rowId);
              this.store.update(other, { properties: { ...o.properties, values: { ...o.properties.values, [mirror]: upd } }, last_edited_by: userId, last_edited_at: now() });
              touched.push(this.store.get(other)!);
            }
          }
        }
        next[k] = value;
      }
      this.store.update(rowId, { properties: { ...fresh.properties, values: next }, last_edited_by: userId, last_edited_at: now() });
    });
    const updated = this.store.get(rowId)!;
    this.hub.publishBlocks(row.workspace_id, [updated, ...touched]);
    return updated;
  }

  // ------------------------------------------------------------------ synced blocks

  /**
   * A synced block's content is its own document, owned by a container block
   * (type synced_block, synced_from null, parent = the page it was created on). Every
   * page that shows it holds a synced_block instance pointing at the container, so
   * editing any instance edits them all.
   */
  createSyncedBlock(input: { pageId: string; userId: string | null; content?: BlockInput[] }): Block {
    const page = this.store.require(input.pageId, "page");
    const id = randomUUID();
    const t = now();
    this.store.insert({
      id,
      type: "synced_block",
      workspace_id: page.workspace_id,
      parent_id: page.id,
      page_id: null,
      properties: { synced_from: null },
      content: [],
      created_by: input.userId,
      created_at: t,
      last_edited_by: input.userId,
      last_edited_at: t,
      archived: false,
    });
    const content = (input.content ?? []).filter((c) => c.type !== "child_page" && c.type !== "child_database" && c.type !== "synced_block");
    this.docs.mutate(id, input.userId, (frag) => {
      if (frag.length) frag.delete(0, frag.length);
      frag.insert(0, buildSequence(content.length ? content : [{ type: "paragraph" }]));
    });
    this.releaseIfIdle(id);
    return this.store.get(id)!;
  }

  /** The container plus every live page that shows it. */
  syncedInfo(id: string) {
    const container = this.store.require(id, "synced_block");
    if (container.page_id) throw new HttpError(400, "Not a synced block container");
    const rows = this.db
      .prepare("SELECT DISTINCT page_id FROM blocks WHERE type = 'synced_block' AND page_id IS NOT NULL AND json_extract(properties, '$.synced_from') = ?")
      .all(id) as Array<{ page_id: string }>;
    const pages = rows
      .map((r) => this.store.get(r.page_id))
      .filter((p): p is Block => !!p && p.workspace_id === container.workspace_id && !this.store.ancestors(p.id).some((a) => a.archived))
      .map((p) => ({ id: p.id, title: p.properties.title ?? "", icon: p.properties.icon ?? null }));
    return { container, original: container.parent_id, pages };
  }

  // ------------------------------------------------------------------ favorites

  favorites(userId: string): string[] {
    return (this.db.prepare("SELECT page_id FROM favorites WHERE user_id = ? ORDER BY created_at").all(userId) as any[]).map((r) => r.page_id);
  }

  setFavorite(userId: string, pageId: string, on: boolean) {
    if (on) this.db.prepare("INSERT OR IGNORE INTO favorites (user_id, page_id, created_at) VALUES (?,?,?)").run(userId, pageId, now());
    else this.db.prepare("DELETE FROM favorites WHERE user_id = ? AND page_id = ?").run(userId, pageId);
    return this.favorites(userId);
  }

  // ------------------------------------------------------------------ comments

  comments(pageId: string) {
    return this.db
      .prepare(
        `SELECT c.*, u.name AS author_name, u.color AS author_color FROM comments c JOIN users u ON u.id = c.author_id
         WHERE c.page_id = ? ORDER BY c.created_at`,
      )
      .all(pageId)
      .map((c: any) => ({ ...c, resolved: Boolean(c.resolved) }));
  }

  addComment(pageId: string, userId: string, input: { blockId?: string | null; threadId?: string | null; body: string }) {
    const page = this.store.require(pageId, "page");
    const body = String(input.body ?? "").trim();
    if (!body) throw new HttpError(400, "Comment is empty");
    const id = randomUUID();
    let threadId = id;
    let blockId = input.blockId ?? null;
    if (input.threadId) {
      const root = this.db.prepare("SELECT * FROM comments WHERE id = ? AND page_id = ?").get(input.threadId, pageId) as any;
      if (!root) throw new HttpError(404, "Thread not found");
      threadId = root.id;
      blockId = root.block_id;
      this.db.prepare("UPDATE comments SET resolved = 0 WHERE thread_id = ?").run(threadId);
    }
    this.db
      .prepare("INSERT INTO comments (id, page_id, block_id, thread_id, author_id, body, resolved, created_at) VALUES (?,?,?,?,?,?,0,?)")
      .run(id, pageId, blockId, threadId, userId, body, now());
    this.hub.publish(page.workspace_id, { type: "comments", pageId });
    return this.comments(pageId).find((c: any) => c.id === id);
  }

  updateComment(id: string, userId: string, patch: { body?: string; resolved?: boolean }) {
    const c = this.db.prepare("SELECT * FROM comments WHERE id = ?").get(id) as any;
    if (!c) throw new HttpError(404, "Comment not found");
    if (patch.body !== undefined) {
      if (c.author_id !== userId) throw new HttpError(403, "Only the author can edit a comment");
      this.db.prepare("UPDATE comments SET body = ?, edited_at = ? WHERE id = ?").run(String(patch.body), now(), id);
    }
    if (patch.resolved !== undefined) this.db.prepare("UPDATE comments SET resolved = ? WHERE thread_id = ?").run(patch.resolved ? 1 : 0, c.thread_id);
    const page = this.store.get(c.page_id)!;
    this.hub.publish(page.workspace_id, { type: "comments", pageId: c.page_id });
  }

  deleteComment(id: string, userId: string) {
    const c = this.db.prepare("SELECT * FROM comments WHERE id = ?").get(id) as any;
    if (!c) throw new HttpError(404, "Comment not found");
    if (c.author_id !== userId) throw new HttpError(403, "Only the author can delete a comment");
    if (c.thread_id === c.id) this.db.prepare("DELETE FROM comments WHERE thread_id = ?").run(id);
    else this.db.prepare("DELETE FROM comments WHERE id = ?").run(id);
    const page = this.store.get(c.page_id)!;
    this.hub.publish(page.workspace_id, { type: "comments", pageId: c.page_id });
  }

  commentPageId(id: string): string {
    const c = this.db.prepare("SELECT page_id FROM comments WHERE id = ?").get(id) as any;
    if (!c) throw new HttpError(404, "Comment not found");
    return c.page_id;
  }

  // ------------------------------------------------------------------ version history

  versions(pageId: string) {
    return this.db
      .prepare(
        `SELECT s.id, s.page_id, s.title, s.label, s.created_by, s.created_at, u.name AS author_name
         FROM snapshots s LEFT JOIN users u ON u.id = s.created_by WHERE s.page_id = ? ORDER BY s.created_at DESC LIMIT 100`,
      )
      .all(pageId);
  }

  private snapshotDoc(versionId: string) {
    const row = this.db.prepare("SELECT * FROM snapshots WHERE id = ?").get(versionId) as any;
    if (!row) throw new HttpError(404, "Version not found");
    const doc = new Y.Doc();
    Y.applyUpdate(doc, row.state);
    return { row, doc };
  }

  versionPageId(versionId: string): string {
    return this.snapshotDoc(versionId).row.page_id;
  }

  versionPreview(versionId: string) {
    const { row, doc } = this.snapshotDoc(versionId);
    const proj = projectFragment(getFragment(doc), row.page_id, {
      isChildPage: (id) => this.store.get(id)?.parent_id === row.page_id,
    });
    const page = this.store.get(row.page_id)!;
    const map = new Map<string, Block>(
      proj.blocks.map((b) => [b.id, { ...b, workspace_id: page.workspace_id, page_id: row.page_id, created_by: null, created_at: 0, last_edited_by: null, last_edited_at: 0, archived: false }]),
    );
    const virtualPage: Block = { ...page, properties: { ...page.properties, title: proj.title }, content: proj.content };
    const markdown = pageToMarkdown(virtualPage, { get: (id) => map.get(id) ?? this.store.get(id) });
    doc.destroy();
    return { id: row.id, title: proj.title, created_at: row.created_at, markdown };
  }

  /** Restore = a new forward edit that makes the document equal the snapshot. */
  restoreVersion(versionId: string, userId: string | null) {
    const { row, doc } = this.snapshotDoc(versionId);
    this.docs.snapshot(row.page_id, userId, "Before restore");
    this.docs.mutate(row.page_id, userId, (frag) => replaceFragment(frag, getFragment(doc)));
    doc.destroy();
    this.releaseIfIdle(row.page_id);
    return this.store.get(row.page_id);
  }

  // ------------------------------------------------------------------ search

  search(workspaceId: string, q: string, limit = 20) {
    const tokens = String(q ?? "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu);
    const alive = (id: string) => {
      const chain = this.store.ancestors(id);
      return chain.length > 0 && !chain.some((b) => b.archived);
    };
    if (!tokens?.length) {
      const recent = this.db
        .prepare("SELECT id FROM blocks WHERE workspace_id = ? AND type = 'page' ORDER BY last_edited_at DESC LIMIT ?")
        .all(workspaceId, limit * 2) as any[];
      return recent
        .filter((r) => alive(r.id))
        .slice(0, limit)
        .map((r) => {
          const b = this.store.get(r.id)!;
          return { id: b.id, title: b.properties.title ?? "", icon: b.properties.icon ?? null, snippet: "", path: this.pathOf(b.id) };
        });
    }
    const match = tokens.map((t) => `"${t}"*`).join(" ");
    // Synced block text is indexed under its container: credit the pages that show it.
    const toPages = (r: any): any[] => {
      const b = this.store.get(r.page_id);
      if (b?.type !== "synced_block") return [r];
      return this.syncedInfo(b.id).pages.map((p) => ({ ...r, page_id: p.id, title: p.title }));
    };
    const rows = this.db
      .prepare(
        `SELECT page_id, title, snippet(page_search, 3, char(2), char(3), '…', 10) AS snippet, bm25(page_search, 0, 0, 5.0, 1.0) AS score
         FROM page_search WHERE page_search MATCH ? AND workspace_id = ? ORDER BY score LIMIT ?`,
      )
      .all(match, workspaceId, limit * 2) as any[];
    const seen = new Set<string>();
    return rows
      .flatMap(toPages)
      .filter((r) => !seen.has(r.page_id) && seen.add(r.page_id) && alive(r.page_id))
      .slice(0, limit)
      .map((r) => {
        const b = this.store.get(r.page_id)!;
        return { id: r.page_id, title: r.title, icon: b.properties.icon ?? null, snippet: r.snippet, path: this.pathOf(r.page_id) };
      });
  }

  private pathOf(id: string) {
    return this.store
      .ancestors(id)
      .slice(1)
      .reverse()
      .map((b) => b.properties.title || "Untitled")
      .join(" / ");
  }

  // ------------------------------------------------------------------ sharing

  getShare(pageId: string) {
    return (this.db.prepare("SELECT page_id, token, access, enabled FROM share_links WHERE page_id = ?").get(pageId) as any) ?? null;
  }

  setShare(pageId: string, userId: string, input: { enabled: boolean; access: "view" | "edit" }) {
    const access = input.access === "edit" ? "edit" : "view";
    const existing = this.getShare(pageId);
    if (existing) {
      this.db.prepare("UPDATE share_links SET enabled = ?, access = ? WHERE page_id = ?").run(input.enabled ? 1 : 0, access, pageId);
    } else {
      this.db
        .prepare("INSERT INTO share_links (page_id, token, access, enabled, created_by, created_at) VALUES (?,?,?,?,?,?)")
        .run(pageId, newToken().slice(0, 24), access, input.enabled ? 1 : 0, userId, now());
    }
    return this.getShare(pageId);
  }
}
