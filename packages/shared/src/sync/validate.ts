/**
 * Shape checks for operations arriving from clients, before the server looks at them. The
 * engine trusts its input (it's the same code on both sides); the network doesn't get to.
 * Returns an error message, or null when the op is well formed.
 */
import { CONTENT_BLOCK_TYPES, type BlockType } from "../types.js";
import type { RecordOp } from "./records.js";
import type { TextOp } from "./text.js";

const BLOCK_TYPES = new Set<BlockType>([...CONTENT_BLOCK_TYPES, "page", "database"]);
const MARKS = new Set(["bold", "italic", "underline", "strike", "code", "link", "color"]);
const LIMITS = { id: 128, units: 100_000, targets: 100_000, textOps: 10_000, props: 64 * 1024, slices: 1_000, string: 4_096 };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= LIMITS.id;
const isOptId = (v: unknown) => v === null || isId(v);
/** Op ids are `session@clock`. */
const isStamp = (v: unknown) => isId(v) && /^[^@]{1,64}@\d{1,15}$/.test(v as string);

function sliceError(v: unknown): string | null {
  if (v === null) return null;
  if (!Array.isArray(v) || v.length > LIMITS.slices) return "bad text slices";
  for (const s of v) if (!isObj(s) || !isId(s.i) || !isOptId(s.from) || !isOptId(s.to)) return "bad text slice";
  return null;
}

function propsError(v: unknown): string | null {
  if (!isObj(v)) return "properties must be an object";
  if (JSON.stringify(v).length > LIMITS.props) return "properties too large";
  return null;
}

function anchorOk(a: unknown) {
  return a === null || (isObj(a) && isStamp(a.item) && (a.side === "before" || a.side === "after"));
}

function textOpError(op: unknown): string | null {
  if (!isObj(op) || !isStamp(op.id)) return "bad text op";
  switch (op.t) {
    case "ins": {
      if (!(op.parent === null || isStamp(op.parent)) || (op.side !== "L" && op.side !== "R")) return "bad insert";
      if (op.gc !== undefined) return "clients can't send collected runs";
      if (!Array.isArray(op.value) || op.value.length === 0 || op.value.length > LIMITS.units) return "bad insert value";
      for (const u of op.value) {
        if (typeof u === "string") {
          if (u.length !== 1) return "insert units are single characters";
        } else if (!isObj(u) || !isObj(u.mention) || (u.mention.type !== "page" && u.mention.type !== "user") || !isId(u.mention.id) || typeof u.mention.label !== "string" || u.mention.label.length > LIMITS.string) {
          return "bad inline atom";
        }
      }
      return null;
    }
    case "vis":
      if (typeof op.visible !== "boolean" || !Array.isArray(op.targets) || op.targets.length === 0 || op.targets.length > LIMITS.targets) return "bad visibility op";
      return op.targets.every(isStamp) ? null : "bad visibility target";
    case "mark":
      if (typeof op.mark !== "string" || !MARKS.has(op.mark)) return "unknown mark";
      if (!(op.value === null || op.value === true || (typeof op.value === "string" && op.value.length <= LIMITS.string))) return "bad mark value";
      return anchorOk(op.start) && anchorOk(op.end) ? null : "bad mark anchor";
    default:
      return "unknown text op";
  }
}

export function validateOp(op: unknown): string | null {
  if (!isObj(op)) return "op must be an object";
  switch (op.op) {
    case "create":
      if (!isId(op.id) || !isId(op.parent) || !isOptId(op.after)) return "bad create";
      if (!BLOCK_TYPES.has(op.type as BlockType)) return "unknown block type";
      return propsError(op.properties) ?? sliceError(op.text ?? null);
    case "update":
      if (!isId(op.id)) return "bad update";
      if (op.type !== undefined && !BLOCK_TYPES.has(op.type as BlockType)) return "unknown block type";
      if (op.properties !== undefined) {
        const e = propsError(op.properties);
        if (e) return e;
      }
      return op.text === undefined ? null : sliceError(op.text);
    case "move":
    case "restore":
      return isId(op.id) && isId(op.parent) && isOptId(op.after) ? null : `bad ${op.op}`;
    case "delete":
      return isId(op.id) ? null : "bad delete";
    case "text": {
      if (!isId(op.instance) || !Array.isArray(op.ops) || op.ops.length === 0 || op.ops.length > LIMITS.textOps) return "bad text";
      for (const t of op.ops as TextOp[]) {
        const e = textOpError(t);
        if (e) return e;
      }
      return null;
    }
    case "split":
      if (!isId(op.id) || !(op.at === null || isStamp(op.at)) || !isId(op.newId)) return "bad split";
      if (op.newInstance !== op.newId) return "a split's new instance is named after its new block";
      if (!BLOCK_TYPES.has(op.type as BlockType) || op.type === "page" || op.type === "database") return "bad split type";
      return propsError(op.properties);
    case "merge":
      return isId(op.into) && isId(op.from) && op.into !== op.from ? null : "bad merge";
    default:
      return "unknown op";
  }
}

/** Every op of a transaction, or the first problem. */
export function validateTransaction(tx: unknown): string | null {
  if (!isObj(tx) || !isId(tx.id) || !Array.isArray(tx.ops)) return "bad transaction";
  if (tx.ops.length > 5_000) return "transaction too large";
  for (const op of tx.ops as RecordOp[]) {
    const e = validateOp(op);
    if (e) return e;
  }
  return null;
}
