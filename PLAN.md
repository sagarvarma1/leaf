# Leaf: Plan

Leaf is a small Notion I built to understand how Notion works underneath: a block data model,
real-time collaborative editing, and databases made of pages. The goal was a codebase small
enough to read in an afternoon that makes the same architectural decisions a real block editor
has to make, and is honest about where it takes shortcuts.

## Goals

1. **The block model is the shape of the data.** Pages, databases, rows and paragraphs are all
   blocks with `type`, `properties`, `parent_id` and an ordered `content` array. The REST API,
   search, export, history previews and permissions all read this model.
2. **Collaboration that really converges, built the way Notion builds it.** Concurrent edits
   from any number of tabs converge, offline edits survive a reload and merge on reconnect, and
   you can see who is on the page and where they're typing.
3. **It feels like Notion where it matters for a demo**: slash menu, markdown shortcuts,
   drag handles, toggles, callouts, the sidebar tree, inline databases with a board view.
4. **It runs anywhere Node 22.13+ runs**: `pnpm install && pnpm dev`, with no Docker, database
   server or native modules (thanks to `node:sqlite`).
5. **It's tested at three levels**: pure block-model logic, the API and WebSocket server, and
   real browsers.

6. **The ambitious layer**: the parts of Notion that stress the architecture most. Children
   of any block, columns, synced blocks, relations/rollups/formulas, an AI agent that edits
   as a collaborator, and a real split deployment with guest sandboxes.

## Non-goals

Horizontal scaling, fine-grained ACLs, file uploads, mobile polish. Each one is listed in the
README's limitations.

## Key decisions

