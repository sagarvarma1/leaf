import type { Block, BlockType } from "@leaf/shared";
import type { DB } from "./db.js";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Row = Record<string, any>;

export function rowToBlock(r: Row): Block {
  return {
    id: r.id,
    type: r.type,
    workspace_id: r.workspace_id,
    parent_id: r.parent_id ?? null,
    page_id: r.page_id ?? null,
    properties: JSON.parse(r.properties),
    content: JSON.parse(r.content),
    created_by: r.created_by ?? null,
    created_at: Number(r.created_at),
    last_edited_by: r.last_edited_by ?? null,
    last_edited_at: Number(r.last_edited_at),
    archived: Boolean(r.archived),
    text: r.text ? JSON.parse(r.text) : null,
    version: Number(r.version ?? 1),
  };
}

/** Thin repository over the `blocks` table. */
export class BlockStore {
  constructor(private db: DB) {}

  get(id: string): Block | undefined {
    const r = this.db.prepare("SELECT * FROM blocks WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToBlock(r) : undefined;
  }

  require(id: string, type?: BlockType | BlockType[]): Block {
    const b = this.get(id);
    if (!b) throw new HttpError(404, "block not found");
    if (type && !(Array.isArray(type) ? type : [type]).includes(b.type)) throw new HttpError(400, `expected ${type} block`);
    return b;
  }

  insert(b: Block) {
    this.db
      .prepare(
        `INSERT INTO blocks (id, type, workspace_id, parent_id, page_id, properties, content, created_by, created_at, last_edited_by, last_edited_at, archived, text)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        b.id,
        b.type,
        b.workspace_id,
        b.parent_id,
        b.page_id,
        JSON.stringify(b.properties),
        JSON.stringify(b.content),
        b.created_by,
        b.created_at,
        b.last_edited_by,
        b.last_edited_at,
        b.archived ? 1 : 0,
        b.text ? JSON.stringify(b.text) : null,
      );
    this.indexText(b);
  }

  /** Insert or replace a whole record (the sync engine writes records this way). */
  put(b: Block) {
    const old = this.get(b.id);
    if (!old) return this.insert(b);
    this.db
      .prepare(
        `UPDATE blocks SET type=?, workspace_id=?, parent_id=?, page_id=?, properties=?, content=?, created_by=?, created_at=?, last_edited_by=?, last_edited_at=?, archived=?, text=?, version=version+1 WHERE id=?`,
      )
      .run(
        b.type,
        b.workspace_id,
        b.parent_id,
        b.page_id,
        JSON.stringify(b.properties),
        JSON.stringify(b.content),
        b.created_by,
        b.created_at,
        b.last_edited_by,
        b.last_edited_at,
        b.archived ? 1 : 0,
        b.text ? JSON.stringify(b.text) : null,
        b.id,
      );
    if (JSON.stringify(old.text ?? null) !== JSON.stringify(b.text ?? null)) this.indexText(b);
  }

  /** Which text instances a block shows (so text ops find the blocks they affect). */
  private indexText(b: Block) {
    this.db.prepare("DELETE FROM block_instances WHERE block_id = ?").run(b.id);
    const ins = this.db.prepare("INSERT OR IGNORE INTO block_instances (block_id, instance_id) VALUES (?,?)");
    for (const s of b.text ?? []) ins.run(b.id, s.i);
  }

  blocksOfInstance(instanceId: string): string[] {
    return (this.db.prepare("SELECT block_id FROM block_instances WHERE instance_id = ?").all(instanceId) as Row[]).map((r) => r.block_id);
  }

  update(id: string, patch: Partial<Pick<Block, "parent_id" | "properties" | "content" | "archived" | "last_edited_by" | "last_edited_at" | "page_id">>) {
    const sets: string[] = [];
    const vals: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      vals.push(k === "properties" || k === "content" ? JSON.stringify(v) : k === "archived" ? (v ? 1 : 0) : v);
    }
    if (!sets.length) return;
    sets.push("version = version + 1");
    vals.push(id);
    this.db.prepare(`UPDATE blocks SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  children(parentId: string, type?: BlockType): Block[] {
    const rows = type
      ? this.db.prepare("SELECT * FROM blocks WHERE parent_id = ? AND type = ?").all(parentId, type)
      : this.db.prepare("SELECT * FROM blocks WHERE parent_id = ?").all(parentId);
    return (rows as Row[]).map(rowToBlock);
  }

  /** Live content blocks of a page (or synced block container). */
  contentOf(pageId: string): Block[] {
    return (this.db.prepare("SELECT * FROM blocks WHERE page_id = ? AND archived = 0").all(pageId) as Row[]).map(rowToBlock);
  }

  /** Pages and databases of a workspace (no content blocks). */
  structure(workspaceId: string): Block[] {
    return (
      this.db
        .prepare("SELECT * FROM blocks WHERE workspace_id = ? AND type IN ('page','database') ORDER BY created_at")
        .all(workspaceId) as Row[]
    ).map(rowToBlock);
  }

  /** Chain from the block up to the root (block first). */
  ancestors(id: string): Block[] {
    const chain: Block[] = [];
    let cur = this.get(id);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.push(cur);
      cur = cur.parent_id ? this.get(cur.parent_id) : undefined;
    }
    return chain;
  }

  /** All page/database descendants (not content blocks), depth first. */
  descendants(id: string): Block[] {
    const out: Block[] = [];
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const c of this.db
        .prepare("SELECT * FROM blocks WHERE parent_id = ? AND type IN ('page','database')")
        .all(cur) as Row[]) {
        const b = rowToBlock(c);
        out.push(b);
        stack.push(b.id);
      }
    }
    return out;
  }

  /** The page a block lives in (itself if it is a page). */
  owningPage(b: Block): Block | undefined {
    if (b.type === "page") return b;
    if (b.page_id) return this.get(b.page_id);
    if (b.type === "database" && b.parent_id) return this.get(b.parent_id);
    return undefined;
  }

  delete(ids: string[]) {
    const stmt = this.db.prepare("DELETE FROM blocks WHERE id = ?");
    const idx = this.db.prepare("DELETE FROM block_instances WHERE block_id = ?");
    for (const id of ids) {
      stmt.run(id);
      idx.run(id);
    }
  }
}
