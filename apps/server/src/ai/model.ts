/**
 * The model behind Leaf AI. `ClaudeModel` calls the Claude API; `MockModel` is a small
 * scripted stand-in (LEAF_AI_MOCK=1) so tests, CI and keyless demos exercise the same
 * agent loop and tools deterministically, without network or cost.
 */
import Anthropic from "@anthropic-ai/sdk";

export type Message = Anthropic.Beta.BetaMessage;
export type MessageParam = Anthropic.Beta.BetaMessageParam;
export type Tool = Anthropic.Beta.BetaTool;

export interface AiModel {
  readonly name: string;
  next(req: { system: string; messages: MessageParam[]; tools: Tool[] }): Promise<Message>;
}

export const MODEL_ID = "claude-opus-5-5";

export class ClaudeModel implements AiModel {
  readonly name = MODEL_ID;
  private client = new Anthropic();

  async next({ system, messages, tools }: { system: string; messages: MessageParam[]; tools: Tool[] }): Promise<Message> {
    return this.client.beta.messages.create({
      model: MODEL_ID,
      max_tokens: 16000,
      // Interactive editing: medium effort keeps turns quick; thinking stays adaptive.
      output_config: { effort: "medium" },
      // If a safety classifier declines, the API re-runs the turn on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // The system prompt and tools are identical on every turn of a run: cache them.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
    });
  }
}

// ---------------------------------------------------------------- mock

type Block = Anthropic.Beta.BetaContentBlock;
let mockSeq = 0;

const reply = (content: Block[], stop: Message["stop_reason"]): Message =>
  ({
    id: `msg_mock_${++mockSeq}`,
    type: "message",
    role: "assistant",
    model: "leaf-mock",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }) as unknown as Message;

const text = (t: string): Block => ({ type: "text", text: t, citations: null }) as unknown as Block;
const call = (name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id: `toolu_mock_${++mockSeq}`, name, input }) as unknown as Block;

function textOf(content: MessageParam["content"]): string {
  if (typeof content === "string") return content;
  return (content ?? []).map((b: any) => (b.type === "text" ? b.text : b.type === "tool_result" ? (typeof b.content === "string" ? b.content : "") : "")).join("\n");
}

/**
 * Deterministic script keyed off the request:
 *   "summarize ..."           read_page, then insert a summary at the top
 *   "... checklist / action"  insert a to-do list at the end
 *   a question ("...?")       search_workspace, then answer citing the top hit
 *   anything else             insert the request as a paragraph
 */
export class MockModel implements AiModel {
  readonly name = "leaf-mock";

  async next({ messages }: { system: string; messages: MessageParam[]; tools: Tool[] }): Promise<Message> {
    const prompt = textOf(messages[0]!.content).split("\n\nContext:")[0]!.replace(/^Request:\s*/, "").trim();
    const turns = messages.filter((m) => m.role === "assistant").length;
    const lastResult = turns ? textOf(messages[messages.length - 1]!.content) : "";

    if (/summari[sz]e/i.test(prompt)) {
      if (turns === 0) return reply([text("Reading the page first."), call("read_page", {})], "tool_use");
      if (turns === 1) {
        const lines = lastResult
          .split("\n")
          .map((l) => l.replace(/^\s*\[[^\]]+\]\s*[\w ]+:\s*/, "").trim())
          .filter((l) => l && !l.startsWith("Page:") && !l.startsWith("#") && l.length > 12)
          .slice(0, 3);
        const md = ["## Summary", ...lines.map((l) => `- ${l.slice(0, 120)}`), "> ✨ Written by Leaf AI"].join("\n");
        return reply([call("insert_blocks", { markdown: md, position: "start" })], "tool_use");
      }
      return reply([text("Added a three-point summary at the top of the page.")], "end_turn");
    }

    if (/checklist|action items|to-?dos?/i.test(prompt)) {
      if (turns === 0) {
        const md = ["## Action items", "- [ ] Confirm the launch date", "- [ ] Write the announcement", "- [ ] Schedule a review with the team"].join("\n");
        return reply([call("insert_blocks", { markdown: md, position: "end" })], "tool_use");
      }
      return reply([text("Added an action-item checklist at the end of the page.")], "end_turn");
    }

    if (prompt.includes("?")) {
      if (turns === 0) {
        const words = prompt.toLowerCase().match(/[a-z]{4,}/g) ?? [];
        const stop = new Set(["what", "when", "where", "which", "about", "does", "have", "with", "that", "this", "decide", "decided", "there"]);
        const query = words.filter((w) => !stop.has(w)).slice(0, 2).join(" ") || prompt;
        return reply([call("search_workspace", { query })], "tool_use");
      }
      const hit = /^- \[([^\]]+)\]\(leaf:\/\/page\/([\w-]+)\)(?: — (.*))?$/m.exec(lastResult);
      if (!hit) return reply([text("I couldn't find anything about that in this workspace.")], "end_turn");
      return reply([text(`According to [${hit[1]}](leaf://page/${hit[2]}): ${hit[3] ?? "see that page for details."}`)], "end_turn");
    }

    if (turns === 0) return reply([call("insert_blocks", { markdown: prompt, position: "end" })], "tool_use");
    return reply([text("Done.")], "end_turn");
  }
}

export function createModel(): AiModel | null {
  if (process.env.LEAF_AI_MOCK === "1") return new MockModel();
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return new ClaudeModel();
  return null;
}
