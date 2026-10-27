/**
 * The standard text-CRDT benchmark: automerge-perf's editing trace, every keystroke of a
 * real paper being written (259,778 edits, 104,852 final characters).
 *
 *   curl -sLO https://raw.githubusercontent.com/automerge/automerge-perf/master/edit-by-index/editing-trace.js
 *   node bench/trace-to-json.mjs editing-trace.js editing-trace.json      # data only, no eval
 *   pnpm --filter @leaf/shared bench editing-trace.json [edits]
 *
 * Measures what Leaf actually does per keystroke: the block-level API (insertOps /
 * deleteOps on a block's text slices) applying each edit locally, then a second replica
 * applying the resulting ops as remote ops, then encoding and loading the final state.
 */
import fs from "node:fs";
import { applyOp, Clock, deleteOps, insertOps, MemoryState, ownSlice, readText, TextInstance, unitsText, type Block, type RecordOp } from "../src/index.js";

const [file, limitArg] = process.argv.slice(2);
if (!file) throw new Error("usage: bench <editing-trace.json> [edits]");
const { edits, finalText } = JSON.parse(fs.readFileSync(file, "utf8")) as { edits: Array<[number, number, string?]>; finalText: string };
const n = Math.min(edits.length, Number(limitArg ?? edits.length));

function block(id: string): Block {
  return { id, type: "paragraph", workspace_id: "W", parent_id: "P", page_id: "P", properties: {}, content: [], created_by: null, created_at: 0, last_edited_by: null, last_edited_at: 0, archived: false, text: ownSlice(id) };
}
const ms = (t: number) => `${(performance.now() - t).toFixed(0)} ms`;
const mem = () => `${(process.memoryUsage().heapUsed / 2 ** 20).toFixed(0)} MB heap`;

// 1. Local: every edit through the block API, as the editor would.
const a = new MemoryState();
a.putBlock(block("B"));
const clock = new Clock("alice");
const ops: RecordOp[] = [];
let t = performance.now();
for (let i = 0; i < n; i++) {
  const [pos, del, ins] = edits[i]!;
  if (del) for (const op of deleteOps(a, clock, a.getBlock("B")!, pos, pos + del)) (applyOp(a, op), ops.push(op));
  if (ins) {
    const op = insertOps(a, clock, a.getBlock("B")!, pos, ins.split(""))!;
    applyOp(a, op);
    ops.push(op);
  }
}
const local = performance.now() - t;
const text = unitsText(readText(a, a.getBlock("B")!).units);
const expected = n === edits.length ? finalText : null;
console.log(`edits ${n.toLocaleString()} · local ${local.toFixed(0)} ms (${((n / local) * 1000).toFixed(0)} edits/s) · ${mem()}`);
if (expected !== null) console.log(`final text ${text === expected ? "matches" : "DIFFERS"} (${text.length.toLocaleString()} chars)`);

// 2. Remote: a second replica applies the same ops.
const b = new MemoryState();
b.putBlock(block("B"));
t = performance.now();
for (const op of ops) applyOp(b, op);
console.log(`remote apply ${ms(t)} · converged ${unitsText(readText(b, b.getBlock("B")!).units) === text}`);

// 3. Storage: encode, size, load; then the same after collecting old tombstones.
t = performance.now();
const json = JSON.stringify(a.instance("B").toJSON());
console.log(`encode ${ms(t)} · ${(json.length / 1024).toFixed(0)} KB stored for ${(text.length / 1024).toFixed(0)} KB of text`);
t = performance.now();
const loaded = TextInstance.fromJSON(JSON.parse(json));
console.log(`load ${ms(t)} · ${loaded.read(0, loaded.length).units.length === text.length ? "ok" : "MISMATCH"}`);

const inst = a.instance("B");
t = performance.now();
const collected = inst.gc(Date.now() + 1);
const gcJson = JSON.stringify(inst.toJSON());
console.log(`cleanup ${ms(t)} · ${collected.toLocaleString()} tombstones collected · ${(gcJson.length / 1024).toFixed(0)} KB stored`);
t = performance.now();
const reloaded = TextInstance.fromJSON(JSON.parse(gcJson));
console.log(`load ${ms(t)} · ${reloaded.read(0, reloaded.length).units.length === text.length ? "ok" : "MISMATCH"}`);
