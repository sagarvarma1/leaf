"use client";
/**
 * Inline database: Table, Board, Calendar and Gallery views over rows that are pages.
 * Every change is a small server-ordered operation (schema op or cell write); the server
 * broadcasts the result to every collaborator through the workspace event stream.
 */
import {
  applyView,
  COMPUTED_TYPES,
  groupRows,
  PROPERTY_TYPES,
  randomOptionColor,
  type Block,
  type DatabaseProperties,
  type DatabaseView as View,
  type FilterOperator,
  type PropertyDef,
  type PropertyType,
  type RowLike,
  type ViewFilter,
  type ViewType,
} from "@leaf/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { databaseRows, getState, pageTitle, upsertBlocks, useBlock, useWorkspace, type User } from "@/lib/store";
import { Avatar, Icon, Popover } from "../ui";
import { dbOp, navigate, newRow, OPERATORS, setCell, TYPE_ICON, TYPE_LABEL, useValueContext } from "./data";
import { ComputedCell, CONFIGURED_TYPES, PropertyConfigEditor, RelationCell, type PropertyConfig } from "./properties";
import { CalendarView, CardProp, GalleryView } from "./views";

export { setCell } from "./data";

const OP_LABEL: Record<FilterOperator, string> = {
  contains: "contains",
  not_contains: "does not contain",
  equals: "is",
  not_equals: "is not",
  is_empty: "is empty",
  is_not_empty: "is not empty",
  gt: ">",
  lt: "<",
  gte: "≥",
  lte: "≤",
  before: "is before",
  after: "is after",
};

const VIEW_TYPES: Array<{ type: ViewType; label: string }> = [
  { type: "table", label: "Table" },
  { type: "board", label: "Board" },
  { type: "calendar", label: "Calendar" },
  { type: "gallery", label: "Gallery" },
];

