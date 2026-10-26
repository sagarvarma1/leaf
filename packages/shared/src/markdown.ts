import type { Block, RichText } from "./types.js";

export function richTextToMarkdown(runs: RichText | undefined, resolvePage?: (id: string) => string): string {
  return (runs ?? [])
    .map((r) => {
      if (r.mention) {
        if (r.mention.type === "page") return `[${resolvePage?.(r.mention.id) ?? r.text}](leaf://page/${r.mention.id})`;
        return r.text;
      }
      let s = r.text;
      const m = r.marks ?? {};
      if (!s.trim()) return s;
      if (m.code) s = "`" + s + "`";
      if (m.bold) s = `**${s}**`;
      if (m.italic) s = `_${s}_`;
      if (m.strike) s = `~~${s}~~`;
      if (m.underline) s = `<u>${s}</u>`;
      if (m.link) s = `[${s}](${m.link})`;
      return s;
    })
    .join("");
}

export interface MarkdownSource {
  get(id: string): Block | undefined;
  /** Rendering for an inline database: rows as a table. */
  renderDatabase?(id: string): string;
}

/** Export a page (from the projected block table) to Markdown. */
export function pageToMarkdown(page: Block, src: MarkdownSource): string {
  const lines: string[] = [];
  const title = page.properties.title || "Untitled";
  lines.push(`# ${page.properties.icon ? page.properties.icon + " " : ""}${title}`, "");
  const resolve = (id: string) => src.get(id)?.properties.title ?? "Untitled";

  const render = (ids: string[], depth: number) => {
    const indent = "  ".repeat(depth);
    let n = 0;
    let prevList = false;
    for (const id of ids) {
      const b = src.get(id);
      if (!b || b.archived) continue;
      const isList = b.type === "bulleted_list_item" || b.type === "numbered_list_item" || b.type === "to_do";
      if (prevList && !isList && depth === 0) lines.push("");
      prevList = isList;
      const text = richTextToMarkdown(b.properties.rich_text, resolve);
      if (b.type !== "numbered_list_item") n = 0;
      switch (b.type) {
        case "paragraph":
          lines.push(indent + text, "");
          break;
        case "heading_1":
          lines.push(`${indent}## ${text}`, "");
          break;
        case "heading_2":
          lines.push(`${indent}### ${text}`, "");
          break;
        case "heading_3":
          lines.push(`${indent}#### ${text}`, "");
          break;
        case "bulleted_list_item":
          lines.push(`${indent}- ${text}`);
          render(b.content, depth + 1);
          break;
        case "numbered_list_item":
          lines.push(`${indent}${++n}. ${text}`);
          render(b.content, depth + 1);
          break;
        case "to_do":
          lines.push(`${indent}- [${b.properties.checked ? "x" : " "}] ${text}`);
          render(b.content, depth + 1);
          break;
        case "toggle":
          lines.push(`${indent}<details><summary>${text}</summary>`, "");
          render(b.content, depth);
          lines.push(`${indent}</details>`, "");
          break;
        case "quote":
          lines.push(`${indent}> ${text}`);
          render(b.content, depth);
          lines.push("");
          break;
        case "callout":
          lines.push(`${indent}> ${b.properties.icon ?? "💡"} ${text}`, "");
          break;
        case "code":
          lines.push(`${indent}\`\`\`${b.properties.language === "plain" ? "" : b.properties.language ?? ""}`);
          for (const l of (b.properties.rich_text?.[0]?.text ?? "").split("\n")) lines.push(indent + l);
          lines.push(`${indent}\`\`\``, "");
          break;
        case "divider":
          lines.push(`${indent}---`, "");
          break;
        case "image":
          lines.push(`${indent}![${b.properties.caption ?? ""}](${b.properties.url})`, "");
          break;
        case "link_to_page":
          lines.push(`${indent}[↗ ${resolve(b.properties.page_id)}](leaf://page/${b.properties.page_id})`, "");
          break;
        case "page":
          lines.push(`${indent}[📄 ${b.properties.title || "Untitled"}](leaf://page/${b.id})`, "");
          break;
        case "database":
          lines.push(src.renderDatabase?.(b.id) ?? `${indent}_Database: ${b.properties.title}_`, "");
          break;
        case "column_list":
          // Markdown has no columns: render them one after another.
          for (const col of b.content) render(src.get(col)?.content ?? [], depth);
          break;
        case "synced_block": {
          const source = b.properties.synced_from ? src.get(b.properties.synced_from) : b;
          render(source?.content ?? [], depth);
          break;
        }
      }
      // Children of a text block (paragraph, heading, callout) are indented under it.
      if ((b.type === "paragraph" || b.type.startsWith("heading_") || b.type === "callout") && b.content.length) {
        render(b.content, depth + 1);
      }
    }
  };
  render(page.content, 0);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
