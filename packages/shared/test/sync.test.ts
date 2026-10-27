import { afterAll, describe, expect, it } from "vitest";
import {
  Clock,
  commitDesired,
  commitTransaction,
  createBlocks,
  deleteOps,
  docBlocks,
  fromPM,
  insertOps,
  markOps,
  MemoryState,
  ownSlice,
  readText,
  Replica,
  stampInverse,
  TextInstance,
  toPM,
  unitsText,
  type Block,
  type BlockInput,
  type Commit,
  type PMNode,
  type RecordOp,
  type TextOp,
  type Transaction,
} from "../src/index.js";

// ---------------------------------------------------------------- helpers

const PAGE = "P";
function pageBlock(id = PAGE): Block {
  return {
    id,
    type: "page",
    workspace_id: "W",
    parent_id: null,
    page_id: null,
    properties: { title: "" },
    content: [],
    created_by: null,
    created_at: 0,
    last_edited_by: null,
    last_edited_at: 0,
    archived: false,
    text: ownSlice(id),
  };
}

function seeded(inputs: BlockInput[]) {
  const state = new MemoryState();
  state.putBlock(pageBlock());
  const clock = new Clock("seed");
  const ids = createBlocks(state, clock, PAGE, null, inputs, (op) => state.apply(op));
  return { state, ids };
}

const text = (state: MemoryState, id: string) => unitsText(readText(state, state.getBlock(id)!).units);
const pageText = (state: MemoryState) =>
  docBlocks(state, PAGE)
    .filter((b) => b.text)
    .map((b) => text(state, b.id));

/** A tiny in-memory deployment: one server, several clients with replicas. */
class Net {
  server = new MemoryState({ versions: true });
  clients: Client[] = [];
  /** Transactions committed, by id (the server applies each once). */
  committed = new Set<string>();
  /** Network faults: reorder, duplicate, lose confirmations. */
  faults: (() => number) | null = null;
  constructor(inputs: BlockInput[] = [{ type: "paragraph", properties: { rich_text: [{ text: "Hello" }] } }]) {
    this.server.putBlock(pageBlock());
    const clock = new Clock("seed");
    createBlocks(this.server, clock, PAGE, null, inputs, (op) => this.server.apply(op));
  }
  client(name: string) {
    const c = new Client(this, name);
    c.catchUp();
    this.clients.push(c);
    return c;
  }
  broadcast(commit: Commit, except?: Client) {
    for (const c of this.clients) if (c.online && c !== except) c.inbox.push(commit);
  }
  /** saveTransactions: apply once; a re-sent transaction gets the current records instead. */
  save(tx: Transaction, from: Client): Commit {
    if (this.committed.has(tx.id)) {
      const ids = new Set<string>();
      for (const op of tx.ops) for (const k of ["id", "parent", "into", "from", "newId"]) if (typeof (op as any)[k] === "string") ids.add((op as any)[k]);
      return { tx: tx.id, session: from.name, userId: from.name, records: [...ids].map((id) => this.server.getBlock(id)!).filter(Boolean), text: [], skipped: 0 };
    }
    this.committed.add(tx.id);
    const commit = commitTransaction(this.server, tx, { session: from.name, userId: from.name });
    this.broadcast(commit, from);
    return commit;
  }
}

class Client {
  replica: Replica;
  clock: Clock;
  online = true;
  inbox: Commit[] = [];
  private sent = new Set<string>();
  private seq = 0;
  constructor(
    private net: Net,
    readonly name: string,
  ) {
    this.replica = new Replica(name);
    this.clock = new Clock(name);
  }
  get view() {
    return this.replica.view;
  }
  /** Make ops against the view (applied as made) and queue them as one transaction. */
  edit(make: (view: MemoryState, apply: (op: RecordOp) => void) => void) {
    const ops: RecordOp[] = [];
    make(this.view, (op) => {
      this.view.apply(op);
      ops.push(op);
    });
    const tx: Transaction = { id: `${this.name}-${++this.seq}`, ops };
    this.replica.local(tx);
    return tx;
  }
  /** Send pending transactions in order; the confirmation comes back as the reply. */
  flush() {
    if (!this.online) return;
    for (const tx of [...this.replica.pending]) {
      if (this.sent.has(tx.id)) continue;
      this.sent.add(tx.id);
      const commit = this.net.save(tx, this);
      // A lost reply: the server committed it, but this client will send it again.
      if (this.net.faults && this.net.faults() < 0.15) {
        this.sent.delete(tx.id);
        continue;
      }
      this.replica.receive(commit);
    }
  }
  deliver() {
    if (!this.online) return;
    let batch = this.inbox;
    this.inbox = [];
    const f = this.net.faults;
    if (f) {
      // Reorder, and deliver some twice.
      batch = batch.flatMap((c) => (f() < 0.1 ? [c, c] : [c]));
      for (let i = batch.length - 1; i > 0; i--) {
        const j = Math.floor(f() * (i + 1));
        [batch[i], batch[j]] = [batch[j]!, batch[i]!];
      }
    }
    for (const c of batch) this.replica.receive(c);
  }
  /** Reload from the server (page load, or after being offline). */
  catchUp() {
    const records = [...this.net.server.blocks.values()];
    const instances = [...this.net.server.instances.values()].map((i) => ({ id: i.id, ops: i.ops() }));
    this.replica.load(records, instances);
  }
  goOffline() {
    this.online = false;
    this.inbox = [];
  }
  goOnline() {
    this.online = true;
    this.catchUp();
    // Unconfirmed transactions are re-sent: the server applies each exactly once.
    this.sent.clear();
    this.flush();
  }
}