| Decision | Why | Cost |
| --- | --- | --- |
| Notion's sync design, built from its engineering blog (no Yjs) | Records + server-ordered transactions give structure clear semantics, per-op permission checks and moves that can't lose edits; a CRDT only for text keeps character-level merging and offline typing | I own the engine: a text CRDT, the rebase, the editor bridge, and their tests (see docs/SYNC.md) |
| Text CRDT = RGA with Notion's ordering rule + Peritext marks | Ids `session@clock`, same-origin newest first, tombstones; marks with anchors so bold extends and links don't | Tombstones aren't garbage-collected |
| Text instances and slices | Enter/Backspace move ranges of a shared instance, so concurrent typing follows the text into the right block | A block split many times reads several slices |
| Block table is the source of truth | No projection step: REST, search, export and the AI read the same records the editor edits | Derived text (`rich_text`, `title`) is recomputed on every commit |
| Optimistic client + rebase | Edits show instantly; pending ops are re-applied on top of every confirmed commit, so the server's order wins | The view is rebuilt per commit (cheap at page scale) |
| TransactionQueue + RecordCache in IndexedDB | Offline edits (structure included) survive reloads and send on reconnect; kept pages open offline | Two client stores to keep consistent |
| Record versions | Out-of-order updates (my HTTP ack vs someone's later commit) keep the newest copy | A column bumped on every write |
| Push committed records instead of version pings | One fewer round trip per remote keystroke than Notion's fetch-on-version | Larger socket messages |
| SQLite (WAL) via `node:sqlite` | Zero setup, transactional, FTS5 built in | One writer process |
| TipTap (ProseMirror) with custom nodes | A mature editor core; the sync binding renders records into it and reads edits back | Must map the editor schema to block types (lists, toggles, nest) |
| `blockId` attribute on every block node | Stable identity across edits, so diffs, comments on blocks and drag/move keep ids | Ids must be de-duplicated after split and paste |
| Children of any block via a `nest` wrapper whose head is the block | ProseMirror text blocks can't hold blocks; this is the shape list items/toggles already use, and the head keeps its id | Another editor-vs-block-model mapping to maintain (round-trip tested) |
| Lenient layout schemas, tidy only on local edits | Concurrent edits can leave any shape (one-column list, one-child nest); rendering must accept it | Leftover wrappers can exist until the next local edit |
| Synced block = a container that owns its blocks | "Edit once, show everywhere" stays exact, with cursors and undo inside | Nested editor per instance; page snapshots don't include it |
| Two-way relations mirrored in one server transaction | Cells are server-ordered, so both sides stay consistent | Relation edits need the server (no offline database edits) |
| Formula language: Pratt parser + evaluator, no `eval` | Expressions come from any member and run in every browser | A subset of Notion's language |
| AI edits as commits from its own session, with inverses kept per run | It's a real collaborator (presence, live typing), and Discard applies the run's inverse ops: exact even with concurrent human edits, and it keeps blocks people typed into | The undo history stays in memory until kept or discarded (15 min cap) |
| Split deploy + HMAC WebSocket tickets | Next.js on a serverless host can't hold WebSockets; tickets fix the cross-site cookie problem | Two deploy targets instead of one |

## Architecture

```
Browser (Next.js :3000)                                Leaf server (:4000)
┌───────────────────────────────────┐ saveTransactions ┌──────────────────────────────────────────┐
│ TipTap + sync binding (toPM/fromPM)│ ───────────────► │ SyncService: check · apply · version     │
│ Sync client: confirmed + pending   │ loadPageChunk    │   blocks + text_instances (SQLite)        │
│   TransactionQueue  (IndexedDB)    │ ◄─────────────── │   ─► FTS index, snapshots (debounced)     │
│   RecordCache       (IndexedDB)    │                  │                                          │
│ Workspace store (sidebar)          │ ◄── /ws/events ──│ Hub (MessageStore): commits, presence,   │
│                                    │   JSON           │   sidebar events                          │
│ fetch /api/* (proxied by Next)     │ ───────────────► │ REST ─► app services ─► sync edits        │
└───────────────────────────────────┘                  └──────────────────────────────────────────┘
```

## Data flow examples

- **Typing**: keystroke → ProseMirror transaction → `fromPM` + `commitDesired` → a `text` op
  applied to the view and queued → `saveTransactions` → the server checks, applies, bumps versions
  → the commit is broadcast → other clients apply it and re-render.
- **Enter in the middle of a paragraph**: recognised as a `split`. The new block takes the tail of
  the same text instance, so concurrent typing in the tail lands in it.
- **New sub-page from the sidebar**: `POST /api/pages` → insert the page record → a server edit
  writes its title, body and a `move` into the parent's content → the commit reaches open editors
  and every sidebar.
- **Board drag**: `PATCH /api/rows/:id` (status) + a `moveRow` op → SQLite transaction → Hub →
  all clients re-group.
- **Restore a version**: snapshot "Before restore" → render the version as an editor document and
  commit it as the desired state (the same path an edit takes) → clients receive it.

## Milestones (as built)

1. Shared block model: types, database logic, Markdown. Unit tests. ✅
2. Server: schema, auth, pages and the tree, REST over blocks, real-time sync (first on Yjs),
   Hub. API and convergence tests. ✅
3. Seed data: two users, sample pages, an inline database, comments, a version. ✅
4. Web: auth, sidebar tree, editor with custom nodes, slash menu, toolbar, drag handle, block
   menu, mentions, presence. ✅
5. Databases: table and board, cells, property editing, filter and sort, row pages. ✅
6. Comments, history, search, share links, export, dark mode. ✅
7. Playwright e2e with two users and a guest. Docs. ✅
8. Block model: children of any block, turn-into that keeps children, columns (slash + drag to
   edge + resize), synced blocks with their own documents. ✅
9. Databases: two-way relations, rollups, formula language, computed filters/sorts, Calendar
   and Gallery views. ✅
10. Leaf AI: tool-use agent with presence, live typing, per-run Discard, cited answers,
    database editing, a deterministic mock model for tests. ✅
11. Deployment: WebSocket tickets, guest sandboxes with invite links and expiry sweep, Docker
    image, Fly/Caddy configs, cross-site e2e. ✅
12. Offline mode: service worker shell, background page downloads, offline status. ✅
13. **Own sync engine, after Notion's engineering blog**, replacing Yjs: records + transactions
    (`saveTransactions`, `loadPageChunk`, MessageStore, versions), an RGA text CRDT with
    Peritext marks, text instances and slices for split/merge, an optimistic client with rebase,
    TransactionQueue + RecordCache in IndexedDB, offline reasons, the editor bridge, presence and
    undo. Convergence simulation (1,000 seeds), network tests, e2e. See docs/SYNC.md. ✅

## What I'd do next

- **Scale-out**: route each page (and synced block) to an owner node by consistent hashing on
  its id, with sticky WebSockets; Redis/NATS pub/sub for the workspace hub; Postgres for blocks,
  an append-friendly store for the update log.
- **Leaf AI**: stream tokens straight into the document (today text arrives per tool call),
  comments-as-prompts ("@Leaf AI rewrite this"), AI-filled database columns that re-run when
  their inputs change, and evals on a fixed set of editing tasks.
- **Sync engine**: garbage-collect tombstones once every client has seen a delete; Notion's
  search labels for slices if structure ever stops being server-ordered; a binary encoding for
  ops (Notion reports 5× smaller storage).
- **Snapshots**: deltas instead of full states, pruning by age, visual diffs.
- **Permissions**: per-page ACL inheritance checked at REST and socket layers, plus guests.
- **Editor**: comments anchored to text ranges (item anchors, like the caret), file uploads.
- **Databases**: timeline view, OR filter groups, per-user view settings, CRDT-backed text cells
  for offline database edits.
