/**
 * Pure database logic shared by server (applying operations) and client (rendering views).
 * Databases are structured data, so they do not use the CRDT: clients send small
 * operations, the server applies them in order inside a SQLite transaction and broadcasts
 * the result. Each cell is an independent last-writer-wins register.
 */
import { newId } from "./convert.js";
import { evaluateFormula, FormulaError, parseDay, parseFormula, renameFormulaProp, toText, type Ast, type FormulaValue } from "./formula.js";
import type {
  DatabaseProperties,
  DatabaseView,
  PropertyDef,
  PropertyType,
  RollupFunction,
  RowProperties,
  SelectOption,
  ViewFilter,
  ViewSort,
} from "./types.js";
import { COMPUTED_TYPES, OPTION_COLORS } from "./types.js";

export type DatabaseOp =
  | { op: "setTitle"; title: string }
  | ({ op: "addProperty"; id?: string; name: string; type: PropertyType; options?: SelectOption[] } & PropertyConfig)
  | ({ op: "updateProperty"; id: string; name?: string; type?: PropertyType } & PropertyConfig)
  | { op: "deleteProperty"; id: string }
  | { op: "addOption"; propertyId: string; option: SelectOption }
  | { op: "upsertView"; view: DatabaseView }
  | { op: "deleteView"; id: string }
  | { op: "moveRow"; rowId: string; beforeId: string | null };

/** Type-specific configuration carried by addProperty / updateProperty. */
export interface PropertyConfig {
  relation?: PropertyDef["relation"];
  rollup?: PropertyDef["rollup"];
  formula?: PropertyDef["formula"];
}

export class DatabaseOpError extends Error {}

function applyConfig(def: PropertyDef, op: PropertyConfig) {
  if (op.formula !== undefined) {
    try {
      parseFormula(op.formula.expression);
    } catch (e) {
      if (e instanceof FormulaError) throw new DatabaseOpError(`Formula: ${e.message}`);
      throw e;
    }
    def.formula = { expression: String(op.formula.expression) };
  }
  if (op.rollup !== undefined) def.rollup = { ...op.rollup };
  if (op.relation !== undefined) def.relation = { databaseId: op.relation.databaseId, syncedPropertyId: op.relation.syncedPropertyId ?? null };
  // Drop configuration that no longer matches the type.
  if (def.type !== "formula") delete def.formula;
  if (def.type !== "rollup") delete def.rollup;
  if (def.type !== "relation") delete def.relation;
  if (def.type === "relation" && !def.relation?.databaseId) throw new DatabaseOpError("A relation needs a database");
  if (def.type === "formula" && !def.formula) def.formula = { expression: "" };
}

export function defaultDatabase(title = "Untitled database"): DatabaseProperties {
  const status: PropertyDef = {
    id: "status",
    name: "Status",
    type: "select",
    options: [
      { id: "todo", name: "Not started", color: "gray" },
      { id: "doing", name: "In progress", color: "blue" },
      { id: "done", name: "Done", color: "green" },
    ],
  };
  return {
    title,
    schema: { title: { id: "title", name: "Name", type: "title" }, status },
    order: ["title", "status"],
    views: [
      { id: "table", name: "Table", type: "table", sorts: [], filters: [] },
      { id: "board", name: "Board", type: "board", sorts: [], filters: [], groupBy: "status" },
    ],
  };
}

