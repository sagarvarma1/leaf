# Leaf: demo recording script (2 minutes)

Two browser windows side by side: **Alice** on the left (normal window) and **Bob** on the right
(private window or a second browser). Use 1440p or larger so the sidebar and page both fit.
For the live link, use a guest sandbox and the **Invite a collaborator** button instead.

## Before you hit record

```bash
pnpm seed      # fresh demo data
pnpm dev       # http://localhost:3000 (ANTHROPIC_API_KEY in .env for real Claude, or LEAF_AI_MOCK=1)
```

- Left window: log in as **Alice** (one-click button). Right window: log in as **Bob**.
- Open **Scratchpad** in both. Close any open comment panels.
- Optional: open **Product Roadmap** and **Sprints** in a background tab so they're warm (first compile in dev).
- Turn on do-not-disturb. Zoom the browser to 110%.

## 0:00 – 0:10 · Hook

> "This is Leaf, a Notion I rebuilt from scratch. Every page is a tree of blocks, two people are
> editing this one live over a CRDT, and in a minute an AI is going to join them."

## 0:10 – 0:30 · Real-time editing and the block model

- Alice types `/`, picks **Heading 1**, types "Launch checklist". Bob types `[] ` and "Write the announcement".
- Both type in the **same line** at once. Point at the named cursors.
- Alice presses **Tab** on a paragraph: it becomes a child of the one above. "Any block can have children."
- Alice drags a block by ⋮⋮ onto the **right edge** of another: they become **columns**. Bob sees it.

## 0:30 – 0:55 · Leaf AI as a collaborator

- Alice clicks **✨ AI** → "Turn this page into an action-item checklist".
- On **Bob's** screen: a "Leaf AI" avatar joins and its cursor types the list in.

> "The AI isn't pasting text. Its edits are CRDT transactions with their own origin, so it shows
> up like a teammate."

- Bob keeps typing in his own line while the AI writes. Alice clicks **Discard changes**.

> "Discard undoes exactly the AI's operations. Bob's edit from the middle of the run stays,
> because it's a scoped undo in the CRDT, not a snapshot restore."

- Alice asks "What did we decide about offline editing?" and clicks the citation.

## 0:55 – 1:20 · Synced blocks and databases

- Open **Welcome to Leaf** (Alice) and **Product Roadmap** (Bob). Point at the 🚦 launch status:
  "This is a synced block, one document embedded in both pages." Alice edits it, and it changes
  on Bob's page, with her cursor inside it.
- Bob opens **Sprints**: "Points and Shipped % are rollups over a two-way relation to the roadmap."
  Bob links another item, and the rollup updates for Alice.
- On the roadmap, show **Days left** (a formula), then the **Calendar** view (drag a card to
  reschedule) and the **Gallery**.

## Optional 15-second beat · Offline (record on the live link)

- On the deployed site, turn **Wi-Fi off**. Turning off Wi-Fi doesn't cut `localhost`, so this
  only works on the live link. The sidebar says "Offline · N pages on this device".
- **Reload.** The app still opens. Click a page you've never opened, type a line, and the pill
  counts "1 change saved on this device".
- Wi-Fi back on: "✓ All changes synced", and the other window has the line.

> "Pages are CRDT documents in IndexedDB, and a service worker serves the app shell. Offline edits
> are just updates that haven't been delivered yet, so reconnecting needs no merge UI."

## 1:20 – 1:45 · Underneath

- Open `/api/pages/<id>/blocks` or **⋯ → Export as Markdown**:

> "This is the block table the server projects from the CRDT: ids, types, parent pointers,
> ordered children. Search, export, permissions and the AI all read it."

## 1:45 – 2:00 · Close

> "It deploys as a split stack: the Next app on Vercel or Orbit, the realtime server in a
> container, with signed WebSocket tickets between them. Visitors get a private sandbox.
> It has 78 unit and integration tests and 34 browser checks, including a multi-client
> convergence test and a test where the AI is discarded while a person keeps typing."

---

