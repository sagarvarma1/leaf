# How Leaf syncs: a rebuild of Notion's design

Leaf started on Yjs, a general-purpose CRDT library. It now runs on its own sync engine, rebuilt
from Notion's engineering posts:

- [The data model behind Notion's flexibility](https://www.notion.com/blog/data-model-behind-notion):
  blocks as records, operations, transactions, `saveTransactions`, MessageStore, RecordCache,
  `loadPageChunk`, `syncRecordValues`.
- [How Notion handles concurrent editing with CRDTs](https://www.notion.com/blog/how-notion-handles-concurrent-editing-with-crdts):
  an RGA-based text CRDT, Peritext formatting, text instances and slices.
- [How we made Notion available offline](https://www.notion.com/blog/how-we-made-notion-available-offline):
  persistent record cache, offline page trees with reasons, background refresh.

This document explains each piece, where it lives in the code, and where Leaf deviates and why.
The engine itself is `packages/shared/src/sync/`: pure TypeScript with no dependencies, run by
both the browser and the server.

## 1. Blocks are records, edits are operations

Every block (page, paragraph, to-do, database, row, column, synced block…) is one row:

```
id · type · properties · content (ordered child ids) · parent_id · page_id · text (slices) · version
```

As in Notion, `content` points down and builds the tree you see, while `parent_id` points up and
is used for permissions. Child pages and databases keep their page as parent even when they sit
inside a column or a toggle. Changing a block's `type` keeps its properties: a to-do turned into
a heading and back is still checked.

Edits are **operations** on records (`sync/records.ts`):

| Leaf op | What it does | Notion's equivalent |
| --- | --- | --- |
| `create` | new record placed in a parent's `content` after a sibling | `set` on the new record + `listAfter` on the parent |
| `update` | type / properties / text slices | `update` / `set` on a path |
| `move` | out of one `content` list, into another after a sibling | `listRemove` + `listAfter` |
| `delete` / `restore` | archive (tombstone) and unplace / put back | `update {alive:false}` + `listRemove` |
| `text` | text CRDT ops on one text instance (section 3) | CRDT ops |
| `split` / `merge` | Enter / Backspace across blocks, by moving slices (section 4) | text slice ops |

Leaf names operations by intent rather than by record path (`move` instead of
`listRemove`+`listAfter`). It's the same model with fewer chances to apply half an operation, and
every op can compute its own **inverse**, which undo and AI Discard use (section 6).

Operations are grouped into **transactions**, the unit the client queues, sends and gets
confirmed (`{ id, ops }`).

## 2. The server orders structure: saveTransactions, MessageStore, versions

`POST /api/saveTransactions` (`apps/server/src/sync.ts`). For each transaction, in one SQLite
transaction:

1. Each op is checked against the caller's access (workspace member, or an edit share link
   covering the block). A permission failure **rejects the whole transaction**, as in Notion.
2. Each op is applied with the shared engine. Leaf deviates here. An op that no longer applies
   because someone else's change got there first, for example a move into a block that was just
   deleted, is **skipped** rather than failing the transaction. Rejecting the whole transaction
   would also throw away the text typed in it.
3. Every record write bumps the record's **version**, as in Notion.
4. Changed text instances are persisted, and the derived `rich_text` / `title` properties are
   recomputed so REST, search, export and the AI read plain records.

Then the commit is published on the workspace WebSocket (`hub.ts`, Leaf's MessageStore) to
every client following an affected document. Notion broadcasts *record versions* and lets
clients fetch stale records with `syncRecordValues`. Leaf pushes the committed records in the
same message, which saves a round trip per remote keystroke. Versions still decide which copy
wins on the client: the confirmation of my own transaction (HTTP reply) and someone else's later
commit (socket) can arrive in either order, and the client keeps the higher version.
`POST /api/syncRecordValues` exists for fetching records by id.

`POST /api/loadPageChunk` returns a page's records and the text instances they use. A "chunk" in
Leaf is the whole page plus the synced blocks it embeds.

## 3. Text: an RGA with Peritext formatting

`sync/text.ts`. Each block's text is a sequence CRDT, as Notion describes:

- **Character ids** are `session@clock`: the session that typed it and a Lamport clock (one
  higher than the highest clock the session has seen). A run typed in one go is one op with
  consecutive clocks, Notion's run-length grouping.
- **Inserts name an origin**: the item they were typed after. That makes the text a tree, and the
  text is the tree read in pre-order. Items with the same origin are ordered **newest first
  (higher clock), with the session id as tie-breaker**, Notion's exact rule. Every replica builds
  the same tree whatever order inserts arrive in, so everyone reads the same text. Two people
  typing at the same spot get two intact runs, not interleaved letters.
- **Deletes keep tombstones**, because other people's offline edits may still point at a deleted
  item. Leaf adds one thing: visibility is a last-writer-wins register, so undo can bring
  deleted text back.
- **Ops that arrive before what they reference wait** until it shows up. An offline client's
  queue can therefore arrive in any order.

**Formatting (Peritext).** A mark op says "bold from anchor A to anchor B". An anchor sits on one
side of an item: `before` or `after` it. **Extendable** marks (bold, italic, underline, strike,
color) end *before the next item*, so text typed at the end of a bold word is bold. **Links and
inline code** end *after their last item*, so they don't grow, matching Notion's "bold is
extendable, a link is not". When several ops of one kind cover an item, the newest wins. So
concurrent bold and italic both apply, and bold vs. un-bold resolves the same way on every
replica. Notion stores a mark op on the first item it covers. Leaf keeps mark ops in a list per
text instance; they resolve the same way.

## 4. Text instances and slices: Enter and Backspace

The subtle part of Notion's design: a block's text isn't its own CRDT. It's a list of
**slices** of **text instances** (`sync/records.ts`):

```
block.text = [{ i: instance, from: item | null, to: item | null }, …]   // [before(from), before(to))
```

- **Enter in the middle of a block** (`split`) copies no text. Block A keeps the head of the
  instance as a slice, and the new block B gets the tail: a slice of *the same instance* starting
  at the first tail item. If Bob, offline, was typing inside that tail, his insert names an origin
  inside it and lands in the instance between items that now belong to B. **His text shows up in
  B**, where it belongs. This is the case Notion's post walks through.
- **Backspace at the start of a block** (`merge`) appends B's slices to A and archives B. Text
  someone was concurrently typing in B lands in an instance range that A now shows, so it isn't
  lost.
- **Every block's first slice is its own instance, from the start** (named after the block,
  like Notion tagging an instance with the block it came from). Typing at offset 0 always has a
  place to go, and two people who create the same block at once share one instance. Typing at the
  boundary between two slices goes at the end of the earlier slice, before the later slice's start
  item, so it stays in this block.
- **Concurrent splits.** Notion's server finds the right slice after concurrent splits with
  search labels (`L`/`R` paths). Leaf's server orders structural ops and finds the block that
  *currently* holds the split point among the blocks using that instance. That's the same result,
  without labels, because the server applies splits one at a time.

## 5. The browser: TransactionQueue, RecordCache, rebase

`apps/web/lib/sync.ts`, on top of `Replica` in `sync/engine.ts`:

- **Optimistic, then confirmed.** The client holds the records the server confirmed, plus the
  **view** the editor shows: confirmed records with this tab's pending transactions re-applied
  on top. When any commit arrives, the view is rebuilt ("rebase"), so structure always ends in
  the server's order. Text needs no rebase: instances are CRDTs shared by both, and every op is
  applied exactly once whichever way it arrives.
- **TransactionQueue.** A local edit is applied to the view immediately, appended to the queue,
  saved in IndexedDB (it survives a reload or a crash while offline), and sent oldest first.
  Everything queued goes up in one `saveTransactions` call, and the next call waits for the
  answer.
- **RecordCache.** Every opened or kept page's records and text instances are written to
  IndexedDB, so a page opens from there when the network is down.
- **Catch-up.** After reconnecting, followed pages are reloaded with `loadPageChunk` and the
  queue is sent. Going offline closes the socket on purpose, so coming back always opens a
  fresh one.

## 6. The editor bridge, presence and undo

`apps/web/components/editor/sync-binding.ts` and `sync/pm.ts`, `sync/commit.ts`:

- **Records → editor.** `toPM` renders a page's records as a ProseMirror document. Lists are
  presentation only (each list item is a block), and children of any block use a `nest` wrapper.
- **Editor → ops.** After each local change, `fromPM` reads the editor document as the block
  tree it wants, and `commitDesired` turns the difference into operations. It recognises **Enter**
  (a new block starting with text the previous block lost) as a `split`, and **Backspace** (a
  vanished block whose text the previous one gained) as a `merge`, so concurrent typing follows
  the text, as described above. Then come creates, moves, deletes, property changes, and per-block
  text diffs, each a single delete plus insert, with formatting fixed per mark.
- **Remote changes** re-render the document. The caret is anchored to the item before it, not
  to an offset, so text inserted earlier in the paragraph doesn't move it.
- **Presence** is relayed per document over the same socket: `{ block, item }` for the caret,
  plus a selection head. Leaf AI publishes presence from the server.
- **Undo.** Applying an op returns its inverse. Undo commits the inverses of my last edit as a
  new transaction. Text inverses only hide *my* inserted items or restore what *I* deleted, so
  undo never reverts someone else's typing. **AI Discard** is the same machinery for one AI run.
  Leaf goes further than the Yjs version here: a block the AI wrote that a person has since typed
  into is kept, minus the AI's words.

## 7. Offline

Two layers (`apps/web/lib/offline.ts`, `public/sw.js`):

- **Content**: the RecordCache and TransactionQueue above. After the workspace loads, pages are
  downloaded in the background and kept **for reasons**, like Notion's offline page trees:
  `favorite`, `recent`, `workspace` (top-level pages) and `inherited` (a sub-page of a kept
  page). Each page has a download timestamp, and a page is refetched only if it was edited since,
  which mirrors `lastDownloadedTimestamp` vs `lastUpdatedTime`. Kept pages stay subscribed, so
  their cached copies follow live edits.
- **Shell**: a network-first service worker caches the app's HTML, scripts and read-only API
  responses, so a cold start with no network works.

Offline, you can do everything inside a page, structure included: new blocks, moves, indenting,
deletes, type changes. Database cells, comments and creating pages are REST calls, and they
say "You're offline".

## 8. What happens in each conflict

| Situation | Result |
| --- | --- |
| Two people type in the same paragraph | Both kept; runs typed at the same spot stay intact (newest first). |
| Both retype the same word | Both deletions and both insertions apply ("cat" → "dogcow"). A CRDT keeps all text; a person cleans up. |
| Enter in a paragraph while someone types in its tail | Their text ends up in the new block. |
| Backspace merges a block someone is typing in | Their text ends up in the merged block. |
| One person moves a block while another edits it | The edit survives: moves change `content` lists, and the text lives in its instance. |
| One person deletes a block while another types in it | The delete wins (the block is archived); undo restores it with its text. |
| Bold + italic on overlapping text | Both apply. Bold vs. un-bold: newest wins, everywhere. |
| Same property / type changed twice | Server order: the later transaction wins. |
| An op no longer applies (its block was deleted first) | Skipped; the rest of the transaction commits. |
| A transaction the user may not make | The whole transaction is refused; the client drops it and reloads the page. |

## 9. How it's tested

- `packages/shared/test/sync.test.ts`:
  - Notion's examples ("Build cool things quickly", concurrent splits, split with concurrent
    typing, merge with concurrent typing).
  - Peritext extension rules.
  - The editor bridge is a fixed point (records → editor → records produces no ops).
  - Undo that skips other people's edits.
  - A randomized simulation with a server and three clients making random typing, deletes,
    formatting, splits, merges, creates, moves and deletes, going offline and back. Every replica
    must end identical to the server. 8 seeds run by default, and `FUZZ=1000 FUZZ_STEPS=800`
    ran clean.
- `apps/server/test/convergence.test.ts`: the same protocol over real HTTP and WebSockets against
  the real server. Three clients make random concurrent edits; then offline merge, permission
  refusals, and the state served after a restart.
- `scripts/e2e.mjs`: two people in real browsers, including offline with the network cut (service
  worker included), a cold reload, and a reconnect that merges.
