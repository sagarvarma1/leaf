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

> "This is Leaf, a Notion I rebuilt from scratch, including the sync engine, which I built from
> Notion's engineering blog. Every page is a tree of blocks, two people are editing this one live,
> and in a minute an AI is going to join them."

## 0:10 – 0:30 · Real-time editing and the block model

- Alice types `/`, picks **Heading 1**, types "Launch checklist". Bob types `[] ` and "Write the announcement".
- Both type in the **same line** at once. Point at the named cursors.
- Alice presses **Enter** in the middle of Bob's line while he keeps typing: his text follows into
  the new block. "That's Notion's text-slices trick: Enter doesn't copy text, it splits a shared
  text instance."
- Alice presses **Tab** on a paragraph: it becomes a child of the one above. "Any block can have children."
- Alice drags a block by ⋮⋮ onto the **right edge** of another: they become **columns**. Bob sees it.

## 0:30 – 0:55 · Leaf AI as a collaborator

- Alice clicks **✨ AI** → "Turn this page into an action-item checklist".
- On **Bob's** screen: a "Leaf AI" avatar joins and its cursor types the list in.

> "The AI isn't pasting text. Its edits are transactions from its own session, so it shows up
> like a teammate."

- Bob keeps typing in his own line while the AI writes. Alice clicks **Discard changes**.

> "Discard applies the inverse of exactly the AI's operations. Bob's edit from the middle of the
> run stays, because it reverts operations, not a snapshot."

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

> "Like Notion's offline mode: pages are kept in a record cache in IndexedDB, edits wait in a
> transaction queue, and a service worker serves the app shell. On reconnect the queue goes up,
> text merges as a CRDT and structure follows the server's order, so there's no merge UI."

## 1:20 – 1:45 · Underneath

- Open `/api/pages/<id>/blocks` or **⋯ → Export as Markdown**:

> "These are the block records, the source of truth: ids, types, parent pointers, ordered
> children, versions. The editor sends operations on them; search, export, permissions and the
> AI read them."

## 1:45 – 2:00 · Close

> "It deploys as a split stack: the Next app on Vercel or Orbit, the realtime server in a
> container, with signed WebSocket tickets between them. Visitors get a private sandbox.
> It has 88 unit and integration tests and 35 browser checks, including a convergence simulation
> that ran clean for a thousand random scenarios."

---

## Likely interview questions (and strong answers)

**Why model everything as blocks?**
Because it gives one uniform tree: pages, databases, rows and paragraphs share identity,
permissions-by-ancestry, move/reorder and history. Features compose. A database row is just a page,
so it gets the editor, comments and history for free. The ordered `content` array on the parent
(rather than a `position` column) makes reorder a single write and keeps order explicit, the way
Notion's API exposes it. I kept two Notion details: list items are blocks (the `<ul>` is a
rendering concern), and a sub-page is a block inside its parent's content.

**How does sync work? Why not just use Yjs?**
Leaf started on Yjs, one CRDT document per page. I replaced it with my own engine built from
Notion's engineering posts, because that design separates two problems that want different
answers:
- **Structure** (create, move, delete, type, properties) is operations on block records,
  grouped into transactions that the server orders. That gives clear semantics (the server's
  order wins), a permission check per operation, and moves that can't lose edits.
- **Text** is the one part that needs character-level merging, so only text is a CRDT: an RGA
  with Notion's ordering rule and Peritext formatting.

The client applies its own transactions at once, queues them in IndexedDB, and re-applies
whatever is still pending on top of every confirmed commit (a rebase). docs/SYNC.md maps each
piece to the posts.

**Walk me through the text CRDT.**
- **Ids and ordering.** Every character has an id, `session@clock` with a Lamport clock, and
  attaches to a neighbour in a tree (Fugue's left/right children), read in order. Siblings sort
  newest first, with the session as tie-breaker, Notion's rule. Every replica builds the
  same tree in any delivery order, and two people typing at the same spot get two intact runs.
- **Deletes and run-length.** Deletes leave tombstones, because offline edits may still point at
  a deleted character. A run typed in one go is one op with consecutive clocks.
- **Formatting (Peritext).** A mark op has anchors on the before or after side of an item. Bold
  ends before the next character, so typing at its end stays bold. A link ends after its last
  character, so it doesn't grow. The newest op of each mark kind wins.

**Is it fast? And what's the interleaving problem?**
I benchmarked it on the standard text-CRDT test, automerge-perf's editing trace (every
keystroke of a real paper, 259,778 edits). The first version was quadratic: about 40 minutes
for the full trace. With a chunked order index, run-length storage and an append-only op log,
it takes about a second, the same as Yjs on my machine. Yjs still wins on storage and memory
(binary encoding).

Interleaving is a known RGA flaw. Two people typing backwards at the same spot get their
letters interleaved, because every insert goes after the same left neighbour. I used the fix from
the Fugue paper (2023): when the character before the cursor already has text after it, the new
character attaches to the left of the next one instead. Each person's run stays whole, and
Notion's newest-first rule is unchanged.

