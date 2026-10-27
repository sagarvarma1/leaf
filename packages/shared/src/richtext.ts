import type { Marks, RichText, RichTextRun } from "./types.js";


const sameMarks = (a?: Marks, b?: Marks) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

/** Merge adjacent runs with identical marks so derived rich text is stable. */
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