function settle(net: Net) {
  for (let round = 0; round < 5; round++) {
    for (const c of net.clients) c.flush();
    for (const c of net.clients) c.deliver();
  }
}

const docJSON = (state: MemoryState) => JSON.stringify(toPM(state, PAGE, { title: true }));

// ---------------------------------------------------------------- the text CRDT

describe("text CRDT (RGA + Fugue)", () => {
  /** Type `s` right after item `after` (null: at the start), as a local edit would. */
  const ins = (inst: TextInstance, session: string, after: string | null, s: string) => {
    const op: TextOp = { t: "ins", id: `${session}@${inst.maxClock + 1}`, ...inst.placement(after), value: s.split("") };
    inst.apply([op]);
    return op;
  };
  const str = (inst: TextInstance) => unitsText(inst.read(0, inst.order().length).units);
  const lastId = (inst: TextInstance) => inst.order()[inst.order().length - 1]!;

  it("merges Notion's example: two people insert at different spots", () => {
    const a = new TextInstance("t");
    ins(a, "S", null, "Build things");
    const b = a.clone();
    const build = a.order()[4]!; // "d"
    const opA = ins(a, "E", build, " cool");
    const opB = ins(b, "C", lastId(b), " quickly");
    a.apply([opB]);
    b.apply([opA]);
    expect(str(a)).toBe("Build cool things quickly");
    expect(str(b)).toBe(str(a));
  });

  it("keeps concurrent runs at the same spot together (no interleaving)", () => {
    const a = new TextInstance("t");
    ins(a, "S", null, "ab");
    const b = a.clone();
    const after = a.order()[0]!;
    const x = ins(a, "A", after, "XXX");
    const y = ins(b, "B", after, "YYY");
    a.apply([y]);
    b.apply([x]);
    expect(str(a)).toBe(str(b));
    expect(["aXXXYYYb", "aYYYXXXb"]).toContain(str(a));
  });

  it("Fugue: two people typing backwards at the same spot don't interleave", () => {
    const a = new TextInstance("t");
    ins(a, "S", null, "ab");
    const b = a.clone();
    const at = a.order()[0]!; // after "a"
    // Each new letter goes before the previous one (the caret stays after "a").
    const xs = ["3", "2", "1"].map((ch) => ins(a, "A", at, ch));
    const ys = ["z", "y", "x"].map((ch) => ins(b, "B", at, ch));
    a.apply(ys);
    b.apply(xs);
    expect(str(a)).toBe(str(b));
    expect(["a123xyzb", "axyz123b"]).toContain(str(a));
  });

  it("loads text stored by the first (RGA, origin-based) engine unchanged", () => {
    // "Hi" then "!" after "i", plus a concurrent "?" after "i": newest first.
    const v1 = {
      id: "t",
      items: [
        ["S@1", null, "H", null],
        ["S@2", "S@1", "i", null],
        ["S@4", "S@2", "!", null],
        ["T@3", "S@2", "?", null],
      ] as Array<[string, string | null, string, null]>,
      marks: [],
    };
    const t = TextInstance.fromJSON(v1);
    expect(str(t)).toBe("Hi!?");
    // And ops written by old clients (with `origin`) still apply.
    t.apply([{ t: "ins", id: "S@9", origin: "S@4", value: ["."] } as unknown as TextOp]);
    expect(str(t)).toBe("Hi!.?");
  });

  it("stores runs compactly and collects old tombstones' content", () => {
    const a = new TextInstance("t");
    ins(a, "S", null, "hello world");
    const ids = a.order();
    a.apply([{ t: "vis", id: "S@100", targets: ids.slice(0, 6), visible: false }], 1_000); // "hello " deleted at t=1000
    expect(str(a)).toBe("world");
    expect(a.toJSON().runs).toEqual([["S@1", null, "R", "hello world"]]);
    expect(a.gc(500)).toBe(0); // too recent
    expect(a.gc(2_000)).toBe(6);
    const json = a.toJSON();
    expect(json.runs).toEqual([
      ["S@1", null, "R", 6],
      ["S@7", "S@6", "R", "world"],
    ]);
    // Collected items keep their ids: an offline edit typed after one still lands.
    const late: TextOp = { t: "ins", id: "T@200", parent: ids[2]!, side: "R", value: ["!"] };
    const b = TextInstance.fromJSON(json);
    b.apply([late]);
    expect(str(b)).toBe("!world");
    // Undo can't bring collected text back.
    b.apply([{ t: "vis", id: "S@300", targets: ids.slice(0, 6), visible: true }]);
    expect(str(b)).toBe("!world");
  });

  it("a stored run that starts with text a replica already has still delivers the rest", () => {
    const server = new TextInstance("t");
    const first = ins(server, "S", null, "ab"); // a client got this as its own op…
    ins(server, "S", server.order()[1]!, "cd"); // …but not this; the server stores "abcd" as one run
    const client = new TextInstance("t");
    client.apply([first]);
    client.apply(server.ops());
    expect(str(client)).toBe("abcd");
  });

  it("buffers ops that arrive before what they reference", () => {
    const a = new TextInstance("t");
    const first = ins(a, "A", null, "x");
    const second = ins(a, "A", lastId(a), "y");
    const b = new TextInstance("t");
    b.apply([second]);
    expect(str(b)).toBe("");
    b.apply([first]);
    expect(str(b)).toBe("xy");
  });

  it("delete keeps a tombstone that later inserts can anchor to", () => {
    const a = new TextInstance("t");
    ins(a, "A", null, "abc");
    const b = a.clone();
    const bId = a.order()[1]!;
    a.apply([{ t: "vis", id: "A@10", targets: [bId], visible: false }]);
    const y = ins(b, "B", bId, "!");
    a.apply([y]);
    expect(str(a)).toBe("a!c");
  });

  it("Peritext marks: concurrent bold and italic both apply; bold extends, links don't", () => {
    const state = seeded([{ type: "paragraph", properties: { rich_text: [{ text: "Hello world" }] } }]).state;
    const id = docBlocks(state, PAGE)[0]!.id;
    const c1 = new Clock("A");
    const c2 = new Clock("B");
    for (const op of markOps(state, c1, state.getBlock(id)!, 0, 5, "bold", true)) state.apply(op);
    for (const op of markOps(state, c2, state.getBlock(id)!, 3, 8, "italic", true)) state.apply(op);
    const rich = state.getBlock(id)!.properties.rich_text;
    expect(rich).toEqual([
      { text: "Hel", marks: { bold: true } },
      { text: "lo", marks: { bold: true, italic: true } },
      { text: " wo", marks: { italic: true } },
      { text: "rld" },
    ]);
    // Typing right after "Hello" (bold) is bold too; after a link it is not.
    state.apply(insertOps(state, c1, state.getBlock(id)!, 5, ["!"])!);
    for (const op of markOps(state, c1, state.getBlock(id)!, 7, 12, "link", "https://x.y")) state.apply(op);
    state.apply(insertOps(state, c1, state.getBlock(id)!, 12, ["?"])!);
    const runs = state.getBlock(id)!.properties.rich_text as Array<{ text: string; marks?: any }>;
    expect(runs.find((r) => r.text.includes("!"))?.marks?.bold).toBe(true);
    expect(runs.find((r) => r.text.includes("?"))?.marks?.link).toBeUndefined();
  });
});

