# Leaf: Plan

Leaf is a small Notion I built to understand how Notion works underneath: a block data model,
real-time collaborative editing, and databases made of pages. The goal was a codebase small
enough to read in an afternoon that makes the same architectural decisions a real block editor
has to make, and is honest about where it takes shortcuts.

## Goals

1. **The block model is the shape of the data.** Pages, databases, rows and paragraphs are all
   blocks with `type`, `properties`, `parent_id` and an ordered `content` array. The REST API,
   search, export, history previews and permissions all read this model.
2. **Collaboration that really converges.** Concurrent edits from any number of tabs merge to
   the same bytes, offline edits survive a reload and merge on reconnect, and you can see who
   is on the page and where they're typing.
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
| Yjs CRDT per page for rich text | Character-level merge, offline, and per-user undo for free. The server is a relay plus storage. | Projection lag (~300 ms), CRDT metadata, "delete wins" semantics |
| Block table as a projection of the doc | Keeps a queryable Notion-shaped model without building an OT engine | Two representations, so every server write must go through the doc (enforced via `DocManager.mutate`) |
| Server-ordered ops for structure and databases | Cells are atomic values. Ordering on the server gives intuitive LWW and simple validation | No offline edits for structure (needs the server) |
| Title stored inside the page doc | Renames merge like any text and the sidebar updates from the projection | Renaming from the sidebar has to load the doc |
| Own y-websocket server | Control over auth, read-only enforcement, the persistence hooks and presence cleanup | ~200 lines to own |
| Append-only update log + debounced compaction | No lost keystrokes on crash, cheap writes, compact storage | Two tables to reason about |
| SQLite (WAL) via `node:sqlite` | Zero setup, transactional, FTS5 built in | One writer process |
| TipTap (ProseMirror) with custom nodes | A mature editor core and y-prosemirror binding, so effort goes into the block model | Must map the editor schema to block types (lists, toggles) |
| `blockId` attribute on every block node | Stable identity across edits, so the projection diff, comments on blocks and drag/move keep ids | Ids must be de-duplicated after split and paste (client and server both do it) |
| Children of any block via a `nest` wrapper whose head is the block | ProseMirror text blocks can't hold blocks; this is the shape list items/toggles already use, and the head keeps its id | Another editor-vs-block-model mapping to maintain (round-trip tested) |
| Lenient layout schemas, tidy only on local edits | y-prosemirror deletes elements that don't fit the schema on every client; strict rules would turn concurrent leftovers into data loss | Leftover wrappers can exist until the next local edit (harmless, the projection tolerates them) |
| Synced block = its own Yjs document | "Edit once, show everywhere" stays exact and gets cursors/undo/offline for free | Nested editor per instance; page snapshots don't include it |
| Two-way relations mirrored in one server transaction | Cells are server-ordered, so both sides stay consistent | Relation edits need the server (no offline database edits) |
| Formula language: Pratt parser + evaluator, no `eval` | Expressions come from any member and run in every browser | A subset of Notion's language |
| AI edits as Yjs transactions with a per-run origin | It's a real collaborator (presence, live typing), and a per-origin `Y.UndoManager` makes Discard exact even with concurrent human edits | The run's doc stays in memory until it's kept or discarded (15 min cap) |
| Split deploy + HMAC WebSocket tickets | Next.js on a serverless host can't hold WebSockets; tickets fix the cross-site cookie problem | Two deploy targets instead of one |

## Architecture

```
Browser (Next.js :3000)                              Leaf server (:4000)
┌──────────────────────────────┐   /ws/doc/:id    ┌───────────────────────────────────────────┐
│ TipTap + y-prosemirror        │◄──────────────►│ sync + awareness ─► DocManager             │
│ Y.Doc  ◄──► IndexedDB replica │  binary Yjs    │   live Y.Docs ─► yupdates (append)          │
│                               │                │              ─► ydocs (compact, 1s)         │
│ Workspace store (pages, DBs)  │◄── /ws/events ─│              ─► blocks + FTS (project, 300ms)│
│                               │    JSON        │ Hub (structure events)                      │
│ fetch /api/* (proxied by Next)│───────────────►│ REST ─► app services ─► SQLite transactions │
└──────────────────────────────┘                └───────────────────────────────────────────┘
```

## Data flow examples

- **Typing**: keystroke → ProseMirror transaction → y-prosemirror → Yjs update → WebSocket →
  server applies it, logs it, rebroadcasts → other clients render it. 300 ms later the projection
  updates `blocks` and the search index.
- **New sub-page from the sidebar**: `POST /api/pages` → insert page block → build its doc → append
  a page-link node to the parent's doc (a Yjs transaction, so open editors see it) → project →
  publish the page block on the Hub → every sidebar shows it.
- **Board drag**: `PATCH /api/rows/:id` (status) + a `moveRow` op → SQLite transaction → Hub →
  all clients re-group.
- **Restore a version**: snapshot "Before restore" → replace the live fragment with a deep copy
  of the snapshot (a forward edit) → clients receive it → projection.

## Milestones (as built)

1. Shared block model: types, Y ↔ blocks conversion, database logic, Markdown. Unit tests. ✅
2. Server: schema, auth, pages and the tree, REST over blocks, DocManager (log, compaction,
   projection), WebSocket sync with auth and read-only, Hub. API and convergence tests. ✅
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

## What I'd do next

- **Scale-out**: route each page (and synced block) to an owner node by consistent hashing on
  its id, with sticky WebSockets; Redis/NATS pub/sub for the workspace hub; Postgres for blocks,
  an append-friendly store for the update log.
- **Leaf AI**: stream tokens straight into the document (today text arrives per tool call),
  comments-as-prompts ("@Leaf AI rewrite this"), AI-filled database columns that re-run when
  their inputs change, and evals on a fixed set of editing tasks.
- **Snapshots**: `Y.snapshot` + update log instead of full states, pruning by age, visual diffs.
- **Permissions**: per-page ACL inheritance checked at REST and socket layers, plus guests.
- **Editor**: comments anchored to text ranges (Y.RelativePosition), file uploads, and moves that
  preserve concurrent edits inside the moved block (a move op instead of delete + insert).
- **Databases**: timeline view, OR filter groups, per-user view settings, CRDT-backed cells
  for offline database edits.
