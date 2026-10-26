/**
 * Markdown -> blocks. The inverse direction of markdown.ts, used by the AI agent (which
 * writes Markdown) and anywhere text needs to become real blocks.
 *
 * Blocks: # / ## / ### headings, - / * bullets, 1. numbered, - [ ] / - [x] to-dos
 * (nested by indentation), > quotes, "> 💡 text" callouts, ``` fenced code, ---
 * dividers, paragraphs (indented lines under a paragraph become its children).
 * Inline: **bold**, *italic* / _italic_, ~~strike~~, `code`, [text](url), and
 * [title](leaf://page/<id>) page mentions.
 */
import { normalizeRichText } from "./richtext.js";
import type { BlockInput, Marks, RichText } from "./types.js";

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/;

export function inlineMarkdown(src: string, marks: Marks = {}): RichText {
  const out: RichText = [];
  let rest = src;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(withMarks(rest, marks));
      break;
    }
    if (m.index > 0) out.push(withMarks(rest.slice(0, m.index), marks));
    const tok = m[0];
    if (tok.startsWith("**") || tok.startsWith("__")) out.push(...inlineMarkdown(tok.slice(2, -2), { ...marks, bold: true }));
    else if (tok.startsWith("~~")) out.push(...inlineMarkdown(tok.slice(2, -2), { ...marks, strike: true }));
    else if (tok.startsWith("`")) out.push(withMarks(tok.slice(1, -1), { ...marks, code: true }));
    else if (tok.startsWith("[")) {
      const [, text, href] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      const page = /^leaf:\/\/page\/([\w-]+)/.exec(href!);
      if (page) out.push({ text: text!, mention: { type: "page", id: page[1]! } });
      else out.push(...inlineMarkdown(text!, { ...marks, link: href! }));
    } else out.push(...inlineMarkdown(tok.slice(1, -1), { ...marks, italic: true }));
    rest = rest.slice(m.index + tok.length);
  }
  return normalizeRichText(out);
}

const withMarks = (text: string, marks: Marks) => (Object.keys(marks).length ? { text, marks: { ...marks } } : { text });

const LIST = /^(\s*)(?:([-*+])\s+(\[[ xX]\]\s+)?|(\d+)[.)]\s+)(.*)$/;
const CALLOUT_ICON = /^(\p{Extended_Pictographic}️?)\s+(.*)$/u;

export function markdownToBlocks(md: string): BlockInput[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const root: BlockInput[] = [];
  // Open list items by indentation, so deeper items nest under shallower ones.
  let stack: Array<{ indent: number; block: BlockInput }> = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) root.push({ type: "paragraph", properties: { rich_text: inlineMarkdown(para.join(" ")) } });
    para = [];
  };
  const push = (b: BlockInput) => {
    flushPara();
    stack = [];
    root.push(b);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) {
      flushPara();
      stack = [];
      continue;
    }
    if (trimmed.startsWith("```")) {
      const language = trimmed.slice(3).trim() || "plain";
      const code: string[] = [];
      while (++i < lines.length && !lines[i]!.trim().startsWith("```")) code.push(lines[i]!);
      push({ type: "code", properties: { language, rich_text: code.length ? [{ text: code.join("\n") }] : [] } });
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      push({ type: "divider" });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (h) {
      const level = Math.min(3, h[1]!.length);
      push({ type: `heading_${level}` as BlockInput["type"], properties: { rich_text: inlineMarkdown(h[2]!) } });
      continue;
    }
    if (trimmed.startsWith(">")) {
      const text = trimmed.replace(/^>\s?/, "");
      const callout = CALLOUT_ICON.exec(text);
      if (callout) push({ type: "callout", properties: { icon: callout[1], rich_text: inlineMarkdown(callout[2]!) } });
      else push({ type: "quote", properties: { rich_text: inlineMarkdown(text) } });
      continue;
    }
    const li = LIST.exec(line);
    if (li) {
      flushPara();
      const indent = li[1]!.replace(/\t/g, "  ").length;
      const block: BlockInput = li[4]
        ? { type: "numbered_list_item", properties: { rich_text: inlineMarkdown(li[5]!) } }
        : li[3]
          ? { type: "to_do", properties: { rich_text: inlineMarkdown(li[5]!), checked: /x/i.test(li[3]) } }
          : { type: "bulleted_list_item", properties: { rich_text: inlineMarkdown(li[5]!) } };
      while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
      const parent = stack[stack.length - 1];
      if (parent) (parent.block.children ??= []).push(block);
      else root.push(block);
      stack.push({ indent, block });
      continue;
    }
    // An indented line right under a paragraph is that paragraph's child.
    if (/^\s{2,}/.test(line) && (para.length || root[root.length - 1]?.type === "paragraph")) {
      flushPara();
      const prev = root[root.length - 1]!;
      (prev.children ??= []).push({ type: "paragraph", properties: { rich_text: inlineMarkdown(trimmed) } });
      continue;
    }
    stack = [];
    para.push(trimmed);
  }
  flushPara();
  return root;
}