## Likely interview questions (and strong answers)

**Why model everything as blocks?**
Because it gives one uniform tree: pages, databases, rows and paragraphs share identity,
permissions-by-ancestry, move/reorder and history. Features compose. A database row is just a page,
so it gets the editor, comments and history for free. The ordered `content` array on the parent
(rather than a `position` column) makes reorder a single write and keeps order explicit, the way
Notion's API exposes it. I kept two Notion details: list items are blocks (the `<ul>` is a
rendering concern), and a sub-page is a block inside its parent's content.

**CRDT vs OT: why Yjs?**
OT transforms concurrent operations against each other, which needs a central authority to
order them. That's fine for a server-first product, and it's roughly how Notion's transactions work.
A CRDT makes operations commutative, so replicas converge regardless of order. I got offline editing,
reconnect diffing (state vectors) and per-user undo almost for free, and the server becomes a relay
plus storage. The tradeoffs: metadata overhead (tombstones, which Yjs GC keeps small), less control
over intent (a delete beats a concurrent edit inside the deleted block), and the doc isn't directly
queryable, which is why I project it into the block table.

**If the Yjs doc is the source of truth, is the block table really the model?**
For page bodies the doc is authoritative and the table is a projection that trails by about 300 ms.
I enforce one write path: every server-side change to content (REST block writes, renames, sub-page
links, version restore) is applied as a Yjs transaction on the live doc, then projected. So the two
can't diverge, and editors receive server writes like a collaborator's. Structure (tree, databases,
cells) is written to the table directly with server-ordered ops. If I had to make the table
authoritative for content too, I'd move to an op log over blocks (Notion-style transactions) and
make the editor a client of that.

**How is it persisted? What if the server crashes mid-edit?**
Every incoming update is appended to an `yupdates` log in SQLite before anything else, then
compacted into a single `ydocs` state on a debounce, when the last editor leaves, and at shutdown.
On load I apply the snapshot plus any log entries. There's a test that opens a second instance on
the same database without a clean shutdown and checks that the un-compacted edits are there.
Clients also keep an IndexedDB replica, so even a lost server write would be re-sent on reconnect,
because the sync handshake exchanges whatever the server lacks.

**How do block ids survive collaboration?**
Each block node carries a `blockId` attribute. Splitting a node copies attributes, so a client
plugin re-keys duplicates after local edits. The server re-keys any duplicates it still sees, and
any id that belongs to another page (paste across pages), during projection. Stable ids make the
projection a diff (only changed rows are written) and let comments anchor to blocks.

**How does presence work?**
Yjs awareness on the same socket: an ephemeral per-client state (name, color, cursor as relative
positions) with a heartbeat and timeout. The server remembers which awareness ids each socket
introduced and removes them when it closes, so cursors don't linger. Avatars are derived from the
same states, de-duplicated per user.

**How would you scale this?**
The constraint is that all editors of one doc should hit the same in-memory replica. I'd route by
page id (consistent hashing or a directory service) to an owner node, with WebSockets going through
a sticky load balancer. Owner nodes persist to Postgres (state + update log) or an object store
for snapshots, and the workspace event Hub becomes Redis/NATS pub/sub. Hot docs can shard
awareness separately. For read scale, the projection feeds a search index (OpenSearch) and
caches. Because a CRDT merges in any order, a node failover can rebuild the doc from storage plus
the clients' replicas without losing edits.

**How do you handle conflicts in databases?**
Cells are last-writer-wins registers applied in server order, so two people editing different cells
of a row both win. That's tested. Schema ops (add/rename/retype/delete property, views) are
validated and applied in one SQLite transaction. I chose not to put databases in the CRDT because
cells are atomic values and LWW matches what users expect from a cell.

**What was hardest?**
Making the editor schema and the block model agree. ProseMirror needs list containers, toggle
summaries and a title node, while the block model wants flat list items and child arrays. The
convert module (with round-trip tests) is the contract between them. The second hardest was
avoiding duplicate initial content: an editor bound to an empty Yjs fragment fills in a default
paragraph, and two clients doing that at once merge into duplicates. So the server always creates
the document, and the client only mounts the editor once the doc has content.