// ---------------------------------------------------------------- slices: split and merge

describe("text instances and slices", () => {
  it("split: someone typing in the tail at the same time lands in the new block", () => {
    const net = new Net([{ type: "paragraph", properties: { rich_text: [{ text: "Hello wonderful world" }] } }]);
    const alice = net.client("alice");
    const bob = net.client("bob");
    const id = docBlocks(net.server, PAGE)[0]!.id;
    // Alice presses Enter before "world"; Bob (offline) types inside "world".
    bob.goOffline();
    alice.edit((v, apply) => {
      const t = readText(v, v.getBlock(id)!);
      apply({ op: "split", id, at: t.ids[16]!, newId: "B2", newInstance: "B2", type: "paragraph", properties: {} });
    });
    bob.edit((v, apply) => apply(insertOps(v, bob.clock, v.getBlock(id)!, 18, ["~"])!));
    settle(net);
    bob.goOnline();
    settle(net);
    expect(pageText(net.server)).toEqual(["Hello wonderful ", "wo~rld"]);
    for (const c of [alice, bob]) expect(docJSON(c.view)).toBe(docJSON(net.server));
  });

  it("merge: text typed into the merged-away block isn't lost", () => {
    const net = new Net([
      { type: "paragraph", properties: { rich_text: [{ text: "First" }] } },
      { type: "paragraph", properties: { rich_text: [{ text: "Second" }] } },
    ]);
    const alice = net.client("alice");
    const bob = net.client("bob");
    const [a, b] = docBlocks(net.server, PAGE).map((x) => x.id);
    bob.goOffline();
    alice.edit((_v, apply) => apply({ op: "merge", into: a!, from: b! }));
    bob.edit((v, apply) => apply(insertOps(v, bob.clock, v.getBlock(b!)!, 6, ["!"])!));
    settle(net);
    bob.goOnline();
    settle(net);
    expect(pageText(net.server)).toEqual(["FirstSecond!"]);
    for (const c of [alice, bob]) expect(docJSON(c.view)).toBe(docJSON(net.server));
  });

  it("concurrent splits of the same block both take effect", () => {
    const net = new Net([{ type: "paragraph", properties: { rich_text: [{ text: "one two three" }] } }]);
    const alice = net.client("alice");
    const bob = net.client("bob");
    const id = docBlocks(net.server, PAGE)[0]!.id;
    const ids = readText(net.server, net.server.getBlock(id)!).ids;
    alice.edit((_v, apply) => apply({ op: "split", id, at: ids[4]!, newId: "A2", newInstance: "A2", type: "paragraph", properties: {} }));
    bob.edit((_v, apply) => apply({ op: "split", id, at: ids[8]!, newId: "B2", newInstance: "B2", type: "paragraph", properties: {} }));
    settle(net);
    expect(pageText(net.server)).toEqual(["one ", "two ", "three"]);
    for (const c of [alice, bob]) expect(docJSON(c.view)).toBe(docJSON(net.server));
  });

  it("transactions that reach the server out of order still reach everyone (held ops are broadcast when released)", () => {
    const net = new Net([{ type: "paragraph", properties: { rich_text: [{ text: "Hi" }] } }]);
    const alice = net.client("alice");
    const bob = net.client("bob");
    const id = docBlocks(net.server, PAGE)[0]!.id;
    // Alice types three keystrokes offline: three transactions, each after the last.
    alice.goOffline();
    const txs = ["!", "?", "."].map((ch, i) => alice.edit((v, apply) => apply(insertOps(v, alice.clock, v.getBlock(id)!, 2 + i, [ch])!)));
    // They reach the server newest first; Bob only sees broadcasts.
    for (const tx of [...txs].reverse()) net.broadcast(commitTransaction(net.server, tx, { session: "alice", userId: "alice" }));
    bob.deliver();
    expect(pageText(net.server)).toEqual(["Hi!?."]);
    expect(pageText(bob.view)).toEqual(["Hi!?."]);
  });

  it("delete wins over a concurrent edit inside the deleted block", () => {
    const net = new Net([
      { type: "paragraph", properties: { rich_text: [{ text: "Keep" }] } },
      { type: "paragraph", properties: { rich_text: [{ text: "Drop" }] } },
    ]);
    const alice = net.client("alice");
    const bob = net.client("bob");
    const drop = docBlocks(net.server, PAGE)[1]!.id;
    alice.edit((_v, apply) => apply({ op: "delete", id: drop }));
    bob.edit((v, apply) => apply(insertOps(v, bob.clock, v.getBlock(drop)!, 4, ["?"])!));
    settle(net);
    expect(pageText(net.server)).toEqual(["Keep"]);
    for (const c of [alice, bob]) expect(docJSON(c.view)).toBe(docJSON(net.server));
  });

  it("moving a block keeps a concurrent edit inside it", () => {
    const net = new Net([
      { type: "paragraph", properties: { rich_text: [{ text: "A" }] } },
      { type: "paragraph", properties: { rich_text: [{ text: "B" }] } },
    ]);
    const alice = net.client("alice");
    const bob = net.client("bob");
    const [a, b] = docBlocks(net.server, PAGE).map((x) => x.id);
    alice.edit((_v, apply) => apply({ op: "move", id: a!, parent: PAGE, after: b! }));
    bob.edit((v, apply) => apply(insertOps(v, bob.clock, v.getBlock(a!)!, 1, ["!"])!));
    settle(net);
    expect(pageText(net.server)).toEqual(["B", "A!"]);
  });
});