**What are text instances and slices, and why bother?**
A block's text isn't its own CRDT. It's slices of a text instance.
- **Enter** in the middle of a block doesn't copy text: the new block takes the tail of the same
  instance. If someone is typing in that tail (even offline), their insert lands in the
  instance's tail and shows up in the new block.
- **Backspace** appends the second block's slices to the first, so concurrent typing in the
  merged-away block isn't lost.
- Every block's first slice is its own instance, named after the block, so offset 0 always has
  a home.
- Notion uses search labels to find slices after concurrent splits. My server orders splits, so
  it finds the block that currently holds the split point.

**How is it persisted? What if the server crashes mid-edit?**
- **Server.** Each transaction commits in one SQLite transaction: records, record versions and
  the text instances it changed. Nothing is acknowledged before it's on disk.
- **Client.** The TransactionQueue is in IndexedDB, so a reload or crash while offline doesn't
  lose edits. Re-sent transactions are safe: inserts are deduplicated by id, visibility and
  marks are idempotent, and splits and merges recognise themselves.

**How do block ids survive collaboration?**
Each editor block node carries a `blockId`. A client plugin re-keys duplicates after splits and
pastes. Ids derived for presentation (the paragraph inside a list item, an empty page's
placeholder) are deterministic, so two people typing into an empty page create the same block
and share its text instance.

**How does presence work?**
Over the same WebSocket, per document: a caret is `{ block, item }`, anchored to a character
rather than an offset, so it doesn't drift when others type earlier in the line. The server
relays it to the page's other followers and drops it when the socket closes. Leaf AI publishes
presence from the server.

**How would you scale this?**
- **Commits per page are serialized** (they're server-ordered), so I'd route each page to an
  owner node by page id, with sticky WebSockets.
- **Storage and fan-out:** records and text instances in Postgres, and the hub becomes
  Redis/NATS pub/sub.
- **Reads:** search goes to OpenSearch fed by commits.
- **Clients don't change:** they already rebase on commits and can reload a page from any node.

**How do you handle conflicts in databases?**
Cells are last-writer-wins registers applied in server order, so two people editing different cells
of a row both win. That's tested. Schema ops (add/rename/retype/delete property, views) are
validated and applied in one SQLite transaction. I chose not to put databases in the CRDT because
cells are atomic values and LWW matches what users expect from a cell.

**What was hardest?**
- **The bridge between the editor and the records.** ProseMirror needs list containers, toggle
  summaries and a title node, while the block model wants flat list items and child arrays.
  `toPM` / `fromPM` are the contract, tested as a fixed point (records → editor → records
  produces no ops). Recognising Enter and Backspace as split and merge (instead of
  delete + insert) is what makes concurrent typing follow the text.
- **A real bug the browser suite found:** after an offline reload, the client restored its
  queue in reverse. The CRDT still converged on the server, but ops that had waited for their
  origin were never broadcast when released. Now the queue keeps its order, and commits
  broadcast what took effect, including released ops.

**How does the AI fit into a collaborative editor? Why not just insert its output?**
- **A real collaborator.** The agent runs on the server as a tool-use loop (Claude Opus 5.5)
  with block-level tools: read page, insert Markdown as blocks, rewrite a block, search, read
  and edit databases. Every page edit is a commit from the run's own sync session, so it streams
  into everyone's editor, and its cursor is server-side presence that follows the text it types.
- **Discard.** Every op the engine applies returns its inverse, and the run keeps them. Discard
  applies them newest first. Text inverses hide exactly the AI's characters, so people's edits
  made during the run survive, and a block the AI wrote that someone typed into is kept with
  their words. A snapshot restore would wipe their work.
- **Outside the page.** New pages, rows and cells are logged and reverted separately, and a cell
  is restored only if nobody changed it since.

**How do you keep the AI from doing damage?**
It runs with the requesting user's permissions, only edits blocks on the page it was started
from, validates every tool input, and the system prompt says page content is data, not
instructions (prompt injection). Every run is reviewable and can be discarded. It's
rate-limited per user, one run per page, and the refusal fallback is on. For tests and keyless
demos there's a deterministic mock model that drives the same loop and tools.

**How do children of any block work if ProseMirror paragraphs can't contain blocks?**
A block with children is wrapped in a `nest` node: the first child is the block itself (it keeps
its id) and the rest are its children. That's the same shape list items and toggles already
use, so reading the editor just treats the head as the parent. The block table sees an ordinary
paragraph whose `content` holds its children. Turn-into restructures instead of lifting, so a
paragraph with children becomes a toggle or bullet that still holds them.

**What was the subtle bug class in collaborative layout?**
Concurrent edits can leave shapes nobody typed: a column list with one column, a nest with one
child. The editor schema stays lenient so those still render, and cleanup only runs inside the
local user's own edits. If every client "fixed" remote leftovers, two of them could fix the
same thing concurrently and duplicate content.

**How are synced blocks built?**
The synced content is its own document: a container block that owns its blocks, exactly like a
page. Each page that shows it holds an instance block pointing at the container and renders a
nested editor on the container's records, so cursors, undo and offline work inside it too. Pasting
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
The convergence simulation drives the engine's operations directly. Next I'd randomize
editor-level edits through a headless ProseMirror and the real binding, and inject network
faults (dropped, duplicated and reordered messages) between real clients and the server.
