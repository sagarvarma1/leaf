"use client";
/**
 * Database plumbing shared by the views: server-ordered operations, optimistic cell
 * writes, and the context computed properties (rollups, formulas) evaluate against.
 */
import type { Block, DatabaseOp, DatabaseProperties, FilterOperator, PropertyType, ValueContext } from "@leaf/shared";
import { useMemo } from "react";
import { api } from "@/lib/api";
import { upsertBlocks, useWorkspace } from "@/lib/store";

export const TYPE_LABEL: Record<PropertyType, string> = {
  title: "Title",
  text: "Text",
  number: "Number",
  select: "Select",
  multi_select: "Multi-select",
  date: "Date",
  checkbox: "Checkbox",
  person: "Person",
  relation: "Relation",
  rollup: "Rollup",
  formula: "Formula",
  created_time: "Created time",
  last_edited_time: "Last edited time",
  created_by: "Created by",
  last_edited_by: "Last edited by",
};

export const TYPE_ICON: Record<PropertyType, string> = {
  title: "Aa",
  text: "≡",
  number: "#",
  select: "◉",
  multi_select: "☰",
  date: "📅",
  checkbox: "☑",
  person: "👤",
  relation: "↗",
  rollup: "⌕",
  formula: "Σ",
  created_time: "◷",
  last_edited_time: "◶",
  created_by: "☺",
  last_edited_by: "☻",
};

const TEXT_OPS: FilterOperator[] = ["contains", "not_contains", "equals", "not_equals", "is_empty", "is_not_empty"];
const COMPUTED_OPS: FilterOperator[] = ["contains", "not_contains", "equals", "not_equals", "gt", "lt", "is_empty", "is_not_empty"];

export const OPERATORS: Record<PropertyType, FilterOperator[]> = {
  title: TEXT_OPS,
  text: TEXT_OPS,
  number: ["equals", "not_equals", "gt", "lt", "gte", "lte", "is_empty", "is_not_empty"],
  select: ["equals", "not_equals", "is_empty", "is_not_empty"],
  person: ["equals", "not_equals", "is_empty", "is_not_empty"],
  multi_select: ["contains", "not_contains", "is_empty", "is_not_empty"],
  relation: ["contains", "not_contains", "is_empty", "is_not_empty"],
  date: ["equals", "before", "after", "is_empty", "is_not_empty"],
  checkbox: ["equals"],
  rollup: COMPUTED_OPS,
  formula: COMPUTED_OPS,
  created_time: ["equals", "before", "after"],
  last_edited_time: ["equals", "before", "after"],
  created_by: TEXT_OPS,
  last_edited_by: TEXT_OPS,
};

export const navigate = (id: string) => window.dispatchEvent(new CustomEvent("leaf-navigate", { detail: id }));

export async function dbOp(id: string, op: DatabaseOp & { twoWay?: boolean }) {
  const r = await api<{ database: Block }>("POST", `/api/databases/${id}/ops`, op);
  upsertBlocks([r.database]);
  // A two-way relation also changed the other database: the event stream delivers it.
}

export async function setCell(row: Block, propId: string, value: any) {
  // Optimistic: patch locally, then let the server's answer win.
  if (propId === "title") upsertBlocks([{ ...row, properties: { ...row.properties, title: value }, last_edited_at: Date.now() }]);
  else upsertBlocks([{ ...row, properties: { ...row.properties, values: { ...row.properties.values, [propId]: value } }, last_edited_at: Date.now() }]);
  const r = await api<{ row: Block }>("PATCH", `/api/rows/${row.id}`, { values: { [propId]: value } });
  upsertBlocks([r.row]);
}

export async function newRow(dbId: string, values: Record<string, any> = {}) {
  const r = await api<{ row: Block }>("POST", `/api/databases/${dbId}/rows`, { title: "", values });
  upsertBlocks([r.row]);
  const db = await api<{ database: Block }>("GET", `/api/databases/${dbId}`);
  upsertBlocks([db.database]);
  return r.row;
}

/**
 * Computed properties read other rows (rollups), other databases and member names. The
 * workspace store already holds every row, so this is a view over it.
 */
export function useValueContext(): ValueContext {
  const blocks = useWorkspace((s) => s.blocks);
  const members = useWorkspace((s) => s.members);
  return useMemo(() => {
    const names = new Map(members.map((m) => [m.id, m.name]));
    return {
      row: (id) => blocks[id],
      database: (id) => (blocks[id]?.type === "database" ? (blocks[id]!.properties as DatabaseProperties) : undefined),
      userName: (id) => names.get(id),
    };
  }, [blocks, members]);
}