// ---------------------------------------------------------------- editor bridge

const RICH: BlockInput[] = [
  { type: "heading_1", properties: { rich_text: [{ text: "Title" }] } },
  { type: "paragraph", properties: { rich_text: [{ text: "Hello " }, { text: "bold", marks: { bold: true } }, { text: " and " }, { text: "link", marks: { link: "https://a.b" } }] } },
  { type: "paragraph", properties: { rich_text: [{ text: "Ping " }, { text: "@Bob", mention: { type: "user", id: "u1" } }, { text: " now" }] } },
  { type: "bulleted_list_item", properties: { rich_text: [{ text: "one" }] }, children: [{ type: "bulleted_list_item", properties: { rich_text: [{ text: "nested" }] } }] },
  { type: "bulleted_list_item", properties: { rich_text: [{ text: "two" }] } },
  { type: "to_do", properties: { rich_text: [{ text: "task" }], checked: true } },
  { type: "toggle", properties: { rich_text: [{ text: "toggle" }] }, children: [{ type: "paragraph", properties: { rich_text: [{ text: "inside" }] } }] },
  { type: "quote", properties: { rich_text: [{ text: "quoted" }] } },
  { type: "callout", properties: { rich_text: [{ text: "note" }], icon: "⚠️" } },
  { type: "code", properties: { rich_text: [{ text: "let x = 1;\nx++" }], language: "typescript" } },
  { type: "divider" },
  { type: "paragraph", properties: { rich_text: [{ text: "parent" }] }, children: [{ type: "paragraph", properties: { rich_text: [{ text: "child" }] } }] },
  {
    type: "column_list",
    children: [
      { type: "column", children: [{ type: "paragraph", properties: { rich_text: [{ text: "left" }] } }] },
      { type: "column", properties: { width: 2 }, children: [{ type: "paragraph", properties: { rich_text: [{ text: "right" }] } }] },
    ],
  },
  { type: "image", properties: { url: "https://img", caption: "pic" } },
];

