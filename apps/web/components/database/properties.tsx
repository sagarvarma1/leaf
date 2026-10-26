"use client";
/**
 * Relation, rollup and formula properties: their cells and their configuration.
 * Relations store row ids; rollups and formulas are computed in the browser from the
 * workspace store (shared logic in @leaf/shared), so they update live as related rows
 * change anywhere.
 */
import {
  computedCell,
  displayValue,
  evaluateFormula,
  FORMULA_FUNCTIONS,
  FormulaError,
  formulaInput,
  parseFormula,
  relatedRows,
  ROLLUP_FUNCTIONS,
  type Block,
  type DatabaseProperties,
  type PropertyDef,
  type PropertyType,
  type RollupFunction,
} from "@leaf/shared";
import { useMemo, useState } from "react";
import { databaseRows, isAlive, pageTitle, useWorkspace } from "@/lib/store";
import { Popover } from "../ui";
import { navigate, setCell, TYPE_ICON, useValueContext } from "./data";

export const CONFIGURED_TYPES = new Set<PropertyType>(["relation", "rollup", "formula"]);

// ---------------------------------------------------------------- cells

export function RelationCell({ row, def, readOnly }: { row: Block; def: PropertyDef; readOnly: boolean }) {
  const ctx = useValueContext();
  const [pop, setPop] = useState<HTMLElement | null>(null);
  const linked = relatedRows(row, def, ctx) as Block[];
  return (
    <>
      <div className="cell-tags relation-cell" data-testid={`cell-${def.id}`}>
        {linked.map((r) => (
          <button key={r.id} className="relation-chip" onClick={() => navigate(r.id)} title="Open">
            <span>{r.properties.icon || "📄"}</span> {pageTitle(r)}
          </button>
        ))}
        {!readOnly && (
          <button className="relation-add" onClick={(e) => setPop(e.currentTarget)} data-testid={`relate-${def.id}`} title="Link pages">
            +
          </button>
        )}
      </div>
      {pop && (
        <Popover anchor={pop} onClose={() => setPop(null)} className="db-pop" testId="relation-pop">
          <RelationPicker row={row} def={def} />
        </Popover>
      )}
    </>
  );
}

