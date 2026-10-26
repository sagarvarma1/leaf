import type { Marks, RichText, RichTextRun } from "./types.js";

/** y-prosemirror stores overlapping marks as `name--hash`; strip the hash. */
const markName = (attr: string) => /(.*)(--[a-zA-Z0-9+/=]{8})$/.exec(attr)?.[1] ?? attr;

/** Convert y-prosemirror text attributes (mark name -> mark attrs) into Leaf marks. */
export function attributesToMarks(attrs: Record<string, any> | undefined): Marks | undefined {
  if (!attrs) return undefined;
  const marks: Marks = {};
  for (const [raw, value] of Object.entries(attrs)) {
    const name = markName(raw);
    switch (name) {
      case "bold":
      case "italic":
      case "underline":
      case "strike":
      case "code":
        marks[name] = true;
        break;
      case "link":
        if (value?.href) marks.link = String(value.href);
        break;
      case "textStyle":
        if (value?.color) marks.color = String(value.color);
        break;
    }
  }
  return Object.keys(marks).length ? marks : undefined;
}

/** Convert Leaf marks into y-prosemirror text attributes. */
export function marksToAttributes(marks: Marks | undefined): Record<string, any> | undefined {
  if (!marks) return undefined;
  const attrs: Record<string, any> = {};
  if (marks.bold) attrs.bold = {};
  if (marks.italic) attrs.italic = {};
  if (marks.underline) attrs.underline = {};
  if (marks.strike) attrs.strike = {};
  if (marks.code) attrs.code = {};
  if (marks.link) attrs.link = { href: marks.link, target: "_blank", rel: "noopener noreferrer nofollow", class: null };
  if (marks.color) attrs.textStyle = { color: marks.color };
  return Object.keys(attrs).length ? attrs : undefined;
}

const sameMarks = (a?: Marks, b?: Marks) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

/** Merge adjacent runs with identical marks so projections are stable. */
export function normalizeRichText(runs: RichText): RichText {
  const out: RichText = [];
  for (const run of runs) {
    if (!run.mention && run.text === "") continue;
    const last = out[out.length - 1];
    if (last && !last.mention && !run.mention && sameMarks(last.marks, run.marks)) {
      last.text += run.text;
    } else {
      const copy: RichTextRun = { text: run.text };
      if (run.marks && Object.keys(run.marks).length) copy.marks = { ...run.marks };
      if (run.mention) copy.mention = { ...run.mention };
      out.push(copy);
    }
  }
  return out;
}

export const plainText = (runs: RichText | undefined): string => (runs ?? []).map((r) => r.text).join("");

export const rt = (text: string, marks?: Marks): RichText => (text ? [marks ? { text, marks } : { text }] : []);