function edit(doc: PMNode, fn: (doc: PMNode) => void): PMNode {
  const copy = JSON.parse(JSON.stringify(doc));
  fn(copy);
  return copy;
}

describe("editor bridge", () => {
  it("records -> editor doc -> records is a fixed point (no ops)", () => {
    const { state } = seeded(RICH);
    const doc = toPM(state, PAGE, { title: true });
    const ops: RecordOp[] = [];
    commitDesired(state, new Clock("x"), fromPM(doc, PAGE), (op) => (state.apply(op), ops.push(op)));
    expect(ops).toEqual([]);
    expect(JSON.stringify(toPM(state, PAGE, { title: true }))).toBe(JSON.stringify(doc));
  });

  it("Enter in the middle of a paragraph becomes a split; Backspace becomes a merge", () => {
    const { state } = seeded([{ type: "paragraph", properties: { rich_text: [{ text: "Hello world" }] } }]);
    const doc = toPM(state, PAGE, { title: true });
    const id = doc.content![1]!.attrs!.blockId;
    const split = edit(doc, (d) => {
      d.content!.splice(1, 1, { type: "paragraph", attrs: { blockId: id }, content: [{ type: "text", text: "Hello " }] }, { type: "paragraph", attrs: { blockId: "N" }, content: [{ type: "text", text: "world" }] });
    });
    const ops: RecordOp[] = [];
    const clock = new Clock("x");
    commitDesired(state, clock, fromPM(split, PAGE), (op) => (state.apply(op), ops.push(op)));
    expect(ops.map((o) => o.op)).toEqual(["split"]);
    expect(pageText(state)).toEqual(["Hello ", "world"]);

    const merged = edit(toPM(state, PAGE, { title: true }), (d) => {
      d.content!.splice(1, 2, { type: "paragraph", attrs: { blockId: id }, content: [{ type: "text", text: "Hello world" }] });
    });
    const ops2: RecordOp[] = [];
    commitDesired(state, clock, fromPM(merged, PAGE), (op) => (state.apply(op), ops2.push(op)));
    expect(ops2.map((o) => o.op)).toEqual(["merge"]);
    expect(pageText(state)).toEqual(["Hello world"]);
  });

  it("typing, turning into a heading, indenting and deleting", () => {
    const { state } = seeded([
      { type: "paragraph", properties: { rich_text: [{ text: "a" }] } },
      { type: "paragraph", properties: { rich_text: [{ text: "b" }] } },
      { type: "paragraph", properties: { rich_text: [{ text: "c" }] } },
    ]);
    const doc = toPM(state, PAGE, { title: true });
    const [a, b, c] = doc.content!.slice(1);
    const next = edit(doc, (d) => {
      d.content = [
        { type: "title", content: [{ type: "text", text: "My page" }] },
        { type: "heading", attrs: { blockId: a!.attrs!.blockId, level: 2 }, content: [{ type: "text", text: "a!" }] },
        { type: "nest", content: [b!, c!] },
      ];
    });
    commitDesired(state, new Clock("x"), fromPM(next, PAGE), (op) => state.apply(op));
    expect(state.getBlock(PAGE)!.properties.title).toBe("My page");
    expect(state.getBlock(a!.attrs!.blockId)!.type).toBe("heading_2");
    expect(state.getBlock(b!.attrs!.blockId)!.content).toEqual([c!.attrs!.blockId]);
    expect(JSON.stringify(toPM(state, PAGE, { title: true }))).toBe(JSON.stringify(next));
  });
});

