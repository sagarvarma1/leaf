/**
 * Leaf AI against the real server, with scripted models (no network): the agent edits
 * through sync commits as a live collaborator with presence, and "Discard" reverts
 * exactly its edits while a person's concurrent edits survive.
 */
import { insertOps } from "@leaf/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AI_USER } from "../src/ai/agent.js";
import { MockModel, type AiModel, type Message, type MessageParam } from "../src/ai/model.js";
import { NetClient } from "./client.js";
import { startServer, waitFor, type TestServer } from "./helpers.js";

/** Plays a fixed list of tool calls, one per turn, then ends. Records what it was sent. */
class ScriptModel implements AiModel {
  readonly name = "script";
  seen: MessageParam[][] = [];
  constructor(private steps: Array<{ name: string; input: Record<string, unknown> }>) {}
  async next({ messages }: { messages: MessageParam[] }): Promise<Message> {
    this.seen.push(structuredClone(messages));
    const i = messages.filter((m) => m.role === "assistant").length;
    const step = this.steps[i];
    const content = step ? [{ type: "tool_use", id: `t${i}`, name: step.name, input: step.input }] : [{ type: "text", text: "All set." }];
    return { id: `m${i}`, type: "message", role: "assistant", model: "script", content, stop_reason: step ? "tool_use" : "end_turn", usage: {} } as unknown as Message;
  }
}

let s: TestServer;
let alice: any;
let bob: any;
let ws: string;
const model: { current: AiModel } = { current: new MockModel() };
const proxy: AiModel = { name: "proxy", next: (req) => model.current.next(req) };

beforeAll(async () => {
  s = await startServer({ leaf: { aiModel: proxy, aiTypingMs: 4 } });
  alice = await s.login("alice@leaf.dev");
  bob = await s.login("bob@leaf.dev");
  ws = alice.workspaces[0].id;
});
afterAll(() => s.close());

const newPage = async (title: string, content: any[]) => (await s.api(alice.token, "POST", "/api/pages", { workspaceId: ws, title, content })).body.page;
const run = async (pageId: string, prompt: string, token = alice.token, blockId?: string) => {
  const r = await s.api(token, "POST", `/api/pages/${pageId}/ai`, { prompt, blockId });
  if (r.status !== 200) throw new Error(r.text);
  return r.body.run;
};
const finished = async (pageId: string, id: string) => {
  let last: any;
  await waitFor(async () => {
    last = (await s.api(alice.token, "GET", `/api/pages/${pageId}/ai`)).body.runs.find((r: any) => r.id === id);
    return last && last.status !== "running";
  }, 10_000, "run to finish");
  return last;
};
const para = (text: string) => ({ type: "paragraph", properties: { rich_text: [{ text }] } });