export function DatabaseView({ id, readOnly }: { id: string; readOnly: boolean }) {
  const db = useBlock(id);
  const rowsAll = useWorkspace((s) => databaseRows(s, id));
  const rowsKey = rowsAll.map((r) => r.id + r.last_edited_at).join();
  const [missing, setMissing] = useState(false);
  const [viewId, setViewId] = useState<string | null>(() => (typeof window !== "undefined" ? localStorage.getItem(`leaf:view:${id}`) : null));
  const [pop, setPop] = useState<null | { kind: "filter" | "sort" | "addView"; el: HTMLElement }>(null);

  useEffect(() => {
    if (db) return;
    api<{ database: Block; rows: Block[] }>("GET", `/api/databases/${id}`)
      .then((r) => upsertBlocks([r.database, ...r.rows]))
      .catch(() => setMissing(true));
  }, [id, db]);

  const props = db?.properties as DatabaseProperties | undefined;
  const view = props?.views.find((v) => v.id === viewId) ?? props?.views[0];
  const ctx = useValueContext();
  // Rollups and formulas can depend on other databases' rows, so recompute with the context.
  const rows = useMemo(() => (props && view ? (applyView(props, view, rowsAll as RowLike[], ctx) as Block[]) : []), [props, view, rowsKey, ctx]); // eslint-disable-line react-hooks/exhaustive-deps

  if (missing) return <div className="db-missing">This database was deleted.</div>;
  if (!db || !props || !view) return <div className="db-loading">Loading database…</div>;
  if (db.archived) return <div className="db-missing">This database is in the trash.</div>;

  const pickView = (v: string) => {
    setViewId(v);
    localStorage.setItem(`leaf:view:${id}`, v);
  };
  const updateView = (patch: Partial<View>) => void dbOp(id, { op: "upsertView", view: { ...view, ...patch } });

  return (
    <div className="db" data-testid="database">
      <div className="db-head">
        <TitleInput value={props.title} readOnly={readOnly} onCommit={(t) => dbOp(id, { op: "setTitle", title: t })} className="db-title" />
      </div>
      <div className="db-bar">
        <div className="db-tabs">
          {props.views.map((v) => (
            <button key={v.id} className={`db-tab ${v.id === view.id ? "active" : ""}`} onClick={() => pickView(v.id)} data-testid={`view-${v.type}`}>
              <Icon name={v.type} size={14} /> {v.name}
            </button>
          ))}
          {!readOnly && (
            <button className="db-tab ghost" title="Add a view" onClick={(e) => setPop({ kind: "addView", el: e.currentTarget })}>
              <Icon name="plus" size={13} />
            </button>
          )}
        </div>
        <div className="db-actions">
          <button className={`db-action ${view.filters.length ? "on" : ""}`} onClick={(e) => setPop({ kind: "filter", el: e.currentTarget })} data-testid="db-filter">
            <Icon name="filter" size={14} /> Filter{view.filters.length ? ` (${view.filters.length})` : ""}
          </button>
          <button className={`db-action ${view.sorts.length ? "on" : ""}`} onClick={(e) => setPop({ kind: "sort", el: e.currentTarget })} data-testid="db-sort">
            <Icon name="sort" size={14} /> Sort{view.sorts.length ? ` (${view.sorts.length})` : ""}
          </button>
          {!readOnly && (
            <button className="btn primary small" onClick={() => void newRow(id).then((r) => setTimeout(() => (document.querySelector(`[data-row-title="${r.id}"]`) as HTMLInputElement | null)?.focus(), 50))} data-testid="db-new">
              New
            </button>
          )}
        </div>
      </div>
      {view.type === "board" ? (
        <BoardView db={db} props={props} view={view} rows={rows} readOnly={readOnly} onGroupBy={(g) => updateView({ groupBy: g })} />
      ) : view.type === "calendar" ? (
        <CalendarView db={db} props={props} view={view} rows={rows} readOnly={readOnly} onChange={updateView} />
      ) : view.type === "gallery" ? (
        <GalleryView db={db} props={props} view={view} rows={rows} readOnly={readOnly} onChange={updateView} />
      ) : (
        <TableView db={db} props={props} rows={rows} readOnly={readOnly} />
      )}
      {pop?.kind === "filter" && (
        <Popover anchor={pop.el} onClose={() => setPop(null)} placement="bottom-end" className="db-pop" testId="filter-pop">
          <FilterEditor props={props} view={view} readOnly={readOnly} onChange={(filters) => updateView({ filters })} />
        </Popover>
      )}
      {pop?.kind === "sort" && (
        <Popover anchor={pop.el} onClose={() => setPop(null)} placement="bottom-end" className="db-pop" testId="sort-pop">
          <SortEditor props={props} view={view} readOnly={readOnly} onChange={(sorts) => updateView({ sorts })} />
        </Popover>
      )}
      {pop?.kind === "addView" && (
        <Popover anchor={pop.el} onClose={() => setPop(null)} className="menu">
          {VIEW_TYPES.map(({ type: t, label }) => (
            <button
              key={t}
              className="menu-item compact"
              data-testid={`add-view-${t}`}
              onClick={() => {
                const v: View = { id: crypto.randomUUID().slice(0, 8), name: label, type: t, sorts: [], filters: [] };
                if (t === "board") v.groupBy = props.order.find((p) => props.schema[p]?.type === "select");
                if (t === "calendar") v.dateProperty = props.order.find((p) => props.schema[p]?.type === "date");
                if (t === "gallery") v.cardPreview = "cover";
                void dbOp(id, { op: "upsertView", view: v }).then(() => pickView(v.id));
                setPop(null);
              }}
            >
              <Icon name={t} size={14} /> <span className="menu-title">{label} view</span>
            </button>
          ))}
        </Popover>
      )}
    </div>
  );
}