/** Apply one operation. Returns new database properties and the (possibly reordered) rows. */
export function applyDatabaseOp(
  db: DatabaseProperties,
  rows: string[],
  op: DatabaseOp,
): { db: DatabaseProperties; rows: string[] } {
  const next: DatabaseProperties = structuredClone(db);
  let order = [...rows];
  switch (op.op) {
    case "setTitle":
      next.title = String(op.title);
      break;
    case "addProperty": {
      const id = op.id ?? newId().slice(0, 8);
      if (next.schema[id]) throw new DatabaseOpError(`property ${id} exists`);
      const def: PropertyDef = { id, name: op.name || "Property", type: op.type };
      if (op.type === "select" || op.type === "multi_select") def.options = op.options ?? [];
      applyConfig(def, op);
      next.schema[id] = def;
      next.order.push(id);
      break;
    }
    case "updateProperty": {
      const def = next.schema[op.id];
      if (!def) throw new DatabaseOpError("no such property");
      if (op.name !== undefined && op.name !== def.name) {
        // Formulas refer to properties by name: keep them pointing at the renamed one.
        for (const other of Object.values(next.schema)) {
          if (other.formula) other.formula.expression = renameFormulaProp(other.formula.expression, def.name, op.name);
        }
        def.name = op.name;
      }
      if (op.type && def.type !== "title") {
        if (op.type === "title") throw new DatabaseOpError("only one title property");
        def.type = op.type;
        if ((op.type === "select" || op.type === "multi_select") && !def.options) def.options = [];
      }
      applyConfig(def, op);
      break;
    }
    case "deleteProperty": {
      if (op.id === "title") throw new DatabaseOpError("cannot delete the title property");
      delete next.schema[op.id];
      next.order = next.order.filter((p) => p !== op.id);
      for (const v of next.views) {
        v.sorts = v.sorts.filter((s) => s.property !== op.id);
        v.filters = v.filters.filter((f) => f.property !== op.id);
        if (v.groupBy === op.id) delete v.groupBy;
      }
      break;
    }
    case "addOption": {
      const def = next.schema[op.propertyId];
      if (!def || (def.type !== "select" && def.type !== "multi_select")) throw new DatabaseOpError("not a select");
      def.options = def.options ?? [];
      if (!def.options.some((o) => o.id === op.option.id || o.name === op.option.name)) def.options.push(op.option);
      break;
    }
    case "upsertView": {
      const idx = next.views.findIndex((v) => v.id === op.view.id);
      const view = { ...op.view, sorts: op.view.sorts ?? [], filters: op.view.filters ?? [] };
      if (idx >= 0) next.views[idx] = view;
      else next.views.push(view);
      break;
    }
    case "deleteView":
      if (next.views.length <= 1) throw new DatabaseOpError("a database needs one view");
      next.views = next.views.filter((v) => v.id !== op.id);
      break;
    case "moveRow": {
      if (!order.includes(op.rowId)) throw new DatabaseOpError("no such row");
      order = order.filter((r) => r !== op.rowId);
      const at = op.beforeId ? order.indexOf(op.beforeId) : -1;
      if (at >= 0) order.splice(at, 0, op.rowId);
      else order.push(op.rowId);
      break;
    }
    default:
      throw new DatabaseOpError("unknown op");
  }
  return { db: next, rows: order };
}

/** Coerce a raw cell value into the canonical stored form for its property type. */
export function normalizeValue(def: PropertyDef, raw: any): any {
  if (raw === undefined || raw === null || raw === "") return null;
  switch (def.type) {
    case "title":
    case "text":
      return String(raw);
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    case "checkbox":
      return raw === true || raw === "true" || raw === 1;
    case "select":
      return String(raw);
    case "multi_select":
      return (Array.isArray(raw) ? raw : [raw]).map(String);
    case "date": {
      const s = String(raw);
      return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
    }
    case "person":
      return String(raw);
    case "relation":
      return [...new Set((Array.isArray(raw) ? raw : [raw]).map(String))];
    default:
      return null; // computed properties are never stored
  }
}

export const randomOptionColor = (seed: string) =>
  OPTION_COLORS[[...seed].reduce((a, c) => a + c.charCodeAt(0), 0) % OPTION_COLORS.length]!;

// ---------------------------------------------------------------- views

/** A database row: any page block (its properties hold `title` and `values`, see RowProperties). */
export interface RowLike {
  id: string;
  properties: RowProperties | Record<string, any>;
  parent_id?: string | null;
  created_at?: number;
  last_edited_at?: number;
  created_by?: string | null;
  last_edited_by?: string | null;
  archived?: boolean;
}

/** What computed properties need to look outside the row (related rows, people, now). */
export interface ValueContext {
  row(id: string): RowLike | undefined;
  database(id: string): DatabaseProperties | undefined;
  userName?(id: string): string | undefined;
  now?: Date;
}

const emptyContext: ValueContext = { row: () => undefined, database: () => undefined };

// ---------------------------------------------------------------- computed values

const astCache = new Map<string, Ast>();
function compiled(expression: string): Ast {
  let ast = astCache.get(expression);
  if (!ast) {
    ast = parseFormula(expression);
    if (astCache.size > 500) astCache.clear();
    astCache.set(expression, ast);
  }
  return ast;
}

const propByName = (db: DatabaseProperties, name: string) => Object.values(db.schema).find((d) => d.name === name);

