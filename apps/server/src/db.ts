import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  color TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  content TEXT NOT NULL DEFAULT '[]',   -- ordered root page ids
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (workspace_id, user_id)
);

-- The block table: pages, databases, database rows and every content block.
CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  parent_id TEXT,
  page_id TEXT,                      -- owning page document (content blocks only)
  properties TEXT NOT NULL DEFAULT '{}',
  content TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  last_edited_by TEXT,
  last_edited_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS blocks_parent ON blocks(parent_id);
CREATE INDEX IF NOT EXISTS blocks_page ON blocks(page_id);
CREATE INDEX IF NOT EXISTS blocks_ws_type ON blocks(workspace_id, type);

CREATE TABLE IF NOT EXISTS favorites (
  user_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, page_id)
);

-- Legacy (Yjs documents, before the Notion-style sync). Kept so old data files open.
CREATE TABLE IF NOT EXISTS ydocs (
  doc_id TEXT PRIMARY KEY,
  state BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS yupdates (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL,
  update_blob BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS yupdates_doc ON yupdates(doc_id, seq);

-- Version history: JSON of a page's records and text instances at a point in time.
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  state BLOB NOT NULL,
  title TEXT NOT NULL,
  label TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshots_page ON snapshots(page_id, created_at);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  block_id TEXT,
  thread_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  edited_at INTEGER
);
CREATE INDEX IF NOT EXISTS comments_page ON comments(page_id, created_at);

CREATE TABLE IF NOT EXISTS share_links (
  page_id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  access TEXT NOT NULL DEFAULT 'view',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS page_search USING fts5(
  page_id UNINDEXED, workspace_id UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2'
);
`;

/** Additive migrations for databases created by earlier versions. */
function migrate(db: DB) {
  const has = (table: string, col: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === col);
  // Guest sandboxes: throwaway users and workspaces that are swept after they expire.
  if (!has("users", "guest")) db.exec("ALTER TABLE users ADD COLUMN guest INTEGER NOT NULL DEFAULT 0");
  if (!has("workspaces", "expires_at")) db.exec("ALTER TABLE workspaces ADD COLUMN expires_at INTEGER");
  // Notion-style sync: block text lives in text instances (CRDTs), referenced by slices.
  if (!has("blocks", "text")) db.exec("ALTER TABLE blocks ADD COLUMN text TEXT");
  if (!has("blocks", "version")) db.exec("ALTER TABLE blocks ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
  db.exec(`CREATE TABLE IF NOT EXISTS text_instances (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS block_instances (
    block_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    PRIMARY KEY (block_id, instance_id)
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS block_instances_inst ON block_instances(instance_id)");
  db.exec(`CREATE TABLE IF NOT EXISTS join_links (
    token TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
}

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Run fn inside a transaction (node:sqlite has no helper for this). */
const depth = new WeakMap<DB, number>();
export function tx<T>(db: DB, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  if (d > 0) {
    depth.set(db, d + 1);
    try {
      return fn();
    } finally {
      depth.set(db, d);
    }
  }
  depth.set(db, 1);
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    depth.set(db, 0);
  }
}