function TitleInput({ value, onCommit, readOnly, className, placeholder = "Untitled", testId }: { value: string; onCommit: (v: string) => void; readOnly?: boolean; className?: string; placeholder?: string; testId?: string }) {
  const [v, setV] = useState(value);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setV(value);
  }, [value]);
  return (
    <input
      className={className}
      value={v}
      readOnly={readOnly}
      placeholder={placeholder}
      data-testid={testId}
      onFocus={() => (editing.current = true)}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        editing.current = false;
        if (v !== value) onCommit(v);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setV(value);
          editing.current = false;
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

// ---------------------------------------------------------------- table

function TableView({ db, props, rows, readOnly }: { db: Block; props: DatabaseProperties; rows: Block[]; readOnly: boolean }) {
  const [pop, setPop] = useState<null | { kind: "prop" | "add" | "config"; el: HTMLElement; prop?: PropertyDef; type?: PropertyType }>(null);
  const cols = props.order.map((p) => props.schema[p]).filter(Boolean) as PropertyDef[];
  const width = (c: PropertyDef) =>
    c.type === "title" ? 280 : c.type === "checkbox" ? 100 : c.type === "date" || c.type.endsWith("_time") ? 180 : c.type === "relation" || c.type === "formula" ? 220 : 160;
  const total = cols.reduce((n, c) => n + width(c), 0) + 44;
  return (
    <div className="table-scroll">
      <table className="db-table" data-testid="db-table" style={{ width: total }}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.id} style={{ width: width(c) }}>
                <button className="th-btn" disabled={readOnly} onClick={(e) => setPop({ kind: "prop", el: e.currentTarget, prop: c })}>
                  <span className="th-icon">{TYPE_ICON[c.type]}</span> {c.name}
                </button>
              </th>
            ))}
            <th className="th-add">
              {!readOnly && (
                <button className="th-btn" title="Add a property" onClick={(e) => setPop({ kind: "add", el: e.currentTarget })} data-testid="db-add-prop">
                  <Icon name="plus" size={14} />
                </button>
              )}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} data-testid="db-row">
              {cols.map((c) => (
                <td key={c.id} className={`cell cell-${c.type}`}>
                  <Cell row={r} def={c} readOnly={readOnly} />
                </td>
              ))}
              <td className="row-actions">
                {!readOnly && (
                  <button className="icon-btn" title="Delete row" onClick={() => void api("DELETE", `/api/pages/${r.id}`)}>
                    <Icon name="trash" size={13} />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!readOnly && (
        <button className="db-add-row" onClick={() => void newRow(db.id)}>
          <Icon name="plus" size={14} /> New
        </button>
      )}
      {!rows.length && <div className="db-empty">No rows match this view.</div>}
      {pop?.kind === "prop" && pop.prop && (
        <Popover anchor={pop.el} onClose={() => setPop(null)} className="db-pop" testId="prop-pop">
          <PropertyEditor dbId={db.id} props={props} def={pop.prop} onDone={() => setPop(null)} />
        </Popover>
      )}
      {pop?.kind === "config" && pop.type && (
        <Popover anchor={pop.el} onClose={() => setPop(null)} placement="bottom-end" className="db-pop wide" testId="config-pop">
          <div className="menu-label">
            {TYPE_ICON[pop.type]} New {TYPE_LABEL[pop.type].toLowerCase()} property
          </div>
          <PropertyConfigEditor
            dbId={db.id}
            props={props}
            type={pop.type}
            onSubmit={(cfg: PropertyConfig) => {
              const target = cfg.relation ? (getState().blocks[cfg.relation.databaseId]?.properties as DatabaseProperties | undefined) : undefined;
              const name = pop.type === "relation" ? target?.title || "Related" : TYPE_LABEL[pop.type!];
              void dbOp(db.id, { op: "addProperty", name, type: pop.type!, ...cfg });
              setPop(null);
            }}
          />
        </Popover>
      )}
      {pop?.kind === "add" && (
        <Popover anchor={pop.el} onClose={() => setPop(null)} placement="bottom-end" className="menu" testId="add-prop-pop">
          <div className="menu-label">Property type</div>
          {PROPERTY_TYPES.map((t) => (
            <button
              key={t}
              className="menu-item compact"
              data-testid={`add-prop-${t}`}
              onClick={() => {
                if (CONFIGURED_TYPES.has(t)) return setPop({ kind: "config", el: pop.el, type: t });
                void dbOp(db.id, { op: "addProperty", name: TYPE_LABEL[t], type: t });
                setPop(null);
              }}
            >
              <span className="menu-icon small">{TYPE_ICON[t]}</span> <span className="menu-title">{TYPE_LABEL[t]}</span>
            </button>
          ))}
        </Popover>
      )}
    </div>
  );
}