/** Rows a relation cell points at, skipping deleted ones. */
export function relatedRows(row: RowLike, def: PropertyDef, ctx: ValueContext): RowLike[] {
  const ids: string[] = Array.isArray(row.properties.values?.[def.id]) ? row.properties.values[def.id] : [];
  return ids.map((id) => ctx.row(id)).filter((r): r is RowLike => !!r && !r.archived);
}

/**
 * Any property as a formula value: option names instead of ids, Date objects, related
 * rows' titles, and computed properties evaluated. `seen` guards against formulas and
 * rollups that refer back to themselves.
 */
export function formulaInput(row: RowLike, def: PropertyDef, db: DatabaseProperties, ctx: ValueContext, seen = new Set<string>()): FormulaValue {
  if (COMPUTED_TYPES.has(def.type)) return computeValue(row, def, db, ctx, seen);
  const v = cellValue(row, def.id);
  switch (def.type) {
    case "title":
    case "text":
      return v == null ? "" : String(v);
    case "number":
      return typeof v === "number" ? v : null;
    case "checkbox":
      return Boolean(v);
    case "select":
      return v ? optionName(def, v) : "";
    case "multi_select":
      return Array.isArray(v) ? v.map((id) => optionName(def, id)) : [];
    case "date":
      return typeof v === "string" && v ? parseDay(v) : null;
    case "person":
      return v ? (ctx.userName?.(v) ?? "") : "";
    case "relation":
      return relatedRows(row, def, ctx).map((r) => r.properties.title || "Untitled");
    default:
      return null;
  }
}

/** Value of a computed property (rollup, formula, created/edited time and by). Throws FormulaError. */
export function computeValue(row: RowLike, def: PropertyDef, db: DatabaseProperties, ctx: ValueContext, seen = new Set<string>()): FormulaValue {
  const key = `${row.id}:${def.id}`;
  if (seen.has(key)) throw new FormulaError("Circular reference");
  const inner = new Set(seen).add(key);
  switch (def.type) {
    case "created_time":
      return row.created_at ? new Date(row.created_at) : null;
    case "last_edited_time":
      return row.last_edited_at ? new Date(row.last_edited_at) : null;
    case "created_by":
      return row.created_by ? (ctx.userName?.(row.created_by) ?? "") : "";
    case "last_edited_by":
      return row.last_edited_by ? (ctx.userName?.(row.last_edited_by) ?? "") : "";
    case "formula": {
      const expr = def.formula?.expression?.trim();
      if (!expr) return null;
      return evaluateFormula(
        compiled(expr),
        (name) => {
          const target = propByName(db, name);
          if (!target) throw new FormulaError(`No property named "${name}"`);
          return formulaInput(row, target, db, ctx, inner);
        },
        ctx.now,
      );
    }
    case "rollup": {
      const cfg = def.rollup;
      const rel = cfg ? db.schema[cfg.relationPropertyId] : undefined;
      if (!cfg || !rel || rel.type !== "relation" || !rel.relation) throw new FormulaError("Pick a relation to roll up");
      const targetDb = ctx.database(rel.relation.databaseId);
      const target = targetDb?.schema[cfg.targetPropertyId];
      if (!targetDb || !target) throw new FormulaError("Pick a property to roll up");
      const rows = relatedRows(row, rel, ctx);
      const values = rows.map((r) => formulaInput(r, target, targetDb, ctx, inner));
      return aggregate(cfg.function, values, rows.length);
    }
    default:
      return null;
  }
}

function aggregate(fn: RollupFunction, values: FormulaValue[], rowCount: number): FormulaValue {
  const flat = values.flatMap((v) => (Array.isArray(v) ? v : [v]));
  const present = flat.filter((v) => v !== null && v !== "" && v !== false);
  const nums = flat.filter((v): v is number => typeof v === "number");
  const dates = flat.filter((v): v is Date => v instanceof Date).map((d) => d.getTime());
  switch (fn) {
    case "show_original":
      return flat;
    case "count":
      return rowCount;
    case "count_values":
      return present.length;
    case "count_unique":
      return new Set(present.map(toText)).size;
    case "count_checked":
      return values.filter((v) => v === true).length;
    case "percent_checked":
      return values.length ? Math.round((values.filter((v) => v === true).length / values.length) * 1000) / 10 : 0;
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "average":
      return nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : null;
    case "min":
      return nums.length ? Math.min(...nums) : null;
    case "max":
      return nums.length ? Math.max(...nums) : null;
    case "range":
      return nums.length ? Math.max(...nums) - Math.min(...nums) : null;
    case "earliest_date":
      return dates.length ? new Date(Math.min(...dates)) : null;
    case "latest_date":
      return dates.length ? new Date(Math.max(...dates)) : null;
  }
}

