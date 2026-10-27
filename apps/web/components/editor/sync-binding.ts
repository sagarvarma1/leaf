"use client";
/**
 * Binds a ProseMirror editor to the sync client (replaces y-prosemirror).
 *
 *  - Local edits: after every transaction that changes the document, the editor's doc is
 *    read as the desired block tree (sync/pm.ts fromPM) and committed; the commit turns
 *    the difference into operations (text CRDT ops, splits, merges, moves...).
 *  - Remote changes (and undo): the records are rendered back into an editor doc (toPM)
 *    and swapped in when different. The caret is kept by anchoring it to the character
 *    before it (a text item id), so text inserted elsewhere doesn't move it.
 *  - Presence: the local caret is published as { block, item }; other people's carets are
 *    drawn from theirs the same way.
 *  - Undo / redo: Mod-Z / Mod-Shift-Z undo this user's own edits only.
 */
import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { fromPM, readText, toPM, type Block } from "@leaf/shared";
import type { Presence, SyncClient } from "@/lib/sync";

/** Meta on transactions that come from the records (not the user). */
export const remoteKey = new PluginKey("leafRemote");
const syncKey = new PluginKey<"local" | "remote">("leafSync");
const cursorsKey = new PluginKey<DecorationSet>("leafCursors");

export interface SyncBindingOptions {
  sync: SyncClient;
  rootId: string;
  title: boolean;
  readOnly: () => boolean;
}

interface Anchor {
  block: string;
  item: string | null;
}

/** Render the records as an editor document. */
export function renderDoc(sync: SyncClient, rootId: string, title: boolean) {
  return toPM(sync.view, rootId, { title });
}

