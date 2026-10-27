/**
 * Leaf application services. Every mutation goes through here; HTTP and WebSocket
 * handlers are thin adapters.
 *
 * Writes follow Notion's model: blocks are records, and changes to them are operations
 * committed by the sync service (sync.ts), which broadcasts each commit to the clients
 * following the affected pages. Editors send transactions; the REST API, renames,
 * page moves, version restores and the AI make the same kind of edit server-side.
 * Database schemas, cells, comments and sharing are plain server-ordered writes
 * published through the Hub.
 */
import {
  applyDatabaseOp,
  commitDesired,
  createBlocks,
  defaultDatabase,
  fromPM,
  MemoryState,
  newId,
  normalizeValue,
  ownSlice,
  pageToMarkdown,
  setRichText,
  TextInstance,
  toPM,
  type Block,
  type BlockInput,
  type DatabaseOp,
  type DatabaseProperties,
  type RichText,
  type RowProperties,
  type TextInstanceJSON,
  DatabaseOpError,
  COMPUTED_TYPES,
  computedCell,
  displayValue,
  relatedRows,
  type ValueContext,
} from "@leaf/shared";
import { randomUUID } from "node:crypto";
import { hashPassword, newToken, SESSION_TTL_MS, USER_COLORS, verifyPassword } from "./auth.js";
import { openDb, tx, type DB } from "./db.js";
import { Hub } from "./hub.js";
import { SyncService, type SyncOptions } from "./sync.js";
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

export interface LeafOptions extends Partial<SyncOptions> {
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
  readonly sync: SyncService;
  readonly ai: AiAgent;

  constructor(opts: LeafOptions) {
    this.db = openDb(opts.dbFile);
    this.store = new BlockStore(this.db);
    this.sync = new SyncService(this.db, this.store, this.hub, {
      snapshotIntervalMs: opts.snapshotIntervalMs ?? 10 * 60 * 1000,
      indexDebounceMs: opts.indexDebounceMs ?? 400,
    });
    this.sync.migrateText();
    this.ai = new AiAgent(this, opts.aiModel === undefined ? createModel() : opts.aiModel, {
      typingDelayMs: opts.aiTypingMs ?? Number(process.env.LEAF_AI_TYPING_MS ?? 16),
      maxRunsPerHour: Number(process.env.LEAF_AI_RUNS_PER_HOUR ?? 30),
    });
  }

