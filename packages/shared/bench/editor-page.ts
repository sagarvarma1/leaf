/**
 * What a keystroke costs in the editor: a page of N blocks; each keystroke changes one
 * block, and the editor bridge reads the editor document as the desired tree (fromPM),
 * turns the difference into ops (commitDesired), and a remote change is re-rendered
 * (toPM). Run: pnpm --filter @leaf/shared exec tsx bench/editor-page.ts [blocks] [keystrokes]
 */
import { Clock, commitDesired, createBlocks, fromPM, MemoryState, ownSlice, toPM, type Block, type BlockInput, type PMNode } from "../src/index.js";

const blocks = Number(process.argv[2] ?? 1000);
const keys = Number(process.argv[3] ?? 500);
const state = new MemoryState();
const page: Block = { id: "P", type: "page", workspace_id: "W", parent_id: null, page_id: null, properties: { title: "" }, content: [], created_by: null, created_at: 0, last_edited_by: null, last_edited_at: 0, archived: false, text: ownSlice("P") };
state.putBlock(page);
const clock = new Clock("me");
const inputs: BlockInput[] = Array.from({ length: blocks }, (_, i) =>
  i % 10 === 0 ? { type: "heading_2", properties: { rich_text: [{ text: `Section ${i / 10}` }] } } : { type: i % 3 ? "paragraph" : "bulleted_list_item", properties: { rich_text: [{ text: `Block ${i}: the quick brown fox jumps over the lazy dog. `, marks: i % 7 ? undefined : { bold: true } }] } },
);
createBlocks(state, clock, "P", null, inputs, (op) => void state.apply(op));

let doc = toPM(state, "P", { title: true }) as PMNode;
const target = Math.floor(blocks / 2);
const times: number[] = [];
for (let k = 0; k < keys; k++) {
  // Type one character at the end of the middle block, as the editor would report it.
  const node = doc.content![1 + target]!;
  const host = node.type === "bulletList" ? node.content![0]!.content![0]! : node;
  host.content = [...(host.content ?? []), { type: "text", text: "x" }];
  const t = performance.now();
  commitDesired(state, clock, fromPM(doc, "P"), (op) => void state.apply(op));
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);
const t = performance.now();
for (let i = 0; i < 20; i++) doc = toPM(state, "P", { title: true }) as PMNode;
const render = (performance.now() - t) / 20;
console.log(`${blocks} blocks · keystroke commit p50 ${times[Math.floor(keys / 2)]!.toFixed(2)} ms, p95 ${times[Math.floor(keys * 0.95)]!.toFixed(2)} ms · re-render ${render.toFixed(2)} ms`);
