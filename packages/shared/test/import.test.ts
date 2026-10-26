import { describe, expect, it } from "vitest";
import { inlineMarkdown, markdownToBlocks } from "../src/index.js";

describe("markdown -> blocks", () => {
  it("parses inline marks, links and page mentions", () => {
    expect(inlineMarkdown("a **bold _both_** `code` ~~gone~~ [site](https://x.dev) [Roadmap](leaf://page/abc-1)")).toEqual([
      { text: "a " },
      { text: "bold ", marks: { bold: true } },
      { text: "both", marks: { bold: true, italic: true } },
      { text: " " },
      { text: "code", marks: { code: true } },
      { text: " " },
      { text: "gone", marks: { strike: true } },
      { text: " " },
      { text: "site", marks: { link: "https://x.dev" } },
      { text: " " },
      { text: "Roadmap", mention: { type: "page", id: "abc-1" } },
    ]);
  });

  it("parses block structure with nesting", () => {
    const blocks = markdownToBlocks(
      ["# Launch", "", "Intro line one", "continues here.", "  A child note", "", "- one", "  - nested", "- [x] done", "1. first", "> quote", "> 💡 tip", "```ts", "const a = 1;", "```", "---"].join("\n"),
    );
    expect(blocks.map((b) => b.type)).toEqual(["heading_1", "paragraph", "bulleted_list_item", "to_do", "numbered_list_item", "quote", "callout", "code", "divider"]);
    expect(blocks[1]!.properties!.rich_text).toEqual([{ text: "Intro line one continues here." }]);
    expect(blocks[1]!.children![0]!.properties!.rich_text).toEqual([{ text: "A child note" }]);
    expect(blocks[2]!.children![0]!.type).toBe("bulleted_list_item");
    expect(blocks[3]!.properties!.checked).toBe(true);
    expect(blocks[6]!.properties).toEqual({ icon: "💡", rich_text: [{ text: "tip" }] });
    expect(blocks[7]!.properties).toEqual({ language: "ts", rich_text: [{ text: "const a = 1;" }] });
  });
});
