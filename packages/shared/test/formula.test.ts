import { describe, expect, it } from "vitest";
import {
  applyDatabaseOp,
  applyView,
  computedCell,
  defaultDatabase,
  evaluateFormula,
  FormulaError,
  parseFormula,
  renameFormulaProp,
  type DatabaseProperties,
  type RowLike,
  type ValueContext,
} from "../src/index.js";

const ev = (src: string, props: Record<string, any> = {}, now = new Date(2026, 9, 25)) =>
  evaluateFormula(parseFormula(src), (n) => {
    if (!(n in props)) throw new FormulaError(`No property named "${n}"`);
    return props[n];
  }, now);

describe("formula language", () => {
  it("arithmetic with precedence, unary minus, power and modulo", () => {
    expect(ev("1 + 2 * 3")).toBe(7);
    expect(ev("(1 + 2) * 3")).toBe(9);
    expect(ev("2 ^ 3 ^ 2")).toBe(512);
    expect(ev("-4 + 10 % 4")).toBe(-2);
    expect(ev("round(10 / 3, 2)")).toBe(3.33);
  });

  it("strings, comparisons, logic and if()", () => {
    expect(ev('"a" + 1 + 2')).toBe("a12");
    expect(ev('concat("Hi ", upper("bob"))')).toBe("Hi BOB");
    expect(ev("3 > 2 and not (1 == 2)")).toBe(true);
    expect(ev('if(prop("Points") >= 5, "big", "small")', { Points: 8 })).toBe("big");
    expect(ev('contains(prop("Tags"), "Sync")', { Tags: ["Editor", "Sync"] })).toBe(true);
    expect(ev('length("leaf")')).toBe(4);
    expect(ev("empty(prop(\"X\"))", { X: null })).toBe(true);
  });

  it("dates", () => {
    const due = new Date(2026, 10, 6);
    expect(ev('dateBetween(prop("Due"), today(), "days")', { Due: due })).toBe(12);
    expect(ev('formatDate(dateAdd(prop("Due"), 1, "months"))', { Due: due })).toBe("Dec 6, 2026");
    expect(ev('prop("Due") - today()', { Due: due })).toBe(12);
    expect(ev('year(prop("Due"))', { Due: due })).toBe(2026);
  });

  it("reports errors instead of throwing arbitrary exceptions", () => {
    expect(() => parseFormula("1 +")).toThrow(FormulaError);
    expect(() => parseFormula("foo(1)")).toThrow(/Unknown function/);
    expect(() => parseFormula('"open')).toThrow(/Unclosed/);
    expect(() => ev("1 / 0")).toThrow(/Division by zero/);
    expect(() => ev('prop("Nope")')).toThrow(/No property named/);
    expect(() => ev('"x" * 2')).toThrow(/Expected a number/);
  });

  it("is not eval: identifiers can't reach JavaScript", () => {
    expect(() => parseFormula("constructor")).toThrow(FormulaError);
    expect(() => parseFormula('globalThis.process')).toThrow(FormulaError);
  });

  it("rewrites prop() references when a property is renamed", () => {
    expect(renameFormulaProp('prop("Points") * 2 + prop( "Points" )', "Points", "Story points")).toBe('prop("Story points") * 2 + prop("Story points")');
  });
});

describe("relations, rollups and computed properties", () => {
  // Projects <-> Tasks, two databases linked by a relation.
  const tasksDb: DatabaseProperties = defaultDatabase("Tasks");
  tasksDb.schema.points = { id: "points", name: "Points", type: "number" };
  tasksDb.schema.done = { id: "done", name: "Done", type: "checkbox" };
  tasksDb.schema.due = { id: "due", name: "Due", type: "date" };
  const projectsDb: DatabaseProperties = defaultDatabase("Projects");
  projectsDb.schema.tasks = { id: "tasks", name: "Tasks", type: "relation", relation: { databaseId: "tasksDb" } };
  projectsDb.schema.total = { id: "total", name: "Total points", type: "rollup", rollup: { relationPropertyId: "tasks", targetPropertyId: "points", function: "sum" } };
  projectsDb.schema.progress = { id: "progress", name: "Progress", type: "rollup", rollup: { relationPropertyId: "tasks", targetPropertyId: "done", function: "percent_checked" } };
  projectsDb.schema.last = { id: "last", name: "Last due", type: "rollup", rollup: { relationPropertyId: "tasks", targetPropertyId: "due", function: "latest_date" } };
  projectsDb.schema.label = { id: "label", name: "Label", type: "formula", formula: { expression: 'prop("Name") + ": " + prop("Total points") + " pts, " + prop("Progress") + "% done"' } };
  projectsDb.schema.loop = { id: "loop", name: "Loop", type: "formula", formula: { expression: 'prop("Loop") + 1' } };

  const row = (id: string, title: string, values: Record<string, any>): RowLike => ({ id, properties: { title, values }, created_at: Date.UTC(2026, 0, 1) });
  const tasks = [row("t1", "Design", { points: 3, done: true, due: "2026-11-01" }), row("t2", "Build", { points: 5, done: false, due: "2026-11-20" }), { ...row("t3", "Trashed", { points: 100 }), archived: true }];
  const projects = [row("p1", "Editor", { tasks: ["t1", "t2", "t3"] }), row("p2", "Empty", { tasks: [] })];
  const rows = new Map([...tasks, ...projects].map((r) => [r.id, r]));
  const ctx: ValueContext = { row: (id) => rows.get(id), database: (id) => (id === "tasksDb" ? tasksDb : projectsDb) };

  it("rolls up related rows, skipping deleted ones", () => {
    expect(computedCell(projects[0]!, projectsDb.schema.total!, projectsDb, ctx).value).toBe(8);
    expect(computedCell(projects[0]!, projectsDb.schema.progress!, projectsDb, ctx).value).toBe(50);
    expect((computedCell(projects[0]!, projectsDb.schema.last!, projectsDb, ctx).value as Date).getDate()).toBe(20);
    expect(computedCell(projects[1]!, projectsDb.schema.total!, projectsDb, ctx).value).toBe(0);
  });

  it("formulas read rollups and titles; cycles are reported", () => {
    expect(computedCell(projects[0]!, projectsDb.schema.label!, projectsDb, ctx).value).toBe("Editor: 8 pts, 50% done");
    expect(computedCell(projects[0]!, projectsDb.schema.loop!, projectsDb, ctx).error).toBe("Circular reference");
  });

  it("views filter and sort on computed values and relations", () => {
    const view = { id: "v", name: "V", type: "table" as const, sorts: [{ property: "total", direction: "descending" as const }], filters: [{ property: "label", operator: "contains" as const, value: "pts" }] };
    expect(applyView(projectsDb, view, projects, ctx).map((r) => r.id)).toEqual(["p1", "p2"]);
    const linked = { ...view, sorts: [], filters: [{ property: "tasks", operator: "contains" as const, value: "t2" }] };
    expect(applyView(projectsDb, linked, projects, ctx).map((r) => r.id)).toEqual(["p1"]);
  });

  it("renaming a property rewrites formulas that use it; bad formulas are rejected", () => {
    const { db } = applyDatabaseOp(projectsDb, [], { op: "updateProperty", id: "total", name: "Sum" });
    expect(db.schema.label!.formula!.expression).toContain('prop("Sum")');
    expect(() => applyDatabaseOp(projectsDb, [], { op: "addProperty", name: "Bad", type: "formula", formula: { expression: "1 +" } })).toThrow(/Formula/);
  });
});