export const ROLLUP_FUNCTIONS: Array<{ id: RollupFunction; label: string }> = [
  { id: "show_original", label: "Show original" },
  { id: "count", label: "Count all" },
  { id: "count_values", label: "Count values" },
  { id: "count_unique", label: "Count unique values" },
  { id: "count_checked", label: "Checked" },
  { id: "percent_checked", label: "Percent checked" },
  { id: "sum", label: "Sum" },
  { id: "average", label: "Average" },
  { id: "min", label: "Min" },
  { id: "max", label: "Max" },
  { id: "range", label: "Range" },
  { id: "earliest_date", label: "Earliest date" },
  { id: "latest_date", label: "Latest date" },
];

/** A computed property's value, or the error to show in its cell. */
export function computedCell(row: RowLike, def: PropertyDef, db: DatabaseProperties, ctx: ValueContext): { value: FormulaValue; error?: string } {
  try {
    return { value: computeValue(row, def, db, ctx) };
  } catch (e) {
    if (e instanceof FormulaError) return { value: null, error: e.message };
    throw e;
  }
}

/** Format a computed value for display (and Markdown export). */
export function displayValue(def: PropertyDef, v: FormulaValue): string {
  if (def.type === "rollup" && def.rollup?.function === "percent_checked" && typeof v === "number") return `${v}%`;
  if (v instanceof Date && (def.type === "created_time" || def.type === "last_edited_time")) {
    return v.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  }
  if (typeof v === "boolean") return v ? "✓" : "";
  return toText(v);
}

export const cellValue = (row: RowLike, propId: string) =>
  propId === "title" ? row.properties.title : row.properties.values?.[propId];

const isEmpty = (v: any) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

function optionName(def: PropertyDef, id: any) {
  return def.options?.find((o) => o.id === id)?.name ?? String(id ?? "");
}

export function matchesFilter(row: RowLike, def: PropertyDef | undefined, f: ViewFilter, db?: DatabaseProperties, ctx: ValueContext = emptyContext): boolean {
  if (!def) return true;
  if (COMPUTED_TYPES.has(def.type)) return matchesComputed(computedFilterValue(row, def, db, ctx), f);
  const v = cellValue(row, f.property);
  switch (f.operator) {
    case "is_empty":
      return isEmpty(v) || (def.type === "checkbox" && !v);
    case "is_not_empty":
      return !isEmpty(v) && !(def.type === "checkbox" && !v);
  }
  if (f.value === undefined || f.value === null || f.value === "") return true; // incomplete filter
  switch (def.type) {
    case "title":
    case "text": {
      const s = String(v ?? "").toLowerCase();
      const q = String(f.value).toLowerCase();
      if (f.operator === "contains") return s.includes(q);
      if (f.operator === "not_contains") return !s.includes(q);
      if (f.operator === "equals") return s === q;
      if (f.operator === "not_equals") return s !== q;
      return true;
    }
    case "number": {
      if (typeof v !== "number") return false;
      const q = Number(f.value);
      return { equals: v === q, not_equals: v !== q, gt: v > q, lt: v < q, gte: v >= q, lte: v <= q }[
        f.operator as "equals"
      ] ?? true;
    }
    case "checkbox":
      return Boolean(v) === (f.value === true || f.value === "true");
    case "select":
    case "person":
      if (f.operator === "equals") return v === f.value;
      if (f.operator === "not_equals") return v !== f.value;
      return true;
    case "multi_select":
    case "relation": {
      const arr: string[] = Array.isArray(v) ? v : [];
      if (f.operator === "contains") return arr.includes(f.value);
      if (f.operator === "not_contains") return !arr.includes(f.value);
      return true;
    }
    case "date": {
      if (!v) return false;
      if (f.operator === "before") return v < f.value;
      if (f.operator === "after") return v > f.value;
      if (f.operator === "equals") return v === f.value;
      return true;
    }
  }
  return true;
}

function computedFilterValue(row: RowLike, def: PropertyDef, db: DatabaseProperties | undefined, ctx: ValueContext): FormulaValue {
  if (!db) return null;
  return computedCell(row, def, db, ctx).value;
}