// ---------------------------------------------------------------- undo

describe("undo", () => {
  it("inverse ops revert only my change, after someone else's edit", () => {
    const net = new Net([{ type: "paragraph", properties: { rich_text: [{ text: "Hi" }] } }]);
    const alice = net.client("alice");
    const bob = net.client("bob");
    const id = docBlocks(net.server, PAGE)[0]!.id;
    const inverse: RecordOp[] = [];
    alice.edit((v, apply) => {
      const op = insertOps(v, alice.clock, v.getBlock(id)!, 2, [..." Alice"])!;
      inverse.push(...v.apply(op).inverse);
      v.apply(op); // idempotent: already applied
      apply(op);
    });
    settle(net);
    bob.edit((v, apply) => apply(insertOps(v, bob.clock, v.getBlock(id)!, 0, [..."Bob: "])!));
    settle(net);
    alice.edit((v, apply) => {
      for (const op of stampInverse(v, alice.clock, inverse)) apply(op);
    });
    settle(net);
    expect(pageText(net.server)).toEqual(["Bob: Hi"]);
  });

  it("undoing a delete, a split and a move restores the structure", () => {
    const { state } = seeded([
      { type: "paragraph", properties: { rich_text: [{ text: "one two" }] } },
      { type: "paragraph", properties: { rich_text: [{ text: "three" }] } },
    ]);
    const [a, b] = docBlocks(state, PAGE).map((x) => x.id);
    const before = docJSON(state);
    const clock = new Clock("u");
    const inv: RecordOp[][] = [];
    const run = (op: RecordOp) => inv.push(state.apply(op).inverse);
    run({ op: "split", id: a!, at: readText(state, state.getBlock(a!)!).ids[4]!, newId: "S", newInstance: "S", type: "paragraph", properties: {} });
    run({ op: "move", id: b!, parent: PAGE, after: null });
    run({ op: "delete", id: "S" });
    for (const ops of inv.reverse()) for (const op of stampInverse(state, clock, ops)) state.apply(op);
    expect(docJSON(state)).toBe(before);
  });
});