describe("Leaf AI", () => {
  it("reports status and requires membership and edit access", async () => {
    expect((await s.api(null, "GET", "/api/ai/status")).body).toMatchObject({ enabled: true });
    const page = await newPage("Private notes", [para("hello")]);
    const carol = (await s.api(null, "POST", "/api/auth/signup", { email: "carol-ai@x.dev", name: "Carol", password: "secret1" })).body;
    expect((await s.api(carol.token, "POST", `/api/pages/${page.id}/ai`, { prompt: "summarize" })).status).toBe(403);
  });

  it("summarizes a page by editing it through sync commits, attributed to Leaf AI", async () => {
    model.current = new MockModel();
    const page = await newPage("Launch notes", [para("We ship the beta to design partners on Friday."), para("Pricing stays free until the public launch in spring."), para("Offline editing is the riskiest feature to finish.")]);
    const r = await run(page.id, "Summarize this page");
    const done = await finished(page.id, r.id);
    expect(done.status).toBe("done");
    expect(done.reviewable).toBe(true);
    expect(done.steps.map((x: any) => x.label)).toEqual(["Reading the page", "Writing 5 blocks"]);
    const { blocks, page: fresh } = (await s.api(alice.token, "GET", `/api/pages/${page.id}/blocks`)).body;
    const first = blocks.find((b: any) => b.id === fresh.content[0]);
    expect(first.type).toBe("heading_2");
    expect(first.properties.rich_text[0].text).toBe("Summary");
    expect(first.last_edited_by).toBe(AI_USER.id);
    expect(blocks.filter((b: any) => b.type === "bulleted_list_item").map((b: any) => b.properties.rich_text[0].text)).toContain("We ship the beta to design partners on Friday.");
    await s.api(alice.token, "POST", `/api/ai/runs/${r.id}/keep`);
    expect((await finished(page.id, r.id)).status).toBe("kept");
  });

  it("works as a live collaborator: presence while typing, and Discard keeps a person's concurrent edits", async () => {
    model.current = new MockModel();
    const page = await newPage("Live", [para("Bob's line")]);
    // Bob follows the page like an open editor: loadPageChunk + the WebSocket.
    const bobClient = await new NetClient(s, bob.token, ws, page.id, bob.user.id).open();
    const sawAi = { name: false, cursor: false };
    const watch = setInterval(() => {
      for (const p of bobClient.presence.values()) {
        if (p.user?.id === AI_USER.id) {
          sawAi.name = true;
          if (p.sel?.item) sawAi.cursor = true;
        }
      }
    }, 2);

    const r = await run(page.id, "Add an action items checklist");
    // While the AI types, Bob edits his own paragraph.
    await waitFor(() => bobClient.texts().includes("Action items"), 5000, "AI content reaches Bob");
    const line = bobClient.blocks().find((b) => b.text && bobClient.text(b.id) === "Bob's line")!;
    bobClient.edit((v, apply) => apply(insertOps(v, bobClient.clock, v.getBlock(line.id)!, 10, [..." (edited by Bob mid-run)"])!));
    await bobClient.flush();
    await finished(page.id, r.id);
    clearInterval(watch);
    expect(sawAi).toEqual({ name: true, cursor: true });
    await waitFor(() => ![...bobClient.presence.values()].some((p) => p.user?.id === AI_USER.id), 3000, "AI presence leaves");
    expect(bobClient.blocks().filter((b) => b.type === "to_do")).toHaveLength(3);

    const d = await s.api(alice.token, "POST", `/api/ai/runs/${r.id}/discard`);
    expect(d.body.run.status).toBe("discarded");
    await waitFor(() => !bobClient.texts().includes("Action items"), 3000, "discard reaches Bob");
    expect(bobClient.blocks().filter((b) => b.type === "to_do")).toHaveLength(0);
    expect(bobClient.texts()).toContain("Bob's line (edited by Bob mid-run)");
    bobClient.close();
  });

  it("Discard keeps a person's typing inside a block the AI wrote", async () => {
    // The AI writes a paragraph; Bob types into it; Discard removes the AI's text but not Bob's.
    model.current = new ScriptModel([{ name: "insert_blocks", input: { markdown: "AI wrote this", position: "end" } }]);
    const page = await newPage("Mixed", [para("start")]);
    const bobClient = await new NetClient(s, bob.token, ws, page.id, bob.user.id).open();
    const r = await run(page.id, "write");
    await finished(page.id, r.id);
    await waitFor(() => bobClient.texts().includes("AI wrote this"), 3000, "AI text arrives");
    const id = bobClient.blocks().find((b) => b.text && bobClient.text(b.id) === "AI wrote this")!.id;
    bobClient.edit((v, apply) => apply(insertOps(v, bobClient.clock, v.getBlock(id)!, 13, [..." + Bob"])!));
    await bobClient.flush();
    await s.api(alice.token, "POST", `/api/ai/runs/${r.id}/discard`);
    await waitFor(() => !bobClient.texts().some((t) => t.includes("AI wrote")), 3000, "discard reaches Bob");
    // The AI's words are gone; the block stays because Bob's words are in it.
    expect(bobClient.texts()).toEqual(["start", " + Bob"]);
    bobClient.close();
  });

  it("answers questions about the workspace with citations", async () => {
    model.current = new MockModel();
    const page = await newPage("Ask here", [para("")]);
    const r = await run(page.id, "What did we decide about offline editing?");
    const done = await finished(page.id, r.id);
    expect(done.answer).toMatch(/\[[^\]]+\]\(leaf:\/\/page\/[\w-]+\)/);
    expect(done.reviewable).toBe(false); // nothing changed, nothing to review
  });

  it("edits databases by property name; discard restores cells and removes rows", async () => {
    const roadmapPage = (await s.api(alice.token, "GET", `/api/workspaces/${ws}/pages`)).body.blocks.find((b: any) => b.properties.title === "Q4 Roadmap");
    const db = (await s.api(alice.token, "GET", `/api/databases/${roadmapPage.id}`)).body;
    const target = db.rows.find((r: any) => r.properties.title === "Search ranking");
    model.current = new ScriptModel([
      { name: "read_database", input: { database_id: roadmapPage.id } },
      { name: "update_database_row", input: { row_id: target.id, values: { Status: "In progress", Owner: "Alice", Tags: ["Infra", "Brand new tag"], Points: 9 } } },
      { name: "add_database_row", input: { database_id: roadmapPage.id, title: "Written by AI", values: { Priority: "P0", Due: "2026-12-01" } } },
      { name: "update_database_row", input: { row_id: target.id, values: { "Days left": "x" } } },
    ]);
    const page = (await s.api(alice.token, "GET", `/api/workspaces/${ws}/pages`)).body.blocks.find((b: any) => b.properties.title === "Product Roadmap");
    const r = await run(page.id, "Update the roadmap");
    const done = await finished(page.id, r.id);
    expect(done.status).toBe("done");
    const script = model.current as ScriptModel;
    const lastResults = JSON.stringify(script.seen[script.seen.length - 1]!.slice(-1));
    expect(lastResults).toContain("computed and can't be set");
    const row = (await s.api(alice.token, "GET", `/api/blocks/${target.id}`)).body.block;
    const schema = (await s.api(alice.token, "GET", `/api/databases/${roadmapPage.id}`)).body.database.properties.schema;
    expect(row.properties.values.status).toBe("doing");
    expect(row.properties.values.owner).toBe(alice.user.id);
    expect(row.properties.values.points).toBe(9);
    expect(row.properties.values.tags.map((id: string) => schema.tags.options.find((o: any) => o.id === id).name)).toEqual(["Infra", "Brand new tag"]);
    const added = (await s.api(alice.token, "GET", `/api/databases/${roadmapPage.id}`)).body.rows.find((x: any) => x.properties.title === "Written by AI");
    expect(added.properties.values).toMatchObject({ priority: "p0", due: "2026-12-01" });

    await s.api(alice.token, "POST", `/api/ai/runs/${r.id}/discard`);
    const restored = (await s.api(alice.token, "GET", `/api/blocks/${target.id}`)).body.block;
    expect(restored.properties.values).toMatchObject({ status: target.properties.values.status, points: target.properties.values.points, tags: target.properties.values.tags });
    expect((await s.api(alice.token, "GET", `/api/blocks/${added.id}`)).body.block.archived).toBe(true);
  });

  it("refuses to edit other pages' blocks and treats bad input as tool errors", async () => {
    const other = await newPage("Other", [para("not yours")]);
    const otherBlock = (await s.api(alice.token, "GET", `/api/pages/${other.id}/blocks`)).body.blocks[0];
    const script = new ScriptModel([
      { name: "delete_block", input: { block_id: otherBlock.id } },
      { name: "insert_blocks", input: { markdown: 42 } },
      { name: "insert_blocks", input: { markdown: "x", after_block_id: "nope" } },
    ]);
    model.current = script;
    const page = await newPage("Mine", [para("mine")]);
    const done = await finished(page.id, (await run(page.id, "do things")).id);
    expect(done.status).toBe("done");
    const results = script.seen[3]!.filter((m) => m.role === "user").slice(1).map((m) => JSON.stringify(m.content));
    expect(results[0]).toContain("only edit blocks on the current page");
    expect(results[1]).toContain("markdown must be a string");
    expect(results[2]).toContain("No block nope");
    expect((await s.api(alice.token, "GET", `/api/pages/${other.id}/blocks`)).body.blocks).toHaveLength(1);
  });

  it("one run per page at a time", async () => {
    model.current = new MockModel();
    const page = await newPage("Busy", [para("x")]);
    const first = await run(page.id, "Add an action items checklist");
    expect((await s.api(alice.token, "POST", `/api/pages/${page.id}/ai`, { prompt: "summarize" })).status).toBe(409);
    await finished(page.id, first.id);
  });
});
