"use client";
/** Calendar and gallery views, and the property line shared by board and gallery cards. */
import {
  COMPUTED_TYPES,
  computedCell,
  displayValue,
  isoDay,
  relatedRows,
  type Block,
  type DatabaseProperties,
  type DatabaseView as View,
  type PropertyDef,
} from "@leaf/shared";
import { useState } from "react";
import { getState, pageTitle, useWorkspace } from "@/lib/store";
import { Avatar, Icon } from "../ui";
import { navigate, newRow, setCell, useValueContext } from "./data";

/** One property on a board or gallery card; empty values render nothing. */
export function CardProp({ row, def, db }: { row: Block; def: PropertyDef; db: DatabaseProperties }) {
  const v = row.properties.values?.[def.id];
  const members = useWorkspace((s) => s.members);
  const ctx = useValueContext();
  if (COMPUTED_TYPES.has(def.type)) {
    const { value, error } = computedCell(row, def, db, ctx);
    const text = error ? "" : displayValue(def, value);
    return text ? <div className="card-prop muted">{def.type === "formula" || def.type === "rollup" ? `${def.name}: ${text}` : text}</div> : null;
  }
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length) || v === false) return null;
  if (def.type === "relation") {
    const linked = relatedRows(row, def, ctx);
    return linked.length ? (
      <div className="card-prop">
        {linked.map((r) => (
          <span key={r.id} className="relation-chip static">
            {r.properties.icon || "📄"} {r.properties.title || "Untitled"}
          </span>
        ))}
      </div>
    ) : null;
  }
  if (def.type === "select" || def.type === "multi_select") {
    const ids: string[] = Array.isArray(v) ? v : [v];
    return (
      <div className="card-prop">
        {ids.map((id) => {
          const o = def.options?.find((x) => x.id === id);
          return o ? (
            <span key={id} className={`tag tag-${o.color}`}>
              {o.name}
            </span>
          ) : null;
        })}
      </div>
    );
  }
  if (def.type === "person") {
    const m = members.find((u) => u.id === v);
    return m ? (
      <div className="card-prop person">
        <Avatar name={m.name} color={m.color} size="xs" /> {m.name}
      </div>
    ) : null;
  }
  if (def.type === "checkbox") return <div className="card-prop">☑ {def.name}</div>;
  if (def.type === "date") return <div className="card-prop muted">{new Date(v + "T00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</div>;
  return <div className="card-prop muted">{def.type === "number" ? `${def.name}: ${v}` : String(v)}</div>;
}

// ---------------------------------------------------------------- calendar

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function CalendarView({
  db,
  props,
  view,
  rows,
  readOnly,
  onChange,
}: {
  db: Block;
  props: DatabaseProperties;
  view: View;
  rows: Block[];
  readOnly: boolean;
  onChange: (patch: Partial<View>) => void;
}) {
  const dateProps = props.order.map((p) => props.schema[p]!).filter((d) => d?.type === "date");
  const dateProp = view.dateProperty && props.schema[view.dateProperty]?.type === "date" ? view.dateProperty : dateProps[0]?.id;
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  if (!dateProp) return <div className="db-empty">Add a Date property to see rows on a calendar.</div>;

  const start = new Date(month.getFullYear(), month.getMonth(), 1 - month.getDay());
  const days = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const byDay = new Map<string, Block[]>();
  let undated = 0;
  for (const r of rows) {
    const d = r.properties.values?.[dateProp];
    if (!d) {
      undated++;
      continue;
    }
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(r);
  }
  const today = isoDay(new Date());
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
  const drop = async (day: string) => {
    const id = dragging;
    setDragging(null);
    setOver(null);
    const row = id ? getState().blocks[id] : null;
    if (row && row.properties.values?.[dateProp] !== day) await setCell(row, dateProp, day);
  };

  return (
    <div className="calendar" data-testid="db-calendar">
      <div className="calendar-bar">
        <span className="calendar-month" data-testid="calendar-month">
          {month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
        </span>
        <span className="muted small">
          by{" "}
          <select value={dateProp} disabled={readOnly} onChange={(e) => onChange({ dateProperty: e.target.value })}>
            {dateProps.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </span>
        {undated > 0 && <span className="muted small">{undated} without a date</span>}
        <span className="calendar-nav">
          <button className="icon-btn" onClick={() => shift(-1)} title="Previous month" data-testid="calendar-prev">
            ‹
          </button>
          <button className="btn ghost small" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>
            Today
          </button>
          <button className="icon-btn" onClick={() => shift(1)} title="Next month" data-testid="calendar-next">
            ›
          </button>
        </span>
      </div>
      <div className="calendar-grid">
        {WEEKDAYS.map((w) => (
          <div key={w} className="calendar-weekday">
            {w}
          </div>
        ))}
        {days.map((d) => {
          const key = isoDay(d);
          const inMonth = d.getMonth() === month.getMonth();
          return (
            <div
              key={key}
              className={`calendar-day ${inMonth ? "" : "outside"} ${key === today ? "today" : ""} ${over === key ? "over" : ""}`}
              data-day={key}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                setOver(key);
              }}
              onDragLeave={() => setOver((o) => (o === key ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                void drop(key);
              }}
            >
              <div className="calendar-day-head">
                <span className="calendar-date">{d.getDate() === 1 ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : d.getDate()}</span>
                {!readOnly && (
                  <button className="calendar-add" title="New page on this day" onClick={() => void newRow(db.id, { [dateProp]: key }).then((r) => navigate(r.id))}>
                    <Icon name="plus" size={12} />
                  </button>
                )}
              </div>
              {(byDay.get(key) ?? []).map((r) => (
                <div
                  key={r.id}
                  className={`calendar-item ${dragging === r.id ? "dragging" : ""}`}
                  draggable={!readOnly}
                  data-testid="calendar-item"
                  onDragStart={(e) => {
                    setDragging(r.id);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", r.id);
                  }}
                  onDragEnd={() => (setDragging(null), setOver(null))}
                  onClick={() => navigate(r.id)}
                >
                  {r.properties.icon && <span>{r.properties.icon} </span>}
                  {pageTitle(r)}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- gallery

export function GalleryView({
  db,
  props,
  view,
  rows,
  readOnly,
  onChange,
}: {
  db: Block;
  props: DatabaseProperties;
  view: View;
  rows: Block[];
  readOnly: boolean;
  onChange: (patch: Partial<View>) => void;
}) {
  const preview = view.cardPreview ?? "cover";
  const shown = props.order.map((p) => props.schema[p]!).filter((d) => d && d.id !== "title");
  return (
    <div className="gallery-wrap">
      <div className="board-bar">
        Card preview{" "}
        <select value={preview} disabled={readOnly} onChange={(e) => onChange({ cardPreview: e.target.value as View["cardPreview"] })}>
          <option value="cover">Page cover</option>
          <option value="none">None</option>
        </select>
      </div>
      <div className="gallery" data-testid="db-gallery">
        {rows.map((r) => {
          const cover = r.properties.cover as string | null | undefined;
          return (
            <div key={r.id} className="gallery-card" data-testid="gallery-card" onClick={() => navigate(r.id)}>
              {preview === "cover" && (
                <div
                  className={`gallery-cover ${cover && !cover.startsWith("http") ? cover : ""}`}
                  style={cover?.startsWith("http") ? { backgroundImage: `url(${cover})` } : undefined}
                >
                  {!cover && <span className="gallery-icon">{r.properties.icon || "📄"}</span>}
                </div>
              )}
              <div className="gallery-body">
                <div className="card-title">
                  {r.properties.icon && preview === "none" && <span>{r.properties.icon} </span>}
                  {pageTitle(r)}
                </div>
                <div className="card-props">
                  {shown.map((d) => (
                    <CardProp key={d.id} row={r} def={d} db={props} />
                  ))}
                </div>
              </div>
            </div>
          );
        })}
        {!readOnly && (
          <button className="gallery-card gallery-new" onClick={() => void newRow(db.id)}>
            <Icon name="plus" size={14} /> New
          </button>
        )}
      </div>
    </div>
  );
}