// ---------------------------------------------------------------- convergence fuzz

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("convergence under random concurrent and offline edits", () => {
  // FUZZ=300 pnpm test runs 300 seeds (the default 8 keep the suite fast). Even seeds run
  // with network faults: reordered and duplicated messages, lost confirmations.
  const seeds = Array.from({ length: Number(process.env.FUZZ ?? 8) }, (_, i) => i + 1);
  const steps = Number(process.env.FUZZ_STEPS ?? 300);
  for (const seed of seeds) {
    it(`seed ${seed}${seed % 2 ? "" : " (network faults)"}: every replica ends identical to the server`, () => {
      const rand = rng(seed);
      const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
      const net = new Net([
        { type: "paragraph", properties: { rich_text: [{ text: "alpha" }] } },
        { type: "paragraph", properties: { rich_text: [{ text: "beta" }] } },
        { type: "bulleted_list_item", properties: { rich_text: [{ text: "gamma" }] } },
      ]);
      const clients = ["a", "b", "c"].map((n) => net.client(n));
      if (seed % 2 === 0) net.faults = rng(seed * 7919);
      let fresh = 0;

      for (let step = 0; step < steps; step++) {
        const c = pick(clients);
        const r = rand();
        if (r < 0.04) {
          if (c.online) c.goOffline();
          else c.goOnline();
          continue;
        }
        if (r < 0.25) {
          c.flush();
          c.deliver();
          continue;
        }
        const blocks = docBlocks(c.view, PAGE).filter((b) => b.text);
        if (!blocks.length) continue;
        const b = pick(blocks);
        const len = readText(c.view, b).units.length;
        c.edit((v, apply) => {
          const kind = rand();
          if (kind < 0.45) {
            const op = insertOps(v, c.clock, v.getBlock(b.id)!, Math.floor(rand() * (len + 1)), [..."xyz".slice(0, 1 + Math.floor(rand() * 3))]);
            if (op) apply(op);
          } else if (kind < 0.6 && len) {
            const from = Math.floor(rand() * len);
            for (const op of deleteOps(v, c.clock, v.getBlock(b.id)!, from, Math.min(len, from + 1 + Math.floor(rand() * 3)))) apply(op);
          } else if (kind < 0.68 && len) {
            const from = Math.floor(rand() * len);
            for (const op of markOps(v, c.clock, v.getBlock(b.id)!, from, Math.min(len, from + 2), pick(["bold", "italic"]), rand() < 0.7 ? true : null)) apply(op);
          } else if (kind < 0.78 && len > 1) {
            const t = readText(v, v.getBlock(b.id)!);
            const id = `n${++fresh}${c.name}`;
            apply({ op: "split", id: b.id, at: t.ids[1 + Math.floor(rand() * (len - 1))]!, newId: id, newInstance: id, type: "paragraph", properties: {} });
          } else if (kind < 0.84) {
            const list = docBlocks(v, PAGE).filter((x) => x.text && x.parent_id === b.parent_id);
            const i = list.findIndex((x) => x.id === b.id);
            if (i > 0) apply({ op: "merge", into: list[i - 1]!.id, from: b.id });
          } else if (kind < 0.9) {
            const id = `n${++fresh}${c.name}`;
            apply({ op: "create", id, type: "paragraph", parent: PAGE, after: pick([null, ...v.getBlock(PAGE)!.content]), properties: {}, text: null });
            const op = insertOps(v, c.clock, v.getBlock(id)!, 0, ["n", "e", "w"]);
            if (op) apply(op);
          } else if (kind < 0.95) {
            apply({ op: "move", id: b.id, parent: PAGE, after: pick([null, ...v.getBlock(PAGE)!.content.filter((x) => x !== b.id)]) });
          } else if (blocks.length > 1) {
            apply({ op: "delete", id: b.id });
          }
        });
      }

      for (const c of clients) if (!c.online) c.goOnline();
      settle(net);
      for (const c of clients) c.catchUp();
      const truth = docJSON(net.server);
      for (const c of clients) {
        expect(c.replica.pending).toEqual([]);
        if (process.env.FUZZ_DEBUG) {
          for (const [id, inst] of net.server.instances) {
            const mine = c.view.instance(id);
            if (mine.order().join() !== inst.order().join()) console.log(`instance ${id}: order differs (server ${inst.size} items, client ${mine.size}, waiting ${mine.pendingOps})`);
          }
        }
        expect(pageText(c.view)).toEqual(pageText(net.server));
        expect(docJSON(c.view)).toBe(truth);
      }
    });
  }
});

// ---------------------------------------------------------------- editor-level fuzz