function PropertyEditor({ dbId, props, def, onDone }: { dbId: string; props: DatabaseProperties; def: PropertyDef; onDone: () => void }) {
  const [name, setName] = useState(def.name);
  // Switching to a type that needs configuration shows its editor before applying.
  const [pending, setPending] = useState<PropertyType | null>(null);
  if (pending) {
    return (
      <div className="prop-editor">
        <div className="menu-label">
          {TYPE_ICON[pending]} {def.name} → {TYPE_LABEL[pending]}
        </div>
        <PropertyConfigEditor dbId={dbId} props={props} type={pending} onSubmit={(cfg) => (void dbOp(dbId, { op: "updateProperty", id: def.id, type: pending, ...cfg }), onDone())} />
      </div>
    );
  }
  return (
    <div className="prop-editor">
      <input
        className="input"
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (void dbOp(dbId, { op: "updateProperty", id: def.id, name }), onDone())}
        onBlur={() => name !== def.name && void dbOp(dbId, { op: "updateProperty", id: def.id, name })}
      />
      {CONFIGURED_TYPES.has(def.type) && (
        <PropertyConfigEditor dbId={dbId} props={props} type={def.type} def={def} onSubmit={(cfg) => (void dbOp(dbId, { op: "updateProperty", id: def.id, ...cfg }), onDone())} />
      )}
      {def.type !== "title" && (
        <>
          <div className="menu-label">Type</div>
          {PROPERTY_TYPES.filter((t) => t !== "relation" || def.type === "relation").map((t) => (
            <button
              key={t}
              className={`menu-item compact ${t === def.type ? "active" : ""}`}
              onClick={() => (CONFIGURED_TYPES.has(t) && t !== def.type ? setPending(t) : (void dbOp(dbId, { op: "updateProperty", id: def.id, type: t }), onDone()))}
            >
              <span className="menu-icon small">{TYPE_ICON[t]}</span> <span className="menu-title">{TYPE_LABEL[t]}</span>
            </button>
          ))}
          <div className="menu-sep" />
          <button className="menu-item compact danger" onClick={() => (void dbOp(dbId, { op: "deleteProperty", id: def.id }), onDone())}>
            <Icon name="trash" size={14} /> <span className="menu-title">Delete property</span>
          </button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- cells

export function Cell({ row, def, readOnly }: { row: Block; def: PropertyDef; readOnly: boolean }) {
  const value = def.id === "title" ? row.properties.title : row.properties.values?.[def.id];
  const [pop, setPop] = useState<HTMLElement | null>(null);
  const members = useWorkspace((s) => s.members);
  const db = useBlock(row.parent_id);
  if (COMPUTED_TYPES.has(def.type)) return db ? <ComputedCell row={row} def={def} db={db.properties as DatabaseProperties} /> : null;
  switch (def.type) {
    case "relation":
      return <RelationCell row={row} def={def} readOnly={readOnly} />;
    case "title":
      return (
        <div className="title-cell">
          <span className="row-icon">{row.properties.icon || "📄"}</span>
          <span data-row-title={row.id} className="title-cell-input-wrap">
            <TitleInput value={value ?? ""} readOnly={readOnly} onCommit={(v) => setCell(row, "title", v)} className="cell-input title-input" testId="row-title" />
          </span>
          <button className="open-btn" onClick={() => navigate(row.id)} data-testid="row-open">
            <Icon name="arrowUpRight" size={12} /> Open
          </button>
        </div>
      );
    case "text":
      return <TitleInput value={value ?? ""} readOnly={readOnly} placeholder="" onCommit={(v) => setCell(row, def.id, v)} className="cell-input" />;
    case "number":
      return <TitleInput value={value === null || value === undefined ? "" : String(value)} readOnly={readOnly} placeholder="" onCommit={(v) => setCell(row, def.id, v)} className="cell-input num" />;
    case "date":
      return <input type="date" className="cell-input" disabled={readOnly} value={value ?? ""} onChange={(e) => void setCell(row, def.id, e.target.value || null)} />;
    case "checkbox":
      return <input type="checkbox" className="cell-check" disabled={readOnly} checked={Boolean(value)} onChange={(e) => void setCell(row, def.id, e.target.checked)} />;
    case "select":
    case "multi_select": {
      const ids: string[] = def.type === "select" ? (value ? [value] : []) : (value ?? []);
      return (
        <>
          <button className="cell-tags" disabled={readOnly} onClick={(e) => setPop(e.currentTarget)} data-testid={`cell-${def.id}`}>
            {ids.map((oid) => {
              const o = def.options?.find((x) => x.id === oid);
              return o ? (
                <span key={oid} className={`tag tag-${o.color}`}>
                  {o.name}
                </span>
              ) : null;
            })}
          </button>
          {pop && (
            <Popover anchor={pop} onClose={() => setPop(null)} className="db-pop" testId="select-pop">
              <SelectEditor row={row} def={def} ids={ids} onDone={() => setPop(null)} />
            </Popover>
          )}
        </>
      );
    }
    case "person": {
      const m = members.find((u) => u.id === value);
      return (
        <>
          <button className="cell-tags" disabled={readOnly} onClick={(e) => setPop(e.currentTarget)}>
            {m && (
              <span className="person">
                <Avatar name={m.name} color={m.color} size="xs" /> {m.name}
              </span>
            )}
          </button>
          {pop && (
            <Popover anchor={pop} onClose={() => setPop(null)} className="menu">
              {members.map((u: User) => (
                <button key={u.id} className={`menu-item compact ${u.id === value ? "active" : ""}`} onClick={() => (void setCell(row, def.id, u.id), setPop(null))}>
                  <Avatar name={u.name} color={u.color} size="xs" /> <span className="menu-title">{u.name}</span>
                </button>
              ))}
              <button className="menu-item compact" onClick={() => (void setCell(row, def.id, null), setPop(null))}>
                <span className="menu-title muted">Clear</span>
              </button>
            </Popover>
          )}
        </>
      );
    }
  }
}

function SelectEditor({ row, def, ids, onDone }: { row: Block; def: PropertyDef; ids: string[]; onDone: () => void }) {
  const [q, setQ] = useState("");
  const options = (def.options ?? []).filter((o) => o.name.toLowerCase().includes(q.toLowerCase()));
  const exact = def.options?.some((o) => o.name.toLowerCase() === q.trim().toLowerCase());
  const multi = def.type === "multi_select";
  const choose = (oid: string) => {
    if (multi) void setCell(row, def.id, ids.includes(oid) ? ids.filter((x) => x !== oid) : [...ids, oid]);
    else {
      void setCell(row, def.id, ids[0] === oid ? null : oid);
      onDone();
    }
  };
  const create = async () => {
    const name = q.trim();
    if (!name) return;
    const option = { id: crypto.randomUUID().slice(0, 8), name, color: randomOptionColor(name) };
    const dbId = row.parent_id!;
    await dbOp(dbId, { op: "addOption", propertyId: def.id, option });
    const fresh = getState().blocks[row.id] ?? row;
    choose(option.id);
    void fresh;
    setQ("");
  };
  return (
    <div className="select-editor">
      <input
        className="input"
        autoFocus
        placeholder="Search or create an option"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            if (options[0] && (exact || !q.trim())) choose(options[0].id);
            else void create();
          }
        }}
      />
      {options.map((o) => (
        <button key={o.id} className={`menu-item compact ${ids.includes(o.id) ? "active" : ""}`} onClick={() => choose(o.id)}>
          <span className={`tag tag-${o.color}`}>{o.name}</span>
          {ids.includes(o.id) && <span className="check">✓</span>}
        </button>
      ))}
      {q.trim() && !exact && (
        <button className="menu-item compact" onClick={() => void create()}>
          <span className="menu-title">Create</span> <span className={`tag tag-${randomOptionColor(q.trim())}`}>{q.trim()}</span>
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- board

function BoardView({ db, props, view, rows, readOnly, onGroupBy }: { db: Block; props: DatabaseProperties; view: View; rows: Block[]; readOnly: boolean; onGroupBy: (id: string) => void }) {
  const groupBy = view.groupBy && props.schema[view.groupBy]?.type === "select" ? view.groupBy : props.order.find((p) => props.schema[p]?.type === "select");
  const effective = { ...view, groupBy };
  const groups = groupRows(props, effective, rows as unknown as RowLike[]) as unknown as Array<{ id: string; name: string; color: string; rows: Block[] }>;
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const selectProps = props.order.map((p) => props.schema[p]!).filter((d) => d?.type === "select");
  const shown = props.order.map((p) => props.schema[p]!).filter((d) => d && d.id !== "title" && d.id !== groupBy);

  if (!groupBy) return <div className="db-empty">Add a Select property to group this board by.</div>;

  const drop = async (groupId: string, beforeId: string | null) => {
    const rowId = dragging;
    setDragging(null);
    setOver(null);
    if (!rowId) return;
    const row = getState().blocks[rowId];
    if (!row) return;
    const value = groupId === "__none" ? null : groupId;
    if ((row.properties.values?.[groupBy] ?? null) !== value) await setCell(row, groupBy, value);
    if (beforeId !== rowId) await dbOp(db.id, { op: "moveRow", rowId, beforeId });
  };

  return (
    <div className="board-wrap">
      <div className="board-bar">
        Group by{" "}
        <select value={groupBy} disabled={readOnly} onChange={(e) => onGroupBy(e.target.value)}>
          {selectProps.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      <div className="board" data-testid="db-board">
        {groups.map((g) => (
          <div
            key={g.id}
            className={`board-col ${over === g.id ? "over" : ""}`}
            data-testid={`board-col-${g.name}`}
            onDragOver={(e) => {
              if (!dragging) return;
              e.preventDefault();
              setOver(g.id);
            }}
            onDragLeave={() => setOver((o) => (o === g.id ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              void drop(g.id, null);
            }}
          >
            <div className="board-col-head">
              <span className={`tag tag-${g.color}`}>{g.name}</span>
              <span className="count">{g.rows.length}</span>
            </div>
            {g.rows.map((r) => (
              <div
                key={r.id}
                className={`card ${dragging === r.id ? "dragging" : ""}`}
                draggable={!readOnly}
                data-testid="board-card"
                onDragStart={(e) => {
                  setDragging(r.id);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", r.id);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void drop(g.id, r.id);
                }}
                onClick={() => navigate(r.id)}
              >
                <div className="card-title">
                  {r.properties.icon && <span>{r.properties.icon} </span>}
                  {pageTitle(r)}
                </div>
                <div className="card-props">
                  {shown.map((d) => (
                    <CardProp key={d.id} row={r} def={d} db={props} />
                  ))}
                </div>
              </div>
            ))}
            {!readOnly && (
              <button className="board-new" onClick={() => void newRow(db.id, g.id === "__none" ? {} : { [groupBy]: g.id })}>
                <Icon name="plus" size={13} /> New
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- filter & sort editors

function FilterEditor({ props, view, readOnly, onChange }: { props: DatabaseProperties; view: View; readOnly: boolean; onChange: (f: ViewFilter[]) => void }) {
  const [filters, setFilters] = useState<ViewFilter[]>(view.filters);
  useEffect(() => setFilters(view.filters), [view.filters]);
  const members = useWorkspace((s) => s.members);
  const commit = (next: ViewFilter[]) => {
    setFilters(next);
    onChange(next);
  };
  const cols = props.order.map((p) => props.schema[p]!).filter(Boolean);
  return (
    <div className="rule-editor">
      {!filters.length && <div className="muted small">No filters applied to this view.</div>}
      {filters.map((f, i) => {
        const def = props.schema[f.property];
        if (!def) return null;
        const needsValue = f.operator !== "is_empty" && f.operator !== "is_not_empty";
        const set = (patch: Partial<ViewFilter>) => commit(filters.map((x, j) => (j === i ? { ...x, ...patch } : x)));
        return (
          <div key={i} className="rule" data-testid="filter-rule">
            <select value={f.property} disabled={readOnly} onChange={(e) => set({ property: e.target.value, operator: OPERATORS[props.schema[e.target.value]!.type][0]!, value: undefined })}>
              {cols.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select value={f.operator} disabled={readOnly} onChange={(e) => set({ operator: e.target.value as FilterOperator })}>
              {OPERATORS[def.type].map((o) => (
                <option key={o} value={o}>
                  {OP_LABEL[o]}
                </option>
              ))}
            </select>
            {needsValue &&
              (def.type === "select" || def.type === "multi_select" ? (
                <select value={f.value ?? ""} disabled={readOnly} onChange={(e) => set({ value: e.target.value || undefined })}>
                  <option value="">Select…</option>
                  {def.options?.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              ) : def.type === "relation" ? (
                <RelationFilterValue def={def} value={f.value} readOnly={readOnly} onChange={(value) => set({ value })} />
              ) : def.type === "person" ? (
                <select value={f.value ?? ""} disabled={readOnly} onChange={(e) => set({ value: e.target.value || undefined })}>
                  <option value="">Select…</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              ) : def.type === "checkbox" ? (
                <select value={String(f.value ?? "true")} disabled={readOnly} onChange={(e) => set({ value: e.target.value === "true" })}>
                  <option value="true">Checked</option>
                  <option value="false">Unchecked</option>
                </select>
              ) : (
                <input
                  className="input"
                  type={def.type === "number" ? "number" : def.type === "date" || def.type.endsWith("_time") ? "date" : "text"}
                  defaultValue={f.value ?? ""}
                  disabled={readOnly}
                  placeholder="Value"
                  data-testid="filter-value"
                  onBlur={(e) => set({ value: def.type === "number" ? (e.target.value === "" ? undefined : Number(e.target.value)) : e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                />
              ))}
            {!readOnly && (
              <button className="icon-btn" onClick={() => commit(filters.filter((_, j) => j !== i))} title="Remove filter">
                <Icon name="x" size={12} />
              </button>
            )}
          </div>
        );
      })}
      {!readOnly && (
        <button className="link-btn" data-testid="add-filter" onClick={() => commit([...filters, { property: "title", operator: "contains", value: "" }])}>
          + Add filter
        </button>
      )}
    </div>
  );
}

function RelationFilterValue({ def, value, readOnly, onChange }: { def: PropertyDef; value: any; readOnly: boolean; onChange: (v: string | undefined) => void }) {
  const rows = useWorkspace((s) => databaseRows(s, def.relation?.databaseId ?? ""));
  return (
    <select value={value ?? ""} disabled={readOnly} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">Select…</option>
      {rows.map((r) => (
        <option key={r.id} value={r.id}>
          {pageTitle(r)}
        </option>
      ))}
    </select>
  );
}

function SortEditor({ props, view, readOnly, onChange }: { props: DatabaseProperties; view: View; readOnly: boolean; onChange: (s: View["sorts"]) => void }) {
  const cols = props.order.map((p) => props.schema[p]!).filter(Boolean);
  const sorts = view.sorts;
  return (
    <div className="rule-editor">
      {!sorts.length && <div className="muted small">No sorts applied to this view.</div>}
      {sorts.map((s, i) => (
        <div key={i} className="rule" data-testid="sort-rule">
          <select value={s.property} disabled={readOnly} onChange={(e) => onChange(sorts.map((x, j) => (j === i ? { ...x, property: e.target.value } : x)))}>
            {cols.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select value={s.direction} disabled={readOnly} onChange={(e) => onChange(sorts.map((x, j) => (j === i ? { ...x, direction: e.target.value as "ascending" } : x)))}>
            <option value="ascending">Ascending</option>
            <option value="descending">Descending</option>
          </select>
          {!readOnly && (
            <button className="icon-btn" onClick={() => onChange(sorts.filter((_, j) => j !== i))} title="Remove sort">
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
      ))}
      {!readOnly && (
        <button className="link-btn" data-testid="add-sort" onClick={() => onChange([...sorts, { property: cols.find((c) => c.type === "number")?.id ?? "title", direction: "ascending" }])}>
          + Add sort
        </button>
      )}
    </div>
  );
}

/** Properties panel shown at the top of a row page. */
export function RowProperties({ row, readOnly }: { row: Block; readOnly: boolean }) {
  const db = useBlock(row.parent_id);
  if (!db) return null;
  const props = db.properties as DatabaseProperties;
  const cols = props.order.map((p) => props.schema[p]!).filter((d) => d && d.type !== "title");
  return (
    <div className="row-props" data-testid="row-props">
      {cols.map((d) => (
        <div key={d.id} className="row-prop">
          <div className="row-prop-name">
            <span className="th-icon">{TYPE_ICON[d.type]}</span> {d.name}
          </div>
          <div className={`row-prop-value cell-${d.type}`}>
            <Cell row={row} def={d} readOnly={readOnly} />
          </div>
        </div>
      ))}
    </div>
  );
}