export function LeafSync(opts: SyncBindingOptions) {
  const { sync, rootId, title } = opts;
  /** Item ids of each block's text as currently shown in the editor. */
  const shown = new Map<string, string[]>();
  const token = {};

  const blockOfNode = (node: PMNode): string | null => {
    if (node.type.name === "title") return rootId;
    const id = node.attrs.blockId as string | null;
    if (!id || id.endsWith(":empty")) return null;
    return id.endsWith(":p") ? id.slice(0, -2) : id;
  };

  const remember = (doc: PMNode) => {
    shown.clear();
    doc.descendants((node) => {
      if (!node.isTextblock) return true;
      const id = blockOfNode(node);
      const b = id ? sync.view.getBlock(id) : undefined;
      if (id && b?.text) shown.set(id, readText(sync.view, b).ids);
      return false;
    });
  };

  const anchorAt = (doc: PMNode, pos: number): Anchor | null => {
    const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
    if (!$pos.parent.isTextblock) return null;
    const block = blockOfNode($pos.parent);
    if (!block) return null;
    const ids = shown.get(block) ?? [];
    const off = $pos.parentOffset;
    return { block, item: off > 0 ? (ids[off - 1] ?? ids[ids.length - 1] ?? null) : null };
  };

  /** Editor position for an anchor in `doc`, using the current records. */
  const posOf = (doc: PMNode, a: Anchor): number | null => {
    let found: number | null = null;
    doc.descendants((node, pos) => {
      if (found !== null) return false;
      if (!node.isTextblock) return true;
      if (blockOfNode(node) !== a.block) return false;
      const b = sync.view.getBlock(a.block);
      let off = 0;
      if (a.item && b?.text) off = offsetAfter(sync, b, a.item);
      found = pos + 1 + Math.min(off, node.content.size);
      return false;
    });
    return found;
  };

  const commit = (view: EditorView) => {
    if (opts.readOnly()) return;
    const desired = fromPM(view.state.doc.toJSON() as any, rootId, {
      isChildPage: (id) => {
        const b = sync.view.getBlock(id);
        return b?.type === "page" && b.parent_id === rootId;
      },
    });
    sync.commitDesired(rootId, desired, token);
    remember(view.state.doc);
  };

  const render = (view: EditorView) => {
    const json = renderDoc(sync, rootId, title);
    let next: PMNode;
    try {
      next = view.state.schema.nodeFromJSON(json);
      next.check();
    } catch (e) {
      console.error("[leaf] can't render records", e);
      return;
    }
    if (next.eq(view.state.doc)) {
      remember(view.state.doc);
      return;
    }
    const { from, to, empty } = view.state.selection;
    const a = anchorAt(view.state.doc, from);
    const h = empty ? a : anchorAt(view.state.doc, to);
    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, next.content).setMeta(remoteKey, true).setMeta("addToHistory", false);
    const pa = a && posOf(tr.doc, a);
    const ph = h && posOf(tr.doc, h);
    try {
      if (pa !== null && pa !== undefined) tr.setSelection(TextSelection.create(tr.doc, pa, ph ?? pa));
      else tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(from, tr.doc.content.size))));
    } catch {
      /* keep PM's mapped selection */
    }
    view.dispatch(tr);
    remember(view.state.doc);
  };

  let lastSent = "";
  let presenceTimer: ReturnType<typeof setTimeout> | null = null;
  const publishPresence = (view: EditorView) => {
    if (presenceTimer) return;
    presenceTimer = setTimeout(() => {
      presenceTimer = null;
      if (view.isDestroyed) return;
      const { from, to, empty } = view.state.selection;
      const a = view.hasFocus() ? anchorAt(view.state.doc, from) : null;
      const h = a && !empty ? anchorAt(view.state.doc, to) : null;
      const sel = a ? { ...a, ...(h ? { head: h } : {}) } : null;
      const key = JSON.stringify(sel);
      if (key === lastSent) return;
      lastSent = key;
      sync.setPresence(rootId, sel);
    }, 60);
  };

  const cursors = (doc: PMNode): DecorationSet => {
    const decos: Decoration[] = [];
    for (const p of sync.presenceOf(rootId)) {
      if (!p.sel || !p.user || p.session === sync.session) continue;
      const pos = posOf(doc, p.sel);
      if (pos === null) continue;
      const head = p.sel.head ? posOf(doc, p.sel.head) : null;
      if (head !== null && head !== pos) {
        const [lo, hi] = pos < head ? [pos, head] : [head, pos];
        decos.push(Decoration.inline(lo, hi, { class: "collab-selection", style: `background-color: ${p.user.color}33` }));
      }
      decos.push(Decoration.widget(pos, () => caret(p), { key: `${p.session}:${p.user.name}:${p.user.color}`, side: 10 }));
    }
    return DecorationSet.create(doc, decos);
  };

  return Extension.create({
    name: "leafSync",
    addKeyboardShortcuts() {
      return {
        "Mod-z": () => {
          sync.undo(rootId);
          return true;
        },
        "Mod-Shift-z": () => {
          sync.redo(rootId);
          return true;
        },
        "Mod-y": () => {
          sync.redo(rootId);
          return true;
        },
      };
    },
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: syncKey,
          state: {
            init: () => "remote" as const,
            apply: (tr: Transaction, value: "local" | "remote") => (tr.docChanged ? (tr.getMeta(remoteKey) ? "remote" : "local") : value),
          },
          view(view) {
            remember(view.state.doc);
            // Announce ourselves on the page right away (no caret until focused).
            sync.setPresence(rootId, null);
            const off = sync.onChange((origin) => {
              if (origin !== token && !view.isDestroyed) render(view);
            });
            return {
              update(v: EditorView, prev: EditorState) {
                if (!v.state.doc.eq(prev.doc) && syncKey.getState(v.state) === "local") commit(v);
                if (!v.state.selection.eq(prev.selection) || !v.state.doc.eq(prev.doc)) publishPresence(v);
              },
              destroy() {
                off();
                sync.leavePresence(rootId);
              },
            };
          },
          props: {
            handleDOMEvents: {
              focus: (view) => (publishPresence(view), false),
              blur: (view) => (publishPresence(view), false),
            },
          },
        }),
        new Plugin({
          key: cursorsKey,
          state: {
            init: (_, state) => cursors(state.doc),
            apply: (tr, old) => (tr.getMeta(cursorsKey) || tr.docChanged ? cursors(tr.doc) : old),
          },
          view(view) {
            const off = sync.onPresence(() => !view.isDestroyed && view.dispatch(view.state.tr.setMeta(cursorsKey, true)));
            return { destroy: () => void off() };
          },
          props: { decorations: (state) => cursorsKey.getState(state) },
        }),
      ];
    },
  });
}

/** Visible offset just after `item` in a block's text, even if the item was deleted since. */
function offsetAfter(sync: SyncClient, block: Block, item: string): number {
  const t = readText(sync.view, block);
  const i = t.ids.indexOf(item);
  if (i >= 0) return i + 1;
  // Deleted: count the visible items before it in its slice.
  let n = 0;
  for (const s of block.text ?? []) {
    const inst = sync.view.instance(s.i);
    const [lo, hi] = inst.bounds(s.from, s.to);
    const order = inst.order();
    for (let k = lo; k < hi; k++) {
      if (order[k] === item) return n;
      if (inst.visible(order[k]!)) n++;
    }
  }
  return n;
}

function caret(p: Presence): HTMLElement {
  const el = document.createElement("span");
  el.className = "collaboration-cursor__caret";
  el.style.borderColor = p.user!.color;
  const label = document.createElement("div");
  label.className = "collaboration-cursor__label";
  label.style.backgroundColor = p.user!.color;
  label.textContent = p.user!.name;
  el.append(label);
  return el;
}