function RelationPicker({ row, def }: { row: Block; def: PropertyDef }) {
  const targetId = def.relation?.databaseId ?? "";
  const target = useWorkspace((s) => s.blocks[targetId]);
  const candidates = useWorkspace((s) => databaseRows(s, targetId));
  const [q, setQ] = useState("");
  const ids: string[] = Array.isArray(row.properties.values?.[def.id]) ? row.properties.values[def.id] : [];
  const shown = candidates
    .filter((r) => pageTitle(r).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => Number(ids.includes(b.id)) - Number(ids.includes(a.id)));
  const toggle = (id: string) => void setCell(row, def.id, ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  return (
    <div className="select-editor">
      <div className="menu-label">Link to {(target?.properties as DatabaseProperties | undefined)?.title ?? "database"}</div>
      <input className="input" autoFocus placeholder="Search pages" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="relation-list">
        {shown.map((r) => (
          <button key={r.id} className={`menu-item compact ${ids.includes(r.id) ? "active" : ""}`} onClick={() => toggle(r.id)} data-testid="relation-option">
            <span className="menu-icon small">{r.properties.icon || "📄"}</span>
            <span className="menu-title">{pageTitle(r)}</span>
            {ids.includes(r.id) && <span className="check">✓</span>}
          </button>
        ))}
        {!shown.length && <div className="muted small">No pages</div>}
      </div>
    </div>
  );
}

export function ComputedCell({ row, def, db }: { row: Block; def: PropertyDef; db: DatabaseProperties }) {
  const ctx = useValueContext();
  const { value, error } = computedCell(row, def, db, ctx);
  if (error) {
    return (
      <span className="cell-computed cell-error" title={error}>
        ⚠ {error}
      </span>
    );
  }
  return <span className={`cell-computed ${typeof value === "number" ? "num" : ""}`}>{displayValue(def, value)}</span>;
}

// ---------------------------------------------------------------- configuration

export type PropertyConfig = Pick<PropertyDef, "relation" | "rollup" | "formula"> & { twoWay?: boolean };

/** Configure a relation (target database), rollup (relation, property, function) or formula. */
export function PropertyConfigEditor({
  dbId,
  props,
  type,
  def,
  onSubmit,
}: {
  dbId: string;
  props: DatabaseProperties;
  type: PropertyType;
  def?: PropertyDef;
  onSubmit: (cfg: PropertyConfig) => void;
}) {
  if (type === "relation") return <RelationConfig dbId={dbId} def={def} onSubmit={onSubmit} />;
  if (type === "rollup") return <RollupConfig props={props} def={def} onSubmit={onSubmit} />;
  return <FormulaConfig dbId={dbId} props={props} def={def} onSubmit={onSubmit} />;
}

function RelationConfig({ dbId, def, onSubmit }: { dbId: string; def?: PropertyDef; onSubmit: (cfg: PropertyConfig) => void }) {
  const databases = useWorkspace((s) => Object.values(s.blocks).filter((b) => b.type === "database" && isAlive(s, b.id)));
  const [target, setTarget] = useState(def?.relation?.databaseId ?? dbId);
  const [twoWay, setTwoWay] = useState(true);
  if (def?.relation) {
    const name = (databases.find((d) => d.id === def.relation!.databaseId)?.properties as DatabaseProperties | undefined)?.title;
    return (
      <div className="config muted small">
        Links to <b>{name ?? "a deleted database"}</b>
        {def.relation.syncedPropertyId ? " · two-way" : " · one-way"}
      </div>
    );
  }
  return (
    <div className="config">
      <label className="config-row">
        <span>Related to</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)} data-testid="relation-target">
          {databases.map((d) => (
            <option key={d.id} value={d.id}>
              {(d.properties as DatabaseProperties).title || "Untitled"}
              {d.id === dbId ? " (this database)" : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="config-row check-row">
        <input type="checkbox" checked={twoWay} onChange={(e) => setTwoWay(e.target.checked)} />
        <span>Show on the related database too (two-way)</span>
      </label>
      <button className="btn primary small" data-testid="config-done" onClick={() => onSubmit({ relation: { databaseId: target }, twoWay })}>
        Add relation
      </button>
    </div>
  );
}

function RollupConfig({ props, def, onSubmit }: { props: DatabaseProperties; def?: PropertyDef; onSubmit: (cfg: PropertyConfig) => void }) {
  const relations = Object.values(props.schema).filter((d) => d.type === "relation");
  const [rel, setRel] = useState(def?.rollup?.relationPropertyId ?? relations[0]?.id ?? "");
  const targetDb = useWorkspace((s) => {
    const r = props.schema[rel]?.relation?.databaseId;
    return r ? (s.blocks[r]?.properties as DatabaseProperties | undefined) : undefined;
  });
  const targets = targetDb ? targetDb.order.map((id) => targetDb.schema[id]!).filter(Boolean) : [];
  const [prop, setProp] = useState(def?.rollup?.targetPropertyId ?? "");
  const [fn, setFn] = useState<RollupFunction>(def?.rollup?.function ?? "count");
  const chosen = targets.find((t) => t.id === prop) ?? targets[0];
  if (!relations.length) return <div className="config muted small">Add a Relation property first, then roll up a property of the related pages.</div>;
  return (
    <div className="config">
      <label className="config-row">
        <span>Relation</span>
        <select value={rel} onChange={(e) => setRel(e.target.value)} data-testid="rollup-relation">
          {relations.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <label className="config-row">
        <span>Property</span>
        <select value={chosen?.id ?? ""} onChange={(e) => setProp(e.target.value)} data-testid="rollup-property">
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {TYPE_ICON[t.type]} {t.name}
            </option>
          ))}
        </select>
      </label>
      <label className="config-row">
        <span>Calculate</span>
        <select value={fn} onChange={(e) => setFn(e.target.value as RollupFunction)} data-testid="rollup-function">
          {ROLLUP_FUNCTIONS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <button
        className="btn primary small"
        data-testid="config-done"
        disabled={!chosen}
        onClick={() => chosen && onSubmit({ rollup: { relationPropertyId: rel, targetPropertyId: chosen.id, function: fn } })}
      >
        {def ? "Save" : "Add rollup"}
      </button>
    </div>
  );
}

function FormulaConfig({ dbId, props, def, onSubmit }: { dbId: string; props: DatabaseProperties; def?: PropertyDef; onSubmit: (cfg: PropertyConfig) => void }) {
  const [expr, setExpr] = useState(def?.formula?.expression ?? "");
  const ctx = useValueContext();
  const first = useWorkspace((s) => databaseRows(s, dbId)[0]);
  // Live preview against the first row, with the same evaluator the cells use.
  const preview = useMemo(() => {
    if (!expr.trim()) return { text: "Type a formula", error: false };
    try {
      const ast = parseFormula(expr);
      if (!first) return { text: "Valid formula (no rows to preview)", error: false };
      const v = evaluateFormula(ast, (name) => {
        const p = Object.values(props.schema).find((d) => d.name === name);
        if (!p) throw new FormulaError(`No property named "${name}"`);
        if (def && p.id === def.id) throw new FormulaError("Circular reference");
        return formulaInput(first, p, props, ctx);
      });
      return { text: `${pageTitle(first)} → ${displayValue({ id: "", name: "", type: "formula" }, v) || "(empty)"}`, error: false };
    } catch (e) {
      return { text: e instanceof FormulaError ? e.message : "Invalid formula", error: true };
    }
  }, [expr, first, props, ctx, def]);
  const names = Object.values(props.schema).filter((d) => d.id !== def?.id);
  return (
    <div className="config formula-config">
      <textarea
        className="input formula-input"
        autoFocus
        rows={3}
        value={expr}
        placeholder='if(prop("Points") > 3, "Big", "Small")'
        onChange={(e) => setExpr(e.target.value)}
        data-testid="formula-input"
        spellCheck={false}
      />
      <div className={`formula-preview ${preview.error ? "error" : ""}`} data-testid="formula-preview">
        {preview.text}
      </div>
      <div className="formula-help">
        <div className="menu-label">Properties</div>
        <div className="formula-chips">
          {names.map((n) => (
            <button key={n.id} className="formula-chip" onClick={() => setExpr((x) => `${x}prop("${n.name}")`)}>
              {n.name}
            </button>
          ))}
        </div>
        <div className="menu-label">Functions</div>
        <div className="formula-fns">{FORMULA_FUNCTIONS.join(" · ")}</div>
      </div>
      <button className="btn primary small" data-testid="config-done" disabled={preview.error} onClick={() => onSubmit({ formula: { expression: expr } })}>
        {def ? "Save" : "Add formula"}
      </button>
    </div>
  );
}