**How does the AI fit into a CRDT editor? Why not just insert its output?**
The agent runs on the server as a tool-use loop (Claude Opus 5.5) with block-level tools: read
page, insert Markdown as blocks, rewrite a block, search, read and edit databases. Every page
edit is a Yjs transaction on the live document with one origin object per run, so it streams
into everyone's editor through the normal sync path, and the AI has its own awareness state
(name, color, a cursor placed with Yjs relative positions inside the text it's typing). The
origin is what makes Discard work: a `Y.UndoManager` tracking only that origin reverts exactly
the AI's operations, even after someone typed around them. A snapshot restore would wipe their
work. Things that aren't in the page doc (new pages, rows, cells) are logged and reverted
separately, and a cell is restored only if nobody changed it since.

**How do you keep the AI from doing damage?**
It runs with the requesting user's permissions, only edits blocks on the page it was started
from, validates every tool input, and the system prompt says page content is data, not
instructions (prompt injection). Every run is reviewable and can be discarded. It's
rate-limited per user, one run per page, and the refusal fallback is on. For tests and keyless
demos there's a deterministic mock model that drives the same loop and tools.

**How do children of any block work if ProseMirror paragraphs can't contain blocks?**
A block with children is wrapped in a `nest` node: the first child is the block itself (it keeps
its id) and the rest are its children. That's the same shape list items and toggles already
use, so the projection just treats the head as the parent. The block table sees an ordinary
paragraph whose `content` holds its children. Turn-into restructures instead of lifting, so a
paragraph with children becomes a toggle or bullet that still holds them.

**What was the subtle bug class in collaborative layout?**
Schema validation. When a merged Yjs tree doesn't fit the ProseMirror schema, y-prosemirror
*deletes* the element from the shared doc, on every client. If columns required two columns, two
people each removing a different column at once would leave an "invalid" list and lose its
content. So layout schemas are lenient, leftovers are allowed, and cleanup (unwrapping a
one-child nest) only runs inside the local user's own edits. If every client "fixed" remote
leftovers, two of them could fix the same thing concurrently and duplicate content.

**How are synced blocks built?**
The synced content is its own Yjs document owned by a container block, exactly like a page. Each
page that shows it holds an instance block pointing at the container and renders a nested
editor bound to that document, so cursors, undo and offline work inside it for free. Pasting
an instance keeps the container id, which is how you make another live copy. Access follows the
container's ancestry, and search indexes the content under the container and credits every
page that shows it.

**How do relations and rollups stay consistent?**
Cells are server-ordered last-writer-wins registers. A two-way relation is two properties that
point at each other. Writing one side computes the added and removed links and updates the
mirror cells on the related rows in the same SQLite transaction, then publishes all changed
rows. Rollups and formulas are computed, never stored: the same pure evaluator runs in the
browser (so they update live as related rows change) and on the server (export, the AI).
Formulas are parsed by a small Pratt parser, never `eval`, because any member's expression runs
in everyone's browser.

**How is it deployed?**
Two processes. The Next.js app is stateless, so it goes on Vercel or Orbit and proxies `/api`
to the server, which keeps the session cookie first-party. The realtime server holds documents
in memory and writes SQLite, so it runs in a container with a volume. WebSockets can't be
proxied by a serverless host, so they connect cross-site, where the cookie isn't sent. The
client gets a short-lived HMAC-signed ticket through the proxy instead and refreshes it before
reconnects. The e2e suite runs cross-site (`localhost` page, `127.0.0.1` sockets), so every
realtime check goes through tickets. Public visitors get 24-hour sandboxes with invite links,
and an hourly sweep deletes them completely.

**What would you test next?**
A long-running fuzz test that randomizes editor-level operations (through a headless ProseMirror +
y-prosemirror binding rather than raw Yjs), and network fault injection (dropped and reordered
messages) between clients and the server.