  close() {
    this.ai.close();
    this.sync.close();
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
      for (const p of pages) this.sync.drop(p.id);
      tx(this.db, () => {
        // Every text instance is named after the block that created it.
        this.db.prepare("DELETE FROM text_instances WHERE id IN (SELECT id FROM blocks WHERE workspace_id = ?)").run(id);
        this.db.prepare("DELETE FROM block_instances WHERE block_id IN (SELECT id FROM blocks WHERE workspace_id = ?)").run(id);
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

  /** Where to put a block after `afterId`: the container holding it, or the end of `doc`. */
  insertionPoint(doc: string, afterId: string | null | undefined) {
    return this.placeAfter(doc, afterId);
  }

  private placeAfter(doc: string, afterId: string | null | undefined): { parent: string; after: string | null } {
    const docBlock = this.store.get(doc)!;
    const last = docBlock.content[docBlock.content.length - 1] ?? null;
    if (!afterId) return { parent: doc, after: last };
    const anchor = this.store.get(afterId);
    if (!anchor || anchor.archived) return { parent: doc, after: last };
    const container = anchor.parent_id && this.store.get(anchor.parent_id)?.content.includes(afterId) ? anchor.parent_id : doc;
    return { parent: container, after: this.store.get(container)!.content.includes(afterId) ? afterId : last };
  }

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
      properties = { title: "", icon: input.icon ?? null, values } satisfies RowProperties;
    } else {
      properties = { title: "", icon: input.icon ?? null, cover: input.cover ?? null };
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
      text: ownSlice(id),
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
    // Title, body, and the link in the parent page: one commit.
    this.sync.edit(input.userId, ({ state, clock, apply }) => {
      if (title) setRichText(state, clock, id, [{ text: title }], (op) => void apply(op));
      createBlocks(state, clock, id, null, input.content?.length ? input.content : [{ type: "paragraph" }], (op) => void apply(op));
      if (parent?.type === "page" && input.link !== false) apply({ op: "move", id, ...this.placeAfter(parent.id, input.afterBlockId) });
    });
    changed.push(this.store.get(id)!);
    this.hub.publishBlocks(workspaceId, changed);
    return this.store.get(id)!;
  }

  updatePage(id: string, userId: string | null, patch: { title?: string; icon?: string | null; cover?: string | null; fullWidth?: boolean }) {
    const page = this.store.require(id, "page");
    if (patch.title !== undefined) {
      this.sync.edit(userId, ({ state, clock, apply }) => setRichText(state, clock, id, [{ text: String(patch.title) }], (op) => void apply(op)));
    }
    const props: Record<string, any> = {};
    for (const k of ["icon", "cover", "fullWidth"] as const) if (patch[k] !== undefined) props[k] = patch[k];
    if (Object.keys(props).length) this.sync.edit(userId, ({ apply }) => apply({ op: "update", id, properties: props }));
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

    this.sync.edit(userId, ({ apply }) => {
      if (newParent) {
        // Into a page: its link goes before `beforeId` (a sibling page) or at the end.
        const content = this.store.get(newParent.id)!.content.filter((c) => c !== id);
        const at = beforeId ? content.indexOf(beforeId) : -1;
        const after = at > 0 ? content[at - 1]! : at === 0 ? null : (content[content.length - 1] ?? null);
        apply({ op: "move", id, parent: newParent.id, after });
      } else if (oldParent) apply({ op: "detach", id });
    });
    tx(this.db, () => {
      const root = this.workspaceContent(page.workspace_id).filter((p) => p !== id);
      if (!newParent) {
        const at = beforeId ? root.indexOf(beforeId) : -1;
        if (at >= 0) root.splice(at, 0, id);
        else root.push(id);
      }
      this.setWorkspaceContent(page.workspace_id, root);
    });
    const changed = [this.store.get(id)!];
    if (oldParent) changed.push(this.store.get(oldParent.id)!);
    if (newParent) changed.push(this.store.get(newParent.id)!);
    this.hub.publishBlocks(page.workspace_id, changed);
    return this.store.get(id)!;
  }

  trashPage(id: string, userId: string | null) {
    const page = this.store.require(id, ["page"]);
    // Archive it and take its link out of the parent page (or row out of its database).
    if (page.parent_id) this.sync.edit(userId, ({ apply }) => apply({ op: "delete", id }));
    else this.store.update(id, { archived: true, last_edited_by: userId, last_edited_at: now() });
    this.db.prepare("DELETE FROM favorites WHERE page_id = ?").run(id);
    this.hub.publishBlocks(page.workspace_id, [this.store.get(id)!]);
  }

  restorePage(id: string, userId: string | null) {
    const page = this.store.require(id, ["page"]);
    const parent = page.parent_id ? this.store.get(page.parent_id) : null;
    if (!parent || this.store.ancestors(parent.id).some((a) => a.archived)) {
      // Parent is gone: restore to the workspace root, like Notion.
      if (parent) this.sync.edit(userId, ({ apply }) => apply({ op: "detach", id }));
      this.store.update(id, { archived: false, parent_id: null });
      this.setWorkspaceContent(page.workspace_id, [...this.workspaceContent(page.workspace_id).filter((p) => p !== id), id]);
    } else {
      this.sync.edit(userId, ({ apply }) => apply({ op: "restore", id, parent: parent.id, after: parent.content[parent.content.length - 1] ?? null }));
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
          this.sync.drop(b.id);
          this.db.prepare("DELETE FROM text_instances WHERE id IN (SELECT id FROM blocks WHERE page_id = ?)").run(b.id);
          this.db.prepare("DELETE FROM block_instances WHERE block_id IN (SELECT id FROM blocks WHERE page_id = ?)").run(b.id);
          this.db.prepare("DELETE FROM blocks WHERE page_id = ?").run(b.id);
          this.db.prepare("DELETE FROM text_instances WHERE id = ?").run(b.id);
          this.db.prepare("DELETE FROM favorites WHERE page_id = ?").run(b.id);
          this.db.prepare("DELETE FROM comments WHERE page_id = ?").run(b.id);
          this.db.prepare("DELETE FROM share_links WHERE page_id = ?").run(b.id);
        }
        this.store.delete([b.id]);
      }
      this.setWorkspaceContent(page.workspace_id, this.workspaceContent(page.workspace_id).filter((p) => p !== id));
      const parent = page.parent_id ? this.store.get(page.parent_id) : null;
      if (parent && parent.content.includes(id)) this.store.update(parent.id, { content: parent.content.filter((c) => c !== id) });
    });
    this.hub.publish(page.workspace_id, { type: "deleted", ids: all.map((b) => b.id) });
  }

  /** A page and its content blocks. */
  pageBlocks(pageId: string) {
    const page = this.store.require(pageId, "page");
    return { page, blocks: this.store.contentOf(pageId) };
  }

  breadcrumbs(id: string) {
    return this.store
      .ancestors(id)
      .reverse()
      .map((b) => ({ id: b.id, type: b.type, title: b.properties.title ?? "", icon: b.properties.icon ?? null }));
  }

  // ------------------------------------------------------------------ content blocks (REST)

  appendChildren(pageId: string, userId: string | null, children: BlockInput[], after?: string | null) {
    const owner = this.store.require(pageId, ["page", "synced_block"]);
    if (owner.page_id) throw new HttpError(400, "Append to the synced block's container instead");
    if (!Array.isArray(children) || !children.length) throw new HttpError(400, "children required");
    for (const c of children) {
      if (c.type === "child_page" || c.type === "child_database") throw new HttpError(400, "create pages and databases with their own endpoints");
      c.id = newId();
    }
    const where = this.placeAfter(pageId, after);
    this.sync.edit(userId, ({ state, clock, apply }) => createBlocks(state, clock, where.parent, where.after, children, (op) => void apply(op)));
    return children.map((c) => this.store.get(c.id!)).filter(Boolean);
  }

  updateBlock(blockId: string, userId: string | null, patch: { rich_text?: RichText; checked?: boolean }) {
    const b = this.store.require(blockId);
    if (!b.page_id) throw new HttpError(400, "Use the page endpoints for pages");
    this.sync.edit(userId, ({ state, clock, apply }) => {
      if (patch.rich_text && b.text) setRichText(state, clock, blockId, patch.rich_text, (op) => void apply(op));
      if (patch.checked !== undefined) apply({ op: "update", id: blockId, properties: { checked: Boolean(patch.checked) } });
    });
    return this.store.get(blockId);
  }

  deleteContentBlock(blockId: string, userId: string | null) {
    const b = this.store.require(blockId);
    if (!b.page_id) throw new HttpError(400, "Use the page endpoints for pages");
    this.sync.edit(userId, ({ apply }) => apply({ op: "delete", id: blockId }));
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
    if (input.append) this.sync.edit(input.userId, ({ apply }) => apply({ op: "move", id, ...this.placeAfter(page.id, null) }));
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
    this.sync.edit(input.userId, ({ state, clock, apply }) =>
      createBlocks(state, clock, id, null, content.length ? content : [{ type: "paragraph" }], (op) => void apply(op)),
    );
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

  /** A version as an in-memory copy of the page's records and text. */
  private snapshotState(versionId: string) {
    const row = this.db.prepare("SELECT * FROM snapshots WHERE id = ?").get(versionId) as any;
    if (!row) throw new HttpError(404, "Version not found");
    const raw = typeof row.state === "string" ? row.state : Buffer.from(row.state).toString("utf8");
    let snap: { records: Block[]; instances: TextInstanceJSON[] };
    try {
      snap = JSON.parse(raw);
    } catch {
      throw new HttpError(410, "This version was saved by an older version of Leaf");
    }
    const state = new MemoryState({
      blocks: new Map(snap.records.map((b) => [b.id, b])),
      instances: new Map(snap.instances.map((i) => [i.id, TextInstance.fromJSON(i)])),
    });
    // Child pages and databases it links to, as they are now.
    for (const b of snap.records) for (const c of b.content) if (!state.getBlock(c)) {
      const ref = this.store.get(c);
      if (ref) state.putBlock(ref);
    }
    return { row, state };
  }

  versionPageId(versionId: string): string {
    const row = this.db.prepare("SELECT page_id FROM snapshots WHERE id = ?").get(versionId) as any;
    if (!row) throw new HttpError(404, "Version not found");
    return row.page_id;
  }

  versionPreview(versionId: string) {
    const { row, state } = this.snapshotState(versionId);
    const page = state.getBlock(row.page_id)!;
    const markdown = pageToMarkdown(page, { get: (id) => state.getBlock(id) ?? this.store.get(id) });
    return { id: row.id, title: page.properties.title ?? "", created_at: row.created_at, markdown };
  }

  /**
   * Restore = a forward edit that makes the page equal the version: render the version
   * the way the editor would, then commit that as the desired state (the same path an
   * edit in the editor takes). People editing see it arrive like any other change.
   */
  restoreVersion(versionId: string, userId: string | null) {
    const { row, state: snap } = this.snapshotState(versionId);
    const pageId = row.page_id as string;
    this.sync.snapshot(pageId, userId, "Before restore");
    const desired = fromPM(toPM(snap, pageId, { title: true }), pageId, {
      isChildPage: (id) => this.store.get(id)?.type === "page" && this.store.get(id)?.parent_id === pageId,
    });
    this.sync.edit(userId, ({ state, clock, apply }) => commitDesired(state, clock, desired, (op) => void apply(op)));
    return this.store.get(pageId);
  }

  // ------------------------------------------------------------------ search

  search(workspaceId: string, q: string, limit = 20) {
    this.sync.flush(); // pending index updates first, so results include the latest edits
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