/** Edits shaped like the editor's: done to the editor document, committed through the bridge. */
function editorEdit(doc: PMNode, rand: () => number, fresh: () => string): PMNode {
  const d = JSON.parse(JSON.stringify(doc)) as PMNode;
  const body = d.content!.slice(1);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const isText = (n: PMNode) => n.type === "paragraph" || n.type === "heading";
  const textOf = (n: PMNode) => (n.content ?? []).map((t) => t.text ?? "").join("");
  const setText = (n: PMNode, t: string) => (n.content = t ? [{ type: "text", text: t }] : []);
  const textNodes = body.map((n, i) => ({ n, i })).filter(({ n }) => isText(n));
  const k = rand();
  if (!textNodes.length || k < 0.05) {
    body.push({ type: "paragraph", attrs: { blockId: fresh() }, content: [{ type: "text", text: "new" }] });
  } else if (k < 0.45) {
    const { n } = pick(textNodes);
    const t = textOf(n);
    const at = Math.floor(rand() * (t.length + 1));
    setText(n, t.slice(0, at) + "ab".slice(0, 1 + Math.floor(rand() * 2)) + t.slice(at));
  } else if (k < 0.55) {
    const { n } = pick(textNodes);
    const t = textOf(n);
    if (t.length) {
      const at = Math.floor(rand() * t.length);
      setText(n, t.slice(0, at) + t.slice(at + 1));
    }
  } else if (k < 0.67) {
    // Enter in the middle of a line.
    const { n, i } = pick(textNodes);
    const t = textOf(n);
    const at = Math.floor(rand() * (t.length + 1));
    setText(n, t.slice(0, at));
    body.splice(i + 1, 0, { type: "paragraph", attrs: { blockId: fresh() }, content: t.slice(at) ? [{ type: "text", text: t.slice(at) }] : [] });
  } else if (k < 0.75) {
    // Backspace at the start of a line: join it to the line above.
    const cands = textNodes.filter(({ i }) => i > 0 && isText(body[i - 1]!));
    if (cands.length) {
      const { n, i } = pick(cands);
      setText(body[i - 1]!, textOf(body[i - 1]!) + textOf(n));
      body.splice(i, 1);
    }
  } else if (k < 0.81) {
    // Turn into a heading / back into text.
    const { n } = pick(textNodes);
    if (n.type === "paragraph") Object.assign(n, { type: "heading", attrs: { ...n.attrs, level: 1 + Math.floor(rand() * 3) } });
    else Object.assign(n, { type: "paragraph", attrs: { blockId: n.attrs!.blockId } });
  } else if (k < 0.86) {
    // Tab: nest a paragraph under the paragraph above.
    const cands = textNodes.filter(({ n, i }) => n.type === "paragraph" && i > 0 && body[i - 1]!.type === "paragraph");
    if (cands.length) {
      const { n, i } = pick(cands);
      body.splice(i - 1, 2, { type: "nest", content: [body[i - 1]!, n] });
    }
  } else if (k < 0.9) {
    // Make it a bullet.
    const { n, i } = pick(textNodes.filter(({ n }) => n.type === "paragraph").concat(textNodes.slice(0, 1)));
    if (n.type === "paragraph") body.splice(i, 1, { type: "bulletList", content: [{ type: "listItem", attrs: { blockId: n.attrs!.blockId }, content: [{ type: "paragraph", attrs: { blockId: `${n.attrs!.blockId}:p` }, content: n.content }] }] });
  } else if (k < 0.95 && body.length > 1) {
    // Drag a block somewhere else.
    const from = Math.floor(rand() * body.length);
    const [node] = body.splice(from, 1);
    body.splice(Math.floor(rand() * (body.length + 1)), 0, node!);
  } else if (body.length > 1) {
    body.splice(Math.floor(rand() * body.length), 1);
  }
  d.content = [d.content![0]!, ...(body.length ? body : [{ type: "paragraph", attrs: { blockId: fresh() } }])];
  return d;
}

const opStats = new Map<string, number>();
describe("convergence through the editor bridge", () => {
  afterAll(() => {
    if (process.env.FUZZ_STATS) console.log("ops produced:", JSON.stringify(Object.fromEntries(opStats)));
  });
  const seeds = Array.from({ length: Number(process.env.FUZZ ?? 6) }, (_, i) => i + 1);
  const steps = Number(process.env.FUZZ_STEPS ?? 200);
  for (const seed of seeds) {
    it(`seed ${seed}: editor-shaped edits converge, and every render is a fixed point`, () => {
      const rand = rng(seed + 1_000);
      const net = new Net([
        { type: "paragraph", properties: { rich_text: [{ text: "alpha beta" }] } },
        { type: "heading_2", properties: { rich_text: [{ text: "gamma" }] } },
        { type: "paragraph", properties: { rich_text: [{ text: "delta" }] } },
      ]);
      const clients = ["a", "b", "c"].map((n) => net.client(n));
      let n = 0;
      for (let step = 0; step < steps; step++) {
        const c = clients[Math.floor(rand() * clients.length)]!;
        const r = rand();
        if (r < 0.04) {
          if (c.online) c.goOffline();
          else c.goOnline();
          continue;
        }
        if (r < 0.3) {
          c.flush();
          c.deliver();
          continue;
        }
        const next = editorEdit(toPM(c.view, PAGE, { title: true }), rand, () => `${c.name}-${++n}`);
        const tx = c.edit((v, apply) => commitDesired(v, c.clock, fromPM(next, PAGE), apply));
        if (process.env.FUZZ_STATS) for (const op of tx.ops) opStats.set(op.op, (opStats.get(op.op) ?? 0) + 1);
        // What the client renders now is what it asked for, modulo normalisation, and reading
        // it back changes nothing.
        const shown = toPM(c.view, PAGE, { title: true });
        const again: RecordOp[] = [];
        commitDesired(c.view.fork(), c.clock, fromPM(shown, PAGE), (op) => again.push(op));
        expect(again).toEqual([]);
      }
      for (const c of clients) if (!c.online) c.goOnline();
      settle(net);
      for (const c of clients) c.catchUp();
      const truth = docJSON(net.server);
      for (const c of clients) {
        expect(c.replica.pending).toEqual([]);
        expect(docJSON(c.view)).toBe(truth);
      }
    });
  }
});
