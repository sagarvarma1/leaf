/**
 * Workspace event hub. Structured changes (page tree, titles, icons, databases, comments,
 * versions) are server-authoritative: the REST handler commits to SQLite, then publishes
 * the changed blocks here, and every subscribed client patches its local cache.
 */
import type { Block } from "@leaf/shared";

export interface Subscriber {
  workspaceId: string;
  /** Members see everything; share-link guests only blocks under their shared page. */
  canSee(block: Block): boolean;
  /** Workspace members (not share-link guests). */
  member?: boolean;
  send(json: string): void;
}

export type HubEvent =
  | { type: "blocks"; blocks: Block[] }
  | { type: "deleted"; ids: string[] }
  | { type: "comments"; pageId: string }
  | { type: "versions"; pageId: string }
  | { type: "members" }
  | { type: "ai"; run: unknown };

export class Hub {
  private subs = new Set<Subscriber>();

  add(s: Subscriber) {
    this.subs.add(s);
    return () => this.subs.delete(s);
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
}