/** Filters on computed properties act on the result's type. */
function matchesComputed(v: FormulaValue, f: ViewFilter): boolean {
  const empty = v === null || v === "" || (Array.isArray(v) && v.length === 0);
  if (f.operator === "is_empty") return empty;
  if (f.operator === "is_not_empty") return !empty;
  if (f.value === undefined || f.value === null || f.value === "") return true;
  if (typeof v === "boolean") return f.operator === "not_equals" ? v !== (f.value === true || f.value === "true") : v === (f.value === true || f.value === "true");
  if (typeof v === "number") {
    const q = Number(f.value);
    return { equals: v === q, not_equals: v !== q, gt: v > q, lt: v < q, gte: v >= q, lte: v <= q }[f.operator as "equals"] ?? true;
  }
  if (v instanceof Date) {
    const day = isoDay(v);
    if (f.operator === "before") return day < f.value;
    if (f.operator === "after") return day > f.value;
    if (f.operator === "equals") return day === f.value;
    return true;
  }
  const s = toText(v).toLowerCase();
  const q = String(f.value).toLowerCase();
  if (f.operator === "contains") return s.includes(q);
  if (f.operator === "not_contains") return !s.includes(q);
  if (f.operator === "equals") return s === q;
  if (f.operator === "not_equals") return s !== q;
  return true;
}

export const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function sortKey(def: PropertyDef, v: any): string | number {
  if (isEmpty(v)) return "";
  switch (def.type) {
    case "number":
      return v as number;
    case "checkbox":
      return v ? 1 : 0;
    case "select": {
      const idx = def.options?.findIndex((o) => o.id === v) ?? -1;
      return idx;
    }
    case "multi_select":
      return (v as string[]).map((id) => optionName(def, id)).join(",").toLowerCase();
    case "relation":
      return (v as string[]).length;
    default:
      return String(v).toLowerCase();
  }
}

function computedSortKey(v: FormulaValue): string | number {
  if (v === null || v === "" || (Array.isArray(v) && !v.length)) return "";
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  return toText(v).toLowerCase();
}

export function compareRows(a: RowLike, b: RowLike, def: PropertyDef, s: ViewSort, db?: DatabaseProperties, ctx: ValueContext = emptyContext): number {
  const computed = COMPUTED_TYPES.has(def.type);
  const ka = computed ? computedSortKey(computedFilterValue(a, def, db, ctx)) : sortKey(def, cellValue(a, s.property));
  const kb = computed ? computedSortKey(computedFilterValue(b, def, db, ctx)) : sortKey(def, cellValue(b, s.property));
  // Empty values always sort last, as in Notion.
  if (ka === "" && kb !== "") return 1;
  if (kb === "" && ka !== "") return -1;
  const c = ka < kb ? -1 : ka > kb ? 1 : 0;
  return s.direction === "descending" ? -c : c;
}

/** Filter (AND) then sort rows for a view. Stable: ties keep manual row order. */
export function applyView<R extends RowLike>(db: DatabaseProperties, view: DatabaseView, rows: R[], ctx: ValueContext = emptyContext): R[] {
  const filtered = rows.filter((r) => view.filters.every((f) => matchesFilter(r, db.schema[f.property], f, db, ctx)));
  if (!view.sorts.length) return filtered;
  const indexed = filtered.map((r, i) => ({ r, i }));
  indexed.sort((x, y) => {
    for (const s of view.sorts) {
      const def = db.schema[s.property];
      if (!def) continue;
      const c = compareRows(x.r, y.r, def, s, db, ctx);
      if (c) return c;
    }
    return x.i - y.i;
  });
  return indexed.map((x) => x.r);
}

/** Group rows for a board view. Rows with no value land in a "No <prop>" column. */
export function groupRows<R extends RowLike>(db: DatabaseProperties, view: DatabaseView, rows: R[]) {
  const def = view.groupBy ? db.schema[view.groupBy] : undefined;
  if (!def || def.type !== "select") return [{ id: "__none", name: "All", color: "gray", rows }];
  const groups = [
    { id: "__none", name: `No ${def.name}`, color: "gray", rows: [] as R[] },
    ...(def.options ?? []).map((o) => ({ id: o.id, name: o.name, color: o.color, rows: [] as R[] })),
  ];
  for (const r of rows) {
    const v = r.properties.values?.[def.id];
    (groups.find((g) => g.id === v) ?? groups[0]!).rows.push(r);
  }
  return groups;
}
