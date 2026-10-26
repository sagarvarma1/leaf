import { describe, expect, it } from "vitest";
import { applyDatabaseOp, applyView, defaultDatabase, groupRows, normalizeValue, pageToMarkdown, type Block, type RowLike } from "../src/index.js";

const db0 = () => {
  let { db } = applyDatabaseOp(defaultDatabase("Tasks"), [], { op: "addProperty", id: "pts", name: "Points", type: "number" });
  ({ db } = applyDatabaseOp(db, [], { op: "addProperty", id: "tags", name: "Tags", type: "multi_select", options: [{ id: "a", name: "A", color: "red" }] }));
  ({ db } = applyDatabaseOp(db, [], { op: "addProperty", id: "done", name: "Done", type: "checkbox" }));
  return db;
};
const row = (id: string, title: string, values: Record<string, any>): RowLike => ({ id, properties: { title, values } });
const rows = [
  row("1", "Write spec", { status: "doing", pts: 3, tags: ["a"], done: false }),
  row("2", "Ship it", { status: "done", pts: 8, done: true }),
  row("3", "Plan", { pts: 1 }),
];

describe("database operations", () => {
  it("adds, renames, retypes and deletes properties", () => {
    let db = db0();
    expect(db.order).toEqual(["title", "status", "pts", "tags", "done"]);
    ({ db } = applyDatabaseOp(db, [], { op: "updateProperty", id: "pts", name: "Estimate" }));
    expect(db.schema.pts!.name).toBe("Estimate");
    ({ db } = applyDatabaseOp(db, [], { op: "upsertView", view: { ...db.views[0]!, sorts: [{ property: "pts", direction: "ascending" }] } }));
    ({ db } = applyDatabaseOp(db, [], { op: "deleteProperty", id: "pts" }));
    expect(db.schema.pts).toBeUndefined();
    expect(db.views[0]!.sorts).toEqual([]);
    expect(() => applyDatabaseOp(db, [], { op: "deleteProperty", id: "title" })).toThrow();
  });

  it("moves rows", () => {
    const { rows: r } = applyDatabaseOp(db0(), ["a", "b", "c"], { op: "moveRow", rowId: "c", beforeId: "a" });
    expect(r).toEqual(["c", "a", "b"]);
    expect(applyDatabaseOp(db0(), ["a", "b", "c"], { op: "moveRow", rowId: "a", beforeId: null }).rows).toEqual(["b", "c", "a"]);
  });

  it("normalizes values by type", () => {
    const db = db0();
    expect(normalizeValue(db.schema.pts!, "1,200")).toBe(1200);
    expect(normalizeValue(db.schema.pts!, "abc")).toBeNull();
    expect(normalizeValue(db.schema.done!, "true")).toBe(true);
    expect(normalizeValue(db.schema.tags!, "a")).toEqual(["a"]);
    expect(normalizeValue({ id: "d", name: "D", type: "date" }, "2026-10-22T10:00")).toBe("2026-10-22");
  });

  it("filters and sorts views (empties last, stable)", () => {
    const db = db0();
    const view = { id: "v", name: "v", type: "table" as const, filters: [], sorts: [{ property: "pts", direction: "descending" as const }] };
    expect(applyView(db, view, rows).map((r) => r.id)).toEqual(["2", "1", "3"]);
    const f = { ...view, sorts: [], filters: [{ property: "title", operator: "contains" as const, value: "s" }] };
    expect(applyView(db, f, rows).map((r) => r.id)).toEqual(["1", "2"]);
    const g = { ...view, sorts: [], filters: [{ property: "pts", operator: "gte" as const, value: 3 }] };
    expect(applyView(db, g, rows).map((r) => r.id)).toEqual(["1", "2"]);
    const h = { ...view, sorts: [], filters: [{ property: "status", operator: "is_empty" as const }] };
    expect(applyView(db, h, rows).map((r) => r.id)).toEqual(["3"]);
    const s = { ...view, sorts: [{ property: "status", direction: "ascending" as const }] };
    expect(applyView(db, s, rows).map((r) => r.id)).toEqual(["1", "2", "3"]);
  });

  it("groups rows for a board", () => {
    const db = db0();
    const groups = groupRows(db, db.views[1]!, rows);
    expect(groups.map((g) => [g.id, g.rows.map((r) => r.id)])).toEqual([
      ["__none", ["3"]],
      ["todo", []],
      ["doing", ["1"]],
      ["done", ["2"]],
    ]);
  });
});

describe("markdown export", () => {
  it("renders blocks", () => {
    const mk = (id: string, type: any, properties: any, content: string[] = []): Block => ({
      id, type, properties, content, workspace_id: "w", parent_id: null, page_id: "p", created_by: null, created_at: 0, last_edited_by: null, last_edited_at: 0, archived: false,
    });
    const blocks = [
      mk("p", "page", { title: "Doc", icon: "📄" }, ["a", "b", "c", "d"]),
      mk("a", "heading_1", { rich_text: [{ text: "Head" }] }),
      mk("b", "to_do", { rich_text: [{ text: "x", marks: { bold: true } }], checked: true }),
      mk("c", "code", { rich_text: [{ text: "let a" }], language: "js" }),
      mk("d", "numbered_list_item", { rich_text: [{ text: "one" }] }),
    ];
    const map = new Map(blocks.map((b) => [b.id, b]));
    const md = pageToMarkdown(blocks[0]!, { get: (id) => map.get(id) });
    expect(md).toContain("# 📄 Doc");
    expect(md).toContain("## Head");
    expect(md).toContain("- [x] **x**");
    expect(md).toContain("```js\nlet a\n```");
    expect(md).toContain("1. one");
  });
});
