/**
 * Workspace event hub, Leaf's equivalent of Notion's MessageStore. Every client keeps one
 * WebSocket open to it.
 *
 *  - Sidebar-level changes (pages, databases, comments, versions, members, AI runs) go
 *    to everyone in the workspace.
 *  - Commits (record changes + text ops) go to the clients subscribed to the documents
 *    they touch: the pages a client has open or keeps for offline use.
 *  - Presence (who is on a page and where their cursor is) is relayed to the other
 *    subscribers of that page. The server can publish presence too (Leaf AI's cursor).
 */
import type { Block, Commit } from "@leaf/shared";

export interface PresenceUser {
  id: string;
  name: string;
  color: string;
}

export interface Subscriber {
  workspaceId: string;
  /** Members see everything; share-link guests only blocks under their shared page. */
  canSee(block: Block): boolean;
  /** Workspace members (not share-link guests). */
  member?: boolean;
  /** The client's sync session (its own commits come back in the HTTP reply instead). */
  session?: string;
  user?: PresenceUser | null;
  /** Documents (pages / synced block containers) this client follows. */
  docs?: Set<string>;
  /** This client's presence per document (a page and the synced blocks in it): its selection. */
  presence?: Map<string, unknown>;
  send(json: string): void;
}

export type HubEvent =
  | { type: "blocks"; blocks: Block[] }
  | { type: "deleted"; ids: string[] }
  | { type: "comments"; pageId: string }
  | { type: "versions"; pageId: string }
  | { type: "members" }
  | { type: "ai"; run: unknown }
  | { type: "commit"; commit: Commit }
  | { type: "presence"; doc: string; session: string; user: PresenceUser | null; sel: unknown | null };

/** The document a record belongs to: a page, or a synced block container. */
export function docOf(b: Block): string | null {
  if (b.type === "page") return b.id;
  if (b.type === "synced_block" && !b.page_id) return b.id;
  return b.page_id;
}

export class Hub {
  private subs = new Set<Subscriber>();
  /** Presence published by the server itself (AI runs), by doc and session. */
  private serverPresence = new Map<string, Map<string, { user: PresenceUser; sel: unknown; workspaceId: string }>>();

  add(s: Subscriber) {
    this.subs.add(s);
    return () => {
      this.subs.delete(s);
      if (s.session) for (const doc of s.presence?.keys() ?? []) this.relayPresence(s.workspaceId, doc, s.session, null, null, s);
    };
  }

  get size() {
    return this.subs.size;
  }

  publishBlocks(workspaceId: string, blocks: Block[]) {
    if (!blocks.length) return;
    const unique = [...new Map(blocks.map((b) => [b.id, b])).values()];
    for (const s of this.subs) {
      if (s.workspaceId !== workspaceId) continue;
      const visible = unique.filter((b) => s.canSee(b));
      if (visible.length) s.send(JSON.stringify({ type: "blocks", blocks: visible } satisfies HubEvent));
    }
  }

  publish(workspaceId: string, event: HubEvent, opts: { membersOnly?: boolean } = {}) {
    const json = JSON.stringify(event);
    for (const s of this.subs) if (s.workspaceId === workspaceId && (!opts.membersOnly || s.member)) s.send(json);
  }

  /** Send a commit to the subscribers of the documents it touched (not back to its sender). */
  publishCommit(workspaceId: string, commit: Commit, docs: Set<string>) {
    // Most subscribers get the whole commit: encode it once for them.
    let whole: string | null = null;
    for (const s of this.subs) {
      if (s.workspaceId !== workspaceId || !s.docs) continue;
      if (s.session && s.session === commit.session) continue;
      if (![...docs].some((d) => s.docs!.has(d))) continue;
      const records = commit.records.filter((r) => {
        const d = docOf(r);
        return (r.type === "page" || r.type === "database" || (d !== null && s.docs!.has(d))) && s.canSee(r);
      });
      if (records.length === commit.records.length) s.send((whole ??= JSON.stringify({ type: "commit", commit } satisfies HubEvent)));
      else s.send(JSON.stringify({ type: "commit", commit: { ...commit, records } } satisfies HubEvent));
    }
  }

  /** A client changed the documents it follows: send it who is already on them. */
  subscribe(s: Subscriber, docs: string[]) {
    s.docs = new Set(docs);
    for (const other of this.subs) {
      if (other === s || other.workspaceId !== s.workspaceId || !other.presence || !other.session) continue;
      for (const [doc, sel] of other.presence) {
        if (s.docs.has(doc)) s.send(JSON.stringify({ type: "presence", doc, session: other.session, user: other.user ?? null, sel: sel ?? null } satisfies HubEvent));
      }
    }
    for (const doc of docs) {
      for (const [session, p] of this.serverPresence.get(doc) ?? []) {
        s.send(JSON.stringify({ type: "presence", doc, session, user: p.user, sel: p.sel } satisfies HubEvent));
      }
    }
  }

  /** A client is on a document with this selection (null: no caret), or left it. */
  setPresence(s: Subscriber, doc: string, sel: unknown, leave = false) {
    if (!s.session) return;
    s.presence ??= new Map();
    if (leave) {
      if (!s.presence.delete(doc)) return;
      this.relayPresence(s.workspaceId, doc, s.session, null, null, s);
      return;
    }
    s.presence.set(doc, sel ?? null);
    this.relayPresence(s.workspaceId, doc, s.session, s.user ?? null, sel ?? null, s);
  }

  /** Presence for a server-side actor (Leaf AI). sel undefined removes it. */
  setServerPresence(workspaceId: string, doc: string, session: string, user: PresenceUser, sel: unknown | undefined) {
    let byDoc = this.serverPresence.get(doc);
    if (sel === undefined) {
      byDoc?.delete(session);
      this.relayPresence(workspaceId, doc, session, null, null, null);
      return;
    }
    if (!byDoc) this.serverPresence.set(doc, (byDoc = new Map()));
    byDoc.set(session, { user, sel, workspaceId });
    this.relayPresence(workspaceId, doc, session, user, sel, null);
  }

  private relayPresence(workspaceId: string, doc: string, session: string, user: PresenceUser | null, sel: unknown, from: Subscriber | null) {
    const json = JSON.stringify({ type: "presence", doc, session, user, sel } satisfies HubEvent);
    for (const s of this.subs) if (s !== from && s.workspaceId === workspaceId && s.docs?.has(doc)) s.send(json);
  }
}
