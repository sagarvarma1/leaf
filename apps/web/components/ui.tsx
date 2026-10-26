"use client";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** A floating panel anchored to an element or a point. Closes on outside click / Escape. */
export function Popover({
  anchor,
  onClose,
  children,
  placement = "bottom-start",
  className = "",
  testId,
}: {
  anchor: HTMLElement | DOMRect | null;
  onClose: () => void;
  children: ReactNode;
  placement?: "bottom-start" | "bottom-end" | "right-start";
  className?: string;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const r = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor;
    const el = ref.current.getBoundingClientRect();
    let left = placement === "bottom-end" ? r.right - el.width : placement === "right-start" ? r.right + 4 : r.left;
    let top = placement === "right-start" ? r.top : r.bottom + 4;
    left = Math.max(8, Math.min(left, window.innerWidth - el.width - 8));
    if (top + el.height > window.innerHeight - 8) top = Math.max(8, (placement === "right-start" ? r.bottom : r.top) - el.height - 4);
    setPos({ left, top });
  }, [anchor, placement]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as globalThis.Node;
      if (ref.current?.contains(t)) return;
      if (anchor instanceof HTMLElement && anchor.contains(t)) return;
      // Clicks inside nested popovers (portaled) shouldn't close the parent.
      if ((t as HTMLElement).closest?.(".popover")) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const id = setTimeout(() => document.addEventListener("mousedown", down), 0);
    document.addEventListener("keydown", key);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [anchor, onClose]);
  if (!anchor) return null;
  return createPortal(
    <div
      ref={ref}
      className={`popover ${className}`}
      data-testid={testId}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

export function Modal({ onClose, children, className = "", testId }: { onClose: () => void; children: ReactNode; className?: string; testId?: string }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`modal ${className}`} data-testid={testId} onMouseDown={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Avatar({ name, color, size = "sm", title }: { name: string; color: string; size?: "xs" | "sm" | "md"; title?: string }) {
  return (
    <span className={`avatar ${size}`} style={{ background: color }} title={title ?? name}>
      {name === "Leaf AI" ? "✦" : (name || "?").trim()[0]?.toUpperCase()}
    </span>
  );
}

const ICONS: Record<string, string> = {
  search: "M11 11l3.5 3.5M12.5 7a5.5 5.5 0 11-11 0 5.5 5.5 0 0111 0z",
  plus: "M8 3v10M3 8h10",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5",
  star: "M8 2l1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3 4.3 13.3l.8-4.1L2 6.3l4.2-.5z",
  chevron: "M6 4l4 4-4 4",
  dots: "M3.5 8h.01M8 8h.01M12.5 8h.01",
  grip: "M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01",
  comment: "M3 3.5h10v7H7l-3 2.5v-2.5H3z",
  clock: "M8 4.5V8l2.5 1.5M14 8A6 6 0 112 8a6 6 0 0112 0z",
  share: "M10 3h3v3M13 3L8 8M11 9v4H3V5h4",
  settings: "M8 10a2 2 0 100-4 2 2 0 000 4zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4",
  moon: "M13 9.5A5.5 5.5 0 016.5 3 5.5 5.5 0 1013 9.5z",
  sun: "M8 11a3 3 0 100-6 3 3 0 000 6zM8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1",
  page: "M4 2h5l3 3v9H4zM9 2v3h3",
  table: "M2 3h12v10H2zM2 6.5h12M2 10h12M6 3v10",
  board: "M2 3h3.5v10H2zM6.3 3h3.5v6H6.3zM10.5 3H14v8h-3.5z",
  calendar: "M2.5 3.5h11v10h-11zM2.5 6.5h11M5.5 2v3M10.5 2v3",
  gallery: "M2 2.5h5v5H2zM9 2.5h5v5H9zM2 9.5h5v4H2zM9 9.5h5v4H9z",
  sparkle: "M8 1.5l1.4 4.1 4.1 1.4-4.1 1.4L8 12.5 6.6 8.4 2.5 7l4.1-1.4zM13 11l.6 1.4 1.4.6-1.4.6L13 15l-.6-1.4L11 13l1.4-.6z",
  filter: "M2 3.5h12M4.5 8h7M7 12.5h2",
  sort: "M5 3v10M2.5 10.5L5 13l2.5-2.5M11 13V3M8.5 5.5L11 3l2.5 2.5",
  download: "M8 2v8M5 7l3 3 3-3M3 13h10",
  link: "M7 9a3 3 0 004.2 0l2-2a3 3 0 00-4.2-4.2l-.6.6M9 7a3 3 0 00-4.2 0l-2 2a3 3 0 004.2 4.2l.6-.6",
  arrowUpRight: "M5 11l6-6M6 5h5v5",
  x: "M4 4l8 8M12 4l-8 8",
  undo: "M5 6H10a3 3 0 010 6H7M5 6l2.5-2.5M5 6l2.5 2.5",
  menu: "M2.5 4h11M2.5 8h11M2.5 12h11",
  doubleLeft: "M8 4L4 8l4 4M12 4L8 8l4 4",
  logout: "M10 3h3v10h-3M7 5L4 8l3 3M4 8h7",
};

export function Icon({ name, size = 16, className = "" }: { name: keyof typeof ICONS | string; size?: number; className?: string }) {
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={ICONS[name] ?? ICONS.page} />
    </svg>
  );
}

export function timeAgo(t: number): string {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const EMOJIS = "📄 📝 📚 🚀 🌿 👋 🧪 🗓️ 🏗️ 🎒 💡 ✅ 📌 🔥 ⭐ 🎯 📊 📈 🧠 💬 🛠️ ⚙️ 🎨 🎵 🍀 🌈 ☀️ 🌙 🏠 💼 ✈️ 🍕 ☕ 🐛 🔒 🔑 📦 🧩 🗂️ 📎 🖊️ 🏁 🎉 ❤️ 👀 🤝 💰 🌍 🧭 🪴".split(" ");

export function EmojiPicker({ anchor, onPick, onClose }: { anchor: HTMLElement | null; onPick: (e: string | null) => void; onClose: () => void }) {
  return (
    <Popover anchor={anchor} onClose={onClose} className="emoji-picker" testId="emoji-picker">
      <div className="emoji-head">
        <span>Icon</span>
        <button className="link-btn" onClick={() => onPick(EMOJIS[Math.floor(Math.random() * EMOJIS.length)]!)}>
          Random
        </button>
        <button className="link-btn" onClick={() => onPick(null)}>
          Remove
        </button>
      </div>
      <div className="emoji-grid">
        {EMOJIS.map((e) => (
          <button key={e} onClick={() => onPick(e)}>
            {e}
          </button>
        ))}
      </div>
    </Popover>
  );
}

export const COLORS: Array<{ name: string; text: string; label: string }> = [
  { name: "default", text: "", label: "Default" },
  { name: "gray", text: "#787774", label: "Gray" },
  { name: "brown", text: "#9f6b53", label: "Brown" },
  { name: "orange", text: "#d9730d", label: "Orange" },
  { name: "yellow", text: "#cb912f", label: "Yellow" },
  { name: "green", text: "#448361", label: "Green" },
  { name: "blue", text: "#337ea9", label: "Blue" },
  { name: "purple", text: "#9065b0", label: "Purple" },
  { name: "pink", text: "#c14c8a", label: "Pink" },
  { name: "red", text: "#d44c47", label: "Red" },
];
